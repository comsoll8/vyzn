'use strict';
// Admin dashboard (Tautulli-style): Activity (who's streaming now), History
// (play log), Stats (charts) and Users (accounts, profiles, resets).
// Data comes from the /api/admin/* routes in src/auth.js + src/activity.js.
(function () {
  const $ = (id) => document.getElementById(id);
  const overlay = $('adminOverlay');
  const body = $('adminBody');
  let tab = 'activity';
  let liveTimer = null;
  let histOffset = 0;
  let histFilter = { user: '', profile: '', q: '' };
  let statDays = 30;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => window.VyznAuth && window.VyznAuth.toast(m);
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const dur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast(d.error || 'Request failed'); return null; }
    return d;
  }
  const post = (url, b) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

  // ---- Activity --------------------------------------------------------------
  async function renderActivity() {
    const rows = await api('/api/admin/activity');
    if (tab !== 'activity' || !rows) return;
    if (!rows.length) { body.innerHTML = '<div class="adm-empty"><img src="/assets/vyzn-mark-scanning.svg" alt="" /><p>Nothing streaming right now.</p></div>'; return; }
    body.innerHTML = '<div class="adm-grid">' + rows.map((r) => `
      <div class="adm-stream">
        <div class="adm-stream-top"><strong>${esc(r.title)}</strong><span class="adm-live">● LIVE</span></div>
        <div class="adm-sub">${esc(r.user)} › ${esc(r.profile)} · ${esc(r.platform)}${r.ip ? ' · ' + esc(r.ip) : ''}</div>
        <div class="adm-bar"><div style="width:${r.percent}%"></div></div>
        <div class="adm-sub">${dur(r.positionSeconds)} / ${dur(r.durationSeconds)} · ${r.percent}% · started ${esc(when(r.startedAt))}</div>
      </div>`).join('') + '</div>';
  }

  // ---- History ---------------------------------------------------------------
  async function loadUsersForFilter() {
    const users = await api('/api/admin/overview');
    return users || [];
  }
  async function renderHistory(reset) {
    if (reset) {
      histOffset = 0;
      const users = await loadUsersForFilter();
      const opts = ['<option value="">All users &amp; profiles</option>'];
      for (const u of users) {
        opts.push(`<option value="u${u.id}">${esc(u.displayName)} (all profiles)</option>`);
        for (const p of u.profiles) opts.push(`<option value="p${p.id}">&nbsp;&nbsp;${esc(u.displayName)} › ${esc(p.name)}</option>`);
      }
      body.innerHTML = `<div class="adm-toolbar"><select id="admHistSel">${opts.join('')}</select>
        <input id="admHistQ" type="search" placeholder="Search titles" value="${esc(histFilter.q)}" />
        <button type="button" class="btn-secondary" id="admHistGo">Search</button></div>
        <div id="admHistRows" class="adm-table"></div><div id="admHistMeta" class="adm-sub"></div>
        <button type="button" class="btn-secondary hidden" id="admHistMore">Load more</button>`;
      const sel = $('admHistSel');
      sel.value = histFilter.user ? 'u' + histFilter.user : histFilter.profile ? 'p' + histFilter.profile : '';
      const go = () => {
        const v = sel.value;
        histFilter = { user: v[0] === 'u' ? v.slice(1) : '', profile: v[0] === 'p' ? v.slice(1) : '', q: $('admHistQ').value.trim() };
        renderHistory(true);
      };
      sel.addEventListener('change', go);
      $('admHistGo').addEventListener('click', go);
      $('admHistQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      $('admHistMore').addEventListener('click', () => renderHistory(false));
    }
    const qs = new URLSearchParams({ limit: 50, offset: histOffset });
    if (histFilter.user) qs.set('user', histFilter.user);
    if (histFilter.profile) qs.set('profile', histFilter.profile);
    if (histFilter.q) qs.set('q', histFilter.q);
    const d = await api('/api/admin/playlog?' + qs);
    if (!d || tab !== 'history') return;
    const rowsEl = $('admHistRows');
    if (reset && !d.rows.length) rowsEl.innerHTML = '<p class="adm-sub">No plays recorded yet. History starts filling as people watch.</p>';
    for (const r of d.rows) {
      const el = document.createElement('div');
      el.className = 'adm-row';
      el.innerHTML = `<div class="adm-row-main"><strong>${esc(r.title)}</strong>
        <div class="adm-sub">${esc(r.user)} › ${esc(r.profile)} · ${esc(r.platform || '')} · ${esc(when(r.startedAt))}</div></div>
        <div class="adm-row-side"><span>${r.completed ? 'Finished' : r.percent + '%'}</span><small>${dur(r.watchedSeconds)} watched</small></div>
        <button type="button" class="adm-x" title="Delete entry" aria-label="Delete entry">&times;</button>`;
      el.querySelector('.adm-x').addEventListener('click', async () => {
        if (await api('/api/admin/playlog/' + r.id, { method: 'DELETE' })) el.remove();
      });
      rowsEl.appendChild(el);
    }
    histOffset += d.rows.length;
    $('admHistMeta').textContent = `Showing ${histOffset} of ${d.total}`;
    $('admHistMore').classList.toggle('hidden', histOffset >= d.total);
  }

  // ---- Stats -----------------------------------------------------------------
  function barChart(values, labels, opts) {
    const w = 640, h = 150, pad = 22, n = values.length, max = Math.max(1, ...values);
    const bw = (w - pad * 2) / n;
    let svg = `<svg viewBox="0 0 ${w} ${h + 22}" class="adm-chart" role="img">
      <defs><linearGradient id="admG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00E5FF"/><stop offset="1" stop-color="#7C4DFF"/></linearGradient></defs>`;
    values.forEach((v, i) => {
      const bh = Math.round((v / max) * (h - 10));
      svg += `<rect x="${pad + i * bw + bw * 0.12}" y="${h - bh}" width="${bw * 0.76}" height="${Math.max(bh, v ? 2 : 0)}" rx="${Math.min(4, bw / 3)}" fill="url(#admG)"><title>${esc(labels[i])}: ${v}</title></rect>`;
    });
    const step = Math.ceil(n / (opts && opts.maxLabels || 8));
    labels.forEach((l, i) => { if (i % step === 0) svg += `<text x="${pad + i * bw + bw / 2}" y="${h + 16}" text-anchor="middle" font-size="11" fill="#9a9ba8">${esc(l)}</text>`; });
    svg += `<text x="2" y="12" font-size="11" fill="#9a9ba8">${max}</text></svg>`;
    return svg;
  }
  function rankList(rows, unit) {
    if (!rows.length) return '<p class="adm-sub">No data yet.</p>';
    const max = Math.max(...rows.map((r) => r.plays));
    return rows.map((r) => `<div class="adm-rank"><div class="adm-rank-bar" style="width:${(r.plays / max) * 100}%"></div>
      <span class="adm-rank-name">${esc(r.name || 'Unknown')}</span><span class="adm-rank-val">${r.plays} play${r.plays === 1 ? '' : 's'}${r.hours != null ? ' · ' + r.hours + 'h' : ''}</span></div>`).join('');
  }
  async function renderStats() {
    const s = await api('/api/admin/stats?days=' + statDays);
    if (!s || tab !== 'stats') return;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    body.innerHTML = `
      <div class="adm-toolbar"><span class="adm-sub">Range</span>
        ${[7, 30, 90, 365].map((d) => `<button type="button" class="btn-secondary adm-range${d === statDays ? ' active' : ''}" data-d="${d}">${d === 365 ? '1 year' : d + ' days'}</button>`).join('')}</div>
      <div class="adm-cards">
        <div class="adm-card"><b>${s.totals.plays}</b><span>Plays</span></div>
        <div class="adm-card"><b>${s.totals.hours}</b><span>Hours watched</span></div>
        <div class="adm-card"><b>${s.totals.users}</b><span>Active users</span></div>
        <div class="adm-card"><b>${s.totals.titles}</b><span>Titles watched</span></div>
      </div>
      <h3>Plays per day</h3>${barChart(s.perDay.map((d) => d.plays), s.perDay.map((d) => d.date.slice(5)), { maxLabels: 8 })}
      <div class="adm-two">
        <div><h3>By hour of day</h3>${barChart(s.byHour, s.byHour.map((_, i) => i + ':00'), { maxLabels: 6 })}</div>
        <div><h3>By day of week</h3>${barChart(s.byWeekday, wd, { maxLabels: 7 })}</div>
      </div>
      <div class="adm-two">
        <div><h3>Top users</h3>${rankList(s.topUsers)}</div>
        <div><h3>Top titles</h3>${rankList(s.topTitles)}</div>
      </div>
      <h3>Platforms</h3>${rankList(s.platforms)}`;
    body.querySelectorAll('.adm-range').forEach((b) => b.addEventListener('click', () => { statDays = Number(b.dataset.d); renderStats(); }));
  }

  // ---- Users -----------------------------------------------------------------
  async function renderUsers() {
    const users = await api('/api/admin/overview');
    if (!users || tab !== 'users') return;
    body.innerHTML = '<div id="admUsers"></div>';
    const box = $('admUsers');
    for (const u of users) {
      const card = document.createElement('div');
      card.className = 'adm-user';
      card.innerHTML = `<div class="adm-user-head"><strong>${esc(u.displayName)}</strong> <span class="adm-sub">@${esc(u.username)}${u.isAdmin ? ' · admin' : ''} · ${u.devices} signed-in device${u.devices === 1 ? '' : 's'} · last active ${u.lastActive ? esc(when(u.lastActive)) : 'never'}</span></div>`;
      const acts = document.createElement('div');
      acts.className = 'adm-actions';
      const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.textContent = label; b.addEventListener('click', fn); acts.appendChild(b); };
      mk('Reset password', async () => {
        const pw = prompt('New password for ' + u.username + ' (6+ characters). This signs them out everywhere.');
        if (pw && await post('/api/admin/users/' + u.id + '/reset', { password: pw })) { toast('Password reset.'); renderUsers(); }
      });
      mk('Clear all history', async () => {
        if (!confirm('Clear watch history and watchlists for every profile of ' + u.username + '?')) return;
        const r = await post('/api/admin/users/' + u.id + '/reset-history');
        if (r) { toast('Cleared ' + r.historyCleared + ' entries.'); renderUsers(); }
      });
      card.appendChild(acts);
      for (const p of u.profiles) {
        const row = document.createElement('div');
        row.className = 'adm-prof';
        const av = p.avatar && /^[a-z0-9-]{2,32}$/.test(p.avatar) ? `<img src="/assets/avatars/${p.avatar}.svg" alt="" />` : `<span>${esc((p.name || '?')[0].toUpperCase())}</span>`;
        row.innerHTML = `<div class="adm-prof-av">${av}</div><div class="adm-row-main"><strong>${esc(p.name)}${p.is_child ? ' <small>kids</small>' : ''}</strong>
          <div class="adm-sub">${p.titles_watched} title${p.titles_watched === 1 ? '' : 's'} · last watched ${p.last_watched_at ? esc(new Date(String(p.last_watched_at).replace(' ', 'T') + 'Z').toLocaleString()) : 'never'}</div></div>`;
        const b1 = document.createElement('button'); b1.type = 'button'; b1.className = 'btn-secondary'; b1.textContent = 'Clear history';
        b1.addEventListener('click', async () => { if (confirm('Clear history and watchlist for "' + p.name + '"?') && await post('/api/admin/profiles/' + p.id + '/reset')) { toast('Profile reset.'); renderUsers(); } });
        const b2 = document.createElement('button'); b2.type = 'button'; b2.className = 'btn-secondary'; b2.textContent = 'Delete';
        b2.addEventListener('click', async () => { if (confirm('Delete profile "' + p.name + '"? Its play-log entries are kept.') && await api('/api/profiles/' + p.id, { method: 'DELETE' })) renderUsers(); });
        row.append(b1, b2);
        card.appendChild(row);
      }
      box.appendChild(card);
    }
  }

  // ---- shell -----------------------------------------------------------------
  function show(t) {
    tab = t;
    clearInterval(liveTimer); liveTimer = null;
    document.querySelectorAll('#adminTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    body.innerHTML = '<div class="adm-empty"><img src="/assets/vyzn-mark-scanning.svg" alt="" /></div>';
    if (t === 'activity') { renderActivity(); liveTimer = setInterval(renderActivity, 5000); }
    else if (t === 'history') renderHistory(true);
    else if (t === 'stats') renderStats();
    else renderUsers();
  }
  function open() { overlay.classList.remove('hidden'); if (typeof enterOverlay === 'function') enterOverlay(); show(tab); $('adminBack').focus(); }
  function hide() { overlay.classList.add('hidden'); clearInterval(liveTimer); liveTimer = null; }
  // Goes through browser history like every other overlay, so the TV remote's
  // Back key (WebView.goBack) closes the dashboard too.
  function close() { if (typeof exitOverlay === 'function') exitOverlay(hide); else hide(); }
  window.hideAdminInternal = hide;

  $('adminTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });
  $('adminBack').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) { e.stopPropagation(); close(); } }, true);
  $('ccAdminBtn').addEventListener('click', () => { if (typeof hideControlCenterInternal === 'function') hideControlCenterInternal(); open(); });
  document.addEventListener('vyzn-auth-changed', () => $('ccAdminBtn').classList.toggle('hidden', !(window.VyznAuth && window.VyznAuth.isAdmin())));
})();
