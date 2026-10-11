// Now Playing: report what THIS device is playing, obey remote commands for
// it, and show what OTHER devices on the account are playing (with remote
// controls and an Android lock-screen / quick-settings media card).
// Loaded after app.js, so it shares its globals (state, videoEl, closePlayer…).
(function () {
  'use strict';

  const SESSION_ID = 'web-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  const REPORT_MS = 4000;
  const POLL_MS = 5000;
  const IS_TV_APP = !!window.VyznNativePlayer; // the TV app's WebView is hidden behind its native player

  function deviceLabel() {
    const ua = navigator.userAgent || '';
    const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os ? `${br} on ${os}` : br;
  }

  // ---- 1. This device: report state + obey commands -----------------------
  let reportTimer = null;
  let cmdActive = false;
  let cmdAbort = null;

  function currentTitles() {
    const it = state.currentItem;
    if (!it) return {};
    const ep = it.episode_number != null || it.season_number != null;
    return {
      title: it.show_title || it.tmdb_matched_title || it.title || '',
      subtitle: ep ? `S${it.season_number || 0}:E${it.episode_number || 0}${it.title && it.show_title ? ' · ' + it.title : ''}` : '',
      poster_url: it.poster_url || it.still_url || '',
    };
  }

  function postState(stateName) {
    if (!state.profile) return Promise.resolve();
    const it = state.currentItem;
    const body = { session_id: SESSION_ID, kind: 'web', device_name: deviceLabel(), state: stateName };
    if (stateName !== 'stopped' && it) {
      Object.assign(body, currentTitles(), {
        media_id: it.id,
        remote_server_id: it._remote || 0,
        position_seconds: videoEl.currentTime || 0,
        duration_seconds: getKnownDuration(),
      });
    }
    return fetch(`/api/profiles/${state.profile.id}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
  }

  const playingState = () => (videoEl.paused ? 'paused' : 'playing');

  function applyCommand(c) {
    if (playerEl.classList.contains('hidden')) return;
    const dur = getKnownDuration() || videoEl.duration || Infinity;
    const clamp = (t) => Math.max(0, Math.min(t, dur - 1));
    switch (c.action) {
      case 'play': videoEl.play().catch(() => {}); break;
      case 'pause': videoEl.pause(); break;
      case 'toggle': if (videoEl.paused) videoEl.play().catch(() => {}); else videoEl.pause(); break;
      case 'seek_rel': videoEl.currentTime = clamp((videoEl.currentTime || 0) + (c.delta || 0)); break;
      case 'seek': videoEl.currentTime = clamp(c.position || 0); break;
      case 'stop': closePlayer(); break;
      default: break;
    }
    setTimeout(() => postState(playingState()), 150);
  }

  async function commandLoop() {
    let after = 0;
    let misses = 0;
    while (cmdActive) {
      try {
        cmdAbort = new AbortController();
        const res = await fetch(`/api/sessions/${SESSION_ID}/commands?after=${after}`, { signal: cmdAbort.signal });
        if (res.status === 404) { if (++misses > 3) break; await new Promise((r) => setTimeout(r, 1500)); continue; }
        if (!res.ok) { await new Promise((r) => setTimeout(r, 4000)); continue; }
        misses = 0;
        const data = await res.json();
        for (const c of data.commands || []) { after = Math.max(after, c.seq); applyCommand(c); }
        if (typeof data.seq === 'number') after = Math.max(after, data.seq);
      } catch (err) {
        if (!cmdActive) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  function start() {
    stop(false);
    postState('playing').then(() => {
      cmdActive = true;
      commandLoop();
    });
    reportTimer = setInterval(() => postState(playingState()), REPORT_MS);
  }
  function stop(notify = true) {
    clearInterval(reportTimer);
    reportTimer = null;
    cmdActive = false;
    if (cmdAbort) cmdAbort.abort();
    if (notify) postState('stopped');
  }
  videoEl.addEventListener('play', () => { if (reportTimer) postState('playing'); });
  videoEl.addEventListener('pause', () => { if (reportTimer) postState('paused'); });
  // Tab closed / navigated away mid-play: tell the server so the card clears.
  window.addEventListener('pagehide', () => {
    if (!reportTimer || !state.profile || !navigator.sendBeacon) return;
    navigator.sendBeacon(`/api/profiles/${state.profile.id}/sessions`,
      new Blob([JSON.stringify({ session_id: SESSION_ID, kind: 'web', state: 'stopped' })], { type: 'application/json' }));
  });

  // ---- 2. Other devices: Now Playing bar + media session -------------------
  const barEl = document.getElementById('nowPlaying');
  let remote = [];          // sessions on OTHER devices
  let receivedAt = 0;
  let serverSkew = 0;
  let keepAlive = null;
  let hadGesture = false;

  function silentWavUrl() {
    const rate = 8000, n = rate; // 1 second of silence
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // Chrome only shows the Android media card while something is "playing",
  // so a silent looping track holds it open while a remote session exists.
  function startKeepAlive() {
    if (keepAlive || !hadGesture) return;
    keepAlive = new Audio(silentWavUrl());
    keepAlive.loop = true;
    keepAlive.volume = 0.01;
    keepAlive.play().catch(() => { keepAlive = null; });
  }
  function stopKeepAlive() {
    if (!keepAlive) return;
    keepAlive.pause();
    keepAlive = null;
    if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  }
  const onGesture = () => { hadGesture = true; if (remote.length && !ownPlayerOpen()) startKeepAlive(); };
  document.addEventListener('pointerdown', onGesture, { once: true });
  document.addEventListener('keydown', onGesture, { once: true });

  const ownPlayerOpen = () => !playerEl.classList.contains('hidden');

  function send(id, action, extra) {
    return fetch(`/api/sessions/${id}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }),
    }).then(() => setTimeout(poll, 400)).catch(() => {});
  }

  const livePosition = (s) => {
    const elapsed = s.paused ? 0 : (Date.now() - receivedAt + s.ageMs) / 1000;
    return Math.min(s.duration || Infinity, s.position + elapsed);
  };
  const fmt = (t) => {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };

  function button(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'np-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    if (!barEl) return;
    const show = remote.length > 0 && !ownPlayerOpen() && !IS_TV_APP;
    barEl.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-nowplaying', show);
    if (!show) { barEl.innerHTML = ''; return; }
    barEl.innerHTML = '';
    for (const s of remote.slice(0, 3)) {
      const card = document.createElement('div');
      card.className = 'np-card';
      card.dataset.session = s.id;
      if (s.posterUrl) {
        const img = document.createElement('img');
        img.className = 'np-poster';
        img.alt = '';
        img.src = s.posterUrl;
        card.appendChild(img);
      }
      const info = document.createElement('div');
      info.className = 'np-info';
      const t = document.createElement('div');
      t.className = 'np-title';
      t.textContent = s.title;
      const sub = document.createElement('div');
      sub.className = 'np-sub';
      sub.textContent = `${s.paused ? 'Paused' : 'Playing'} on ${s.deviceName}${s.subtitle ? ' · ' + s.subtitle : ''}`;
      const prog = document.createElement('div');
      prog.className = 'np-progress';
      const fill = document.createElement('div');
      fill.className = 'np-progress-fill';
      fill.dataset.fill = s.id;
      prog.appendChild(fill);
      const time = document.createElement('div');
      time.className = 'np-time';
      time.dataset.time = s.id;
      info.append(t, sub, prog, time);
      const ctl = document.createElement('div');
      ctl.className = 'np-controls';
      ctl.append(
        button('⏪', 'Back 10 seconds', () => send(s.id, 'seek_rel', { delta: -10 })),
        button(s.paused ? '▶' : '⏸', s.paused ? 'Play' : 'Pause', () => send(s.id, s.paused ? 'play' : 'pause')),
        button('⏩', 'Forward 30 seconds', () => send(s.id, 'seek_rel', { delta: 30 })),
        button('⏹', 'Stop', () => send(s.id, 'stop')),
      );
      card.append(info, ctl);
      barEl.appendChild(card);
    }
    tick();
  }

  // Cheap per-second update of progress without rebuilding the DOM.
  function tick() {
    if (!remote.length) return;
    for (const s of remote) {
      const pos = livePosition(s);
      const fill = barEl && barEl.querySelector(`[data-fill="${s.id}"]`);
      const time = barEl && barEl.querySelector(`[data-time="${s.id}"]`);
      if (fill && s.duration) fill.style.width = `${Math.min(100, (pos / s.duration) * 100)}%`;
      if (time) time.textContent = s.duration ? `${fmt(pos)} / ${fmt(s.duration)}` : fmt(pos);
    }
    updateMediaSession();
  }
  setInterval(tick, 1000);

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !keepAlive || !remote.length) return;
    const s = remote[0];
    const key = `${s.id}|${s.title}|${s.paused}`;
    if (updateMediaSession.key !== key) {
      updateMediaSession.key = key;
      try {
        const art = s.posterUrl ? [{ src: new URL(s.posterUrl, location.href).href, sizes: '512x512' }] : [];
        navigator.mediaSession.metadata = new MediaMetadata({
          title: s.title, artist: s.subtitle || `On ${s.deviceName}`, album: `Playing on ${s.deviceName}`, artwork: art,
        });
      } catch (e) { /* ignore */ }
      const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* unsupported */ } };
      const cur = () => remote[0];
      set('play', () => cur() && send(cur().id, 'play'));
      set('pause', () => cur() && send(cur().id, 'pause'));
      set('stop', () => cur() && send(cur().id, 'stop'));
      set('seekbackward', (d) => cur() && send(cur().id, 'seek_rel', { delta: -((d && d.seekOffset) || 10) }));
      set('seekforward', (d) => cur() && send(cur().id, 'seek_rel', { delta: (d && d.seekOffset) || 30 }));
      set('seekto', (d) => cur() && d && typeof d.seekTime === 'number' && send(cur().id, 'seek', { position: d.seekTime }));
    }
    navigator.mediaSession.playbackState = s.paused ? 'paused' : 'playing';
    if (s.duration && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: s.duration, position: Math.min(s.duration, livePosition(s)), playbackRate: 1 }); } catch (e) { /* ignore */ }
    }
  }

  let lastSig = '';
  async function poll() {
    if (!state.profile || IS_TV_APP) return;
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json();
      receivedAt = Date.now();
      serverSkew = 0;
      remote = (data.sessions || []).filter((s) => s.id !== SESSION_ID);
    } catch (e) { return; }
    // Rebuild the DOM only when something visible changed.
    const sig = remote.map((s) => `${s.id}|${s.title}|${s.paused}|${s.deviceName}`).join(';') + `|${ownPlayerOpen()}`;
    if (sig !== lastSig) { lastSig = sig; render(); }
    if (remote.length && !ownPlayerOpen()) startKeepAlive(); else stopKeepAlive();
    tick();
  }
  setInterval(poll, POLL_MS);
  setTimeout(poll, 1500);

  window.VyznNowPlaying = { start, stop, poll };
})();
