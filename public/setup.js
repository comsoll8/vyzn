'use strict';
// First-run setup wizard: asks the server's admin for a TMDB key once.
// Shown only when no TMDB credential is configured and it hasn't been
// skipped before, only to an admin (or anyone while sign-in is still off),
// and never inside the TV app (typing a long key with a remote is
// painful; set it from a phone/computer instead).
(function () {
  const $ = (id) => document.getElementById(id);

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }
  const putConfig = (body) => api('/api/settings/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  function close() { $('setupOverlay').classList.add('hidden'); }
  function setMsg(text, kind) {
    const m = $('setupMsg');
    m.textContent = text || '';
    m.className = 'setup-msg' + (kind ? ' ' + kind : '');
  }

  async function saveKey() {
    const key = $('setupKey').value.trim();
    if (!key) { setMsg('Paste your TMDB key first.', 'err'); $('setupKey').focus(); return; }
    const btn = $('setupSave');
    btn.disabled = true; setMsg('Checking with TMDB…');
    try {
      const { data } = await api('/api/settings/tmdb/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
      });
      if (!data.ok) { setMsg(data.error || 'That key did not work.', 'err'); return; }
      const saved = await putConfig(data.kind === 'token' ? { TMDB_AUTH_TOKEN: key } : { TMDB_API_KEY: key });
      if (!saved.res.ok) { setMsg(saved.data.error || 'Could not save the key.', 'err'); return; }
      $('setupKey').value = '';
      $('setupStep1').classList.add('hidden');
      $('setupStep2').classList.remove('hidden');
      $('setupScan').focus();
    } catch {
      setMsg("Can't reach the server.", 'err');
    } finally { btn.disabled = false; }
  }

  async function skip() {
    try { await putConfig({ SETUP_TMDB_DISMISSED: '1' }); } catch { /* shown again next time */ }
    close();
  }

  async function scanNow() {
    $('setupScan').disabled = true;
    try { await fetch('/api/scan', { method: 'POST' }); } catch { /* progress UI shows errors */ }
    close();
  }

  async function maybeShow() {
    if (window.VyznNativePlayer) return;                       // TV app
    const auth = window.VyznAuth;
    if (auth && auth.authRequired() && !auth.isAdmin()) return; // non-admin accounts
    try {
      const { res, data } = await api('/api/settings');
      if (!res.ok || data.tmdbConfigured || data.setupTmdbDismissed) return;
    } catch { return; }
    $('setupOverlay').classList.remove('hidden');
    $('setupKey').focus();
  }

  $('setupSave').addEventListener('click', saveKey);
  $('setupSkip').addEventListener('click', skip);
  $('setupScan').addEventListener('click', scanNow);
  $('setupLater').addEventListener('click', close);
  $('setupKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });

  if (window.VyznAuth) window.VyznAuth.ready.then(maybeShow);
})();
