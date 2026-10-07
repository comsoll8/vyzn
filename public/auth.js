'use strict';
// Login gateway, QR pairing (TV side), sign-out and the Settings > Accounts
// panel. Loaded before app.js: it wraps fetch() so every API call carries
// the saved token, shows the login screen on any 401, and exposes
// window.VyznAuth.ready — app.js waits on it before loading profiles or
// opening the scan-progress stream (both would 401 pre-login).
(function () {
  const TOKEN_KEY = 'vyzn_auth_token';
  const $ = (id) => document.getElementById(id);
  const store = (k) => { try { return window[k]; } catch { return null; } };

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function saveToken(token, remember) {
    try {
      localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
      (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    } catch { /* cookie still carries the session */ }
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch {}
  }

  let state = { authRequired: false, user: null };
  let readyResolve;
  let isReady = false;
  const ready = new Promise((r) => { readyResolve = r; });
  const markReady = () => { if (!isReady) { isReady = true; readyResolve(); } };

  // --- fetch wrapper -----------------------------------------------------
  const nativeFetch = window.fetch.bind(window);
  const NO_REDIRECT = /^\/api\/auth\/(login|register|status|pairing)/;
  window.fetch = function (input, init) {
    let url = typeof input === 'string' ? input : (input && input.url) || '';
    let path = url;
    try { const u = new URL(url, location.href); if (u.origin !== location.origin) return nativeFetch(input, init); path = u.pathname; } catch {}
    const tok = getToken();
    if (tok && (path.startsWith('/api/') || path.startsWith('/stream-files/'))) {
      init = Object.assign({}, init);
      const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + tok);
      init.headers = h;
    }
    return nativeFetch(input, init).then((res) => {
      if (res.status === 401 && path.startsWith('/api/') && !NO_REDIRECT.test(path)) {
        clearToken();
        state.authRequired = true;
        showLogin();
      }
      return res;
    });
  };

  // --- toast ---------------------------------------------------------------
  let toastTimer;
  function toast(msg) {
    const el = $('vyznToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // --- login overlay -------------------------------------------------------
  let pairId = null, pollTimer = null, expireTimer = null;

  function stopPairing() {
    clearInterval(pollTimer); clearTimeout(expireTimer); pollTimer = expireTimer = null; pairId = null;
  }

  async function startPairing() {
    stopPairing();
    $('loginQrExpired').classList.add('hidden');
    $('loginCode').textContent = '';
    try {
      const res = await nativeFetch('/api/auth/pairing/session', { method: 'POST' });
      if (!res.ok) throw new Error('pairing ' + res.status);
      const s = await res.json();
      pairId = s.sessionId;
      $('loginQr').src = '/api/auth/pairing/qr/' + s.sessionId;
      $('loginCode').textContent = 'Code ' + s.code.slice(0, 3) + ' ' + s.code.slice(3) + ' · ' + s.url.replace(/^https?:\/\//, '');
      pollTimer = setInterval(pollPairing, 2000);
      expireTimer = setTimeout(() => { if (!$('loginOverlay').classList.contains('hidden')) startPairing(); }, (s.expiresInSec - 5) * 1000);
    } catch {
      $('loginQrExpired').textContent = 'QR unavailable — use the form';
      $('loginQrExpired').classList.remove('hidden');
    }
  }

  async function pollPairing() {
    if (!pairId) return;
    try {
      const res = await nativeFetch('/api/auth/pairing/status/' + pairId);
      const d = await res.json();
      if (d.status === 'approved') { stopPairing(); onSignedIn(d, true); }
      else if (d.status === 'expired') startPairing();
    } catch { /* retry next tick */ }
  }

  function showLogin() {
    const el = $('loginOverlay');
    if (!el.classList.contains('hidden')) return;
    $('profileGate').classList.add('hidden');
    $('app').classList.add('hidden');
    el.classList.remove('hidden', 'fade-out');
    $('loginError').textContent = '';
    startPairing();
    setTimeout(() => $('loginUser').focus(), 50);
  }

  function hideLogin() {
    const el = $('loginOverlay');
    stopPairing();
    el.classList.add('fade-out');
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fade-out'); }, 450);
  }

  function onSignedIn(d, viaPairing) {
    saveToken(d.token, viaPairing ? true : $('loginRemember').checked);
    state = { authRequired: true, user: d.user };
    $('loginPass').value = '';
    const wasReady = isReady;
    hideLogin();
    toast('Welcome back, ' + d.user.displayName + '!');
    syncAccountUi();
    if (wasReady) setTimeout(() => location.reload(), 900); // session expired mid-use
    else markReady();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginSubmit');
    btn.disabled = true; $('loginError').textContent = '';
    try {
      const res = await nativeFetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value, remember: $('loginRemember').checked }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('loginError').textContent = res.status === 429 ? 'Too many attempts — wait a minute.' : 'Wrong username or password.';
        $('loginPass').value = ''; $('loginPass').focus();
      } else onSignedIn(d, false);
    } catch { $('loginError').textContent = "Can't reach the server."; }
    btn.disabled = false;
  });
  $('loginQrRefresh').addEventListener('click', startPairing);

  // D-pad: arrow keys normally move the text cursor inside inputs, but
  // up/down should hop between fields/buttons on the login screen.
  document.addEventListener('keydown', (e) => {
    if ($('loginOverlay').classList.contains('hidden')) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target && e.target.tagName === 'INPUT' && typeof focusInDirection === 'function') {
      e.preventDefault();
      focusInDirection(e.key === 'ArrowUp' ? 'up' : 'down');
    }
  }, true);

  // --- sign out + accounts ---------------------------------------------------
  async function signOut() {
    try { await nativeFetch('/api/auth/logout', { method: 'POST', headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {} }); } catch {}
    clearToken();
    try { localStorage.removeItem('media-server:profileId'); } catch {}
    location.reload();
  }
  $('ccSignOutBtn').addEventListener('click', signOut);

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function syncAccountUi() {
    $('ccSignOutBtn').classList.toggle('hidden', !(state.authRequired && state.user));
    document.dispatchEvent(new CustomEvent('vyzn-auth-changed'));
    const isAdmin = !state.authRequired || (state.user && state.user.isAdmin);
    $('accountsSection').classList.toggle('hidden', !isAdmin);
    $('accountForm').classList.toggle('hidden', !isAdmin);
    $('accountsIntro').textContent = state.authRequired
      ? 'Anyone who wants to use this server needs one of these accounts.'
      : 'Sign-in is currently OFF — anyone on your network can use this server. Creating the first account turns sign-in ON for everyone (that account becomes the admin).';
    $('accSubmit').textContent = state.authRequired ? 'Create account' : 'Create first account & turn on sign-in';
    const list = $('accountsList');
    list.innerHTML = '';
    if (!state.authRequired || !isAdmin) return;
    try {
      const res = await fetch('/api/auth/users');
      if (!res.ok) return;
      for (const u of await res.json()) {
        const row = document.createElement('div');
        row.className = 'accounts-row';
        row.innerHTML = '<span>' + esc(u.displayName) + ' <small>@' + esc(u.username) + (u.isAdmin ? ' · admin' : '') + '</small></span>';
        if (state.user && u.id !== state.user.id) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'btn-secondary'; b.textContent = 'Remove';
          b.addEventListener('click', async () => {
            if (!confirm('Remove ' + u.username + '?')) return;
            await fetch('/api/auth/users/' + u.id, { method: 'DELETE' });
            syncAccountUi();
          });
          row.appendChild(b);
        }
        list.appendChild(row);
      }
    } catch {}
  }


  $('accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('accMsg'); msg.textContent = '';
    const first = !state.authRequired;
    if (first && !confirm('This turns on sign-in for everyone using this server. Continue?')) return;
    const res = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('accName').value, displayName: $('accDisplay').value, password: $('accPass').value }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { msg.textContent = d.error || 'Could not create account.'; return; }
    $('accName').value = $('accDisplay').value = $('accPass').value = '';
    if (first) { saveToken(d.token, true); state = { authRequired: true, user: d.user }; toast('Sign-in is now on. You are signed in as ' + d.user.displayName + '.'); }
    else toast('Account created.');
    syncAccountUi();
  });

  // --- boot ---------------------------------------------------------------
  (async function boot() {
    try {
      const tok = getToken();
      const res = await nativeFetch('/api/auth/status', { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
      const s = await res.json();
      state = { authRequired: !!s.authRequired, user: s.user };
      if (!s.authRequired) return markReady();
      if (s.authenticated) {
        // Refreshes the cookie so <video>/HLS requests are authorised too.
        await nativeFetch('/api/auth/verify', { headers: { Authorization: 'Bearer ' + tok } });
        syncAccountUi();
        return markReady();
      }
      clearToken();
      showLogin();
    } catch {
      markReady(); // server unreachable: let the app show its own errors
    }
  })();

  window.VyznAuth = { ready, toast, signOut, getToken, refreshAccounts: syncAccountUi, esc,
    authRequired: () => state.authRequired,
    isAdmin: () => !!(state.authRequired && state.user && state.user.isAdmin) };
  syncAccountUi();
})();
