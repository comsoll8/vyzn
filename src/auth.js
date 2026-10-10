'use strict';
/**
 * VYZN accounts, login sessions and TV-to-phone QR pairing.
 *
 * Rollout model ("open until first account"): while the `users` table is
 * empty the server behaves exactly as before — nothing requires a login.
 * The moment the first account is created (Settings > Accounts) every
 * /api/ and /stream-files/ request needs a valid token. The first account
 * is an admin and may create more.
 *
 * Tokens: 32 random bytes, handed to the client once; only a SHA-256 hash
 * is stored. Clients present them as `Authorization: Bearer <token>` or the
 * HttpOnly `vyzn_auth` cookie (needed because <video>/HLS requests and the
 * native player can't set custom headers from the page).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const activity = require('./activity');
const peers = require('./peers');

const COOKIE = 'vyzn_auth';
const DAY = 24 * 60 * 60 * 1000;
const TTL_SESSION = DAY;           // not "remember me"
const TTL_REMEMBER = 365 * DAY;    // "Remember This Device"
const PAIR_TTL = 5 * 60 * 1000;
const PAIR_MAX = 200;

// ---- passwords --------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, saltHex, keyHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const key = Buffer.from(keyHex, 'hex');
    const test = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), key.length);
    return crypto.timingSafeEqual(key, test);
  } catch { return false; }
}
// Burn comparable time when the username doesn't exist (no user enumeration).
const DUMMY_HASH = hashPassword('vyzn-dummy-password');

// ---- tokens -----------------------------------------------------------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function issueToken(userId, remember, label) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, label, created_at, expires_at, last_used_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sha(token), userId, label || null, now, now + (remember ? TTL_REMEMBER : TTL_SESSION), now);
  return { token, maxAgeMs: remember ? TTL_REMEMBER : null };
}

function userForToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const h = sha(token);
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.is_admin, t.expires_at
                          FROM auth_tokens t JOIN users u ON u.id = t.user_id
                          WHERE t.token_hash = ?`).get(h);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(h);
    return null;
  }
  return row;
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name || u.username, isAdmin: !!u.is_admin };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromRequest(req) {
  const h = req.headers.authorization;
  if (h && /^Bearer /i.test(h)) return h.slice(7).trim();
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

function setCookie(reply, token, maxAgeMs) {
  let c = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAgeMs) c += `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
  reply.header('Set-Cookie', c);
}
function clearCookie(reply) {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---- open-mode flag ---------------------------------------------------
let hasUsersCache = null;
function hasUsers() {
  if (hasUsersCache === null) hasUsersCache = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  return hasUsersCache;
}
function invalidateUsers() { hasUsersCache = null; }

// ---- rate limiting (per key, sliding window) --------------------------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return false;
}

// ---- pairing sessions (in memory, short-lived) ------------------------
const pairing = new Map(); // id -> { id, code, createdAt, token?, maxAgeMs?, userId? }
function prunePairing() {
  const now = Date.now();
  for (const [id, s] of pairing) if (now - s.createdAt > PAIR_TTL) pairing.delete(id);
}
function newPairCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (![...pairing.values()].some((s) => s.code === code)) return code;
  }
  return null;
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

// Each account only sees its own profiles.
function listProfiles(userId) {
  try { return db.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY id').all(userId); } catch { return []; }
}

// Profile ids a request refers to via /api/profiles/:id/... or ?profile_id=.
function profileIdsIn(url) {
  const ids = [];
  const m = url.split('?')[0].match(/^\/api\/profiles\/(\d+)/);
  if (m) ids.push(Number(m[1]));
  const q = url.split('?')[1];
  if (q) { const v = new URLSearchParams(q).get('profile_id'); if (v && /^\d+$/.test(v)) ids.push(Number(v)); }
  return ids;
}

// ---- enforcement hook -------------------------------------------------
const PUBLIC_API = new Set([
  '/api/auth/status', '/api/auth/login', '/api/auth/register',
  '/api/auth/pairing/session', '/api/auth/pairing/approve',
]);
function isPublic(p) {
  if (p === '/health' || p === '/pair') return true;
  if (PUBLIC_API.has(p)) return true;
  if (p.startsWith('/api/auth/pairing/status/') || p.startsWith('/api/auth/pairing/qr/')) return true;
  // Only /api/ and /stream-files/ are protected; the frontend shell must
  // load so it can show the login screen.
  return !(p.startsWith('/api/') || p.startsWith('/stream-files/'));
}

// Server-level actions only admins may perform once accounts exist.
const ADMIN_ONLY = [
  ['GET', /^\/api\/settings\/config$/], ['PUT', /^\/api\/settings\/config$/],
  ['*', /^\/api\/tailscale\//],
  ['*', /^\/api\/peers(\/|$)/],
  ['POST', /^\/api\/scan$/],
  ['POST', /^\/api\/library\/(purge|retry-unmatched|backfill-genres)$/],
  ['DELETE', /^\/api\/library$/], ['POST', /^\/api\/library\/\d+\/rematch$/],
  ['GET', /^\/api\/library\/unmatched$/],
  ['GET', /^\/api\/logs\/download$/], ['GET', /^\/api\/autoscan$/],
  ['POST', /^\/api\/streams\/[^/]+\/stop$/],
];
const isAdminOnly = (method, p) => ADMIN_ONLY.some(([m, re]) => (m === '*' || m === method) && re.test(p));

function authHook(req, reply, done) {
  const p = req.raw.url.split('?')[0];
  req.user = null;
  // Linked-server (peer) tokens: a separate, read-only credential.
  const pr = peers.handle(req, p);
  if (pr) return pr.ok ? done() : reply.code(pr.status).send({ error: pr.error });
  const tok = tokenFromRequest(req);
  if (tok) req.user = userForToken(tok);
  if (!hasUsers() || isPublic(p)) return done();
  if (!req.user) return reply.code(401).send({ error: 'auth_required' });
  // Accounts are separate instances: a login may only touch its own profiles.
  if (req.user.is_admin) return done();
  if (isAdminOnly(req.method, p)) return reply.code(403).send({ error: 'admin_required' });
  for (const pid of profileIdsIn(req.raw.url)) {
    const row = db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(pid);
    if (row && row.user_id !== req.user.id) return reply.code(403).send({ error: 'not_your_profile' });
  }
  done();
}

// ---- routes -----------------------------------------------------------
function register(fastify) {
  fastify.addHook('onRequest', authHook);

  const requireAdmin = (req, reply) => {
    if (!req.user || !req.user.is_admin) { reply.code(403).send({ error: 'admin_required' }); return false; }
    return true;
  };
  const ip = (req) => req.ip || 'unknown';

  fastify.get('/api/auth/status', async (req) => ({
    authRequired: hasUsers(),
    authenticated: !!req.user,
    user: req.user ? publicUser(req.user) : null,
  }));

  function loginWith(username, password, req) {
    if (limited(`login:${ip(req)}`, 10, 60 * 1000)) return { error: 'rate_limited' };
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    const ok = verifyPassword(String(password || ''), u ? u.password_hash : DUMMY_HASH);
    return u && ok ? { user: u } : { error: 'invalid_credentials' };
  }

  fastify.post('/api/auth/login', async (req, reply) => {
    const { username, password, remember } = req.body || {};
    const r = loginWith(username, password, req);
    if (r.error) return reply.code(r.error === 'rate_limited' ? 429 : 401).send({ error: r.error });
    const { token, maxAgeMs } = issueToken(r.user.id, !!remember, 'login');
    setCookie(reply, token, maxAgeMs);
    return { token, user: publicUser(r.user), profiles: listProfiles(r.user.id) };
  });

  fastify.get('/api/auth/verify', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'invalid_token' });
    // Refresh the cookie so Bearer-only clients (the TV app's localStorage
    // token) also get cookie auth for <video>/HLS requests.
    const tok = tokenFromRequest(req);
    const row = db.prepare('SELECT expires_at, created_at FROM auth_tokens WHERE token_hash = ?').get(sha(tok));
    const remaining = row ? row.expires_at - Date.now() : null;
    setCookie(reply, tok, remaining && remaining > TTL_SESSION ? remaining : null);
    db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), sha(tok));
    return { user: publicUser(req.user), profiles: listProfiles(req.user.id) };
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const tok = tokenFromRequest(req);
    if (tok) db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(sha(tok));
    clearCookie(reply);
    return { ok: true };
  });

  // First account: open to anyone while no accounts exist (it becomes admin
  // and closes the server). Afterwards only admins may create accounts.
  fastify.post('/api/auth/register', async (req, reply) => {
    const first = !hasUsers();
    if (!first && !requireAdmin(req, reply)) return;
    const { username, password, displayName } = req.body || {};
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9._@+-]{2,64}$/.test(name)) return reply.code(400).send({ error: 'Username must be 2–64 characters (letters, numbers, . _ @ + -).' });
    if (typeof password !== 'string' || password.length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters.' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return reply.code(409).send({ error: 'That username is taken.' });
    const info = db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(name, String(displayName || '').trim().slice(0, 40) || null, hashPassword(password), first ? 1 : 0);
    invalidateUsers();
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    if (first) {
      db.prepare('UPDATE profiles SET user_id = ? WHERE user_id IS NULL').run(u.id);
      const { token, maxAgeMs } = issueToken(u.id, true, 'first-account');
      setCookie(reply, token, maxAgeMs);
      return { token, user: publicUser(u), profiles: listProfiles(u.id) };
    }
    return { user: publicUser(u) };
  });

  fastify.get('/api/auth/users', async (req, reply) => {
    if (hasUsers() && !requireAdmin(req, reply)) return;
    return db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id').all()
      .map((u) => ({ ...publicUser(u), createdAt: u.created_at }));
  });

  fastify.delete('/api/auth/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    if (id === req.user.id) return reply.code(400).send({ error: "You can't delete your own account." });
    db.prepare('DELETE FROM profiles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    invalidateUsers();
    return { ok: true };
  });

  fastify.post('/api/auth/users/:id/password', async (req, reply) => {
    const id = Number(req.params.id);
    if (!req.user || (req.user.id !== id && !req.user.is_admin)) return reply.code(403).send({ error: 'forbidden' });
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    // Sign out every other device for that account.
    const keep = id === req.user.id ? sha(tokenFromRequest(req) || '') : '';
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash != ?').run(id, keep);
    return { ok: true };
  });

  // --- QR pairing ---
  fastify.post('/api/auth/pairing/session', async (req, reply) => {
    if (limited(`pairnew:${ip(req)}`, 30, 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
    prunePairing();
    if (pairing.size >= PAIR_MAX) return reply.code(503).send({ error: 'busy' });
    const code = newPairCode();
    if (!code) return reply.code(503).send({ error: 'busy' });
    const id = crypto.randomUUID();
    pairing.set(id, { id, code, createdAt: Date.now() });
    return {
      sessionId: id, code,
      url: `${requestOrigin(req)}/pair?code=${code}`,
      expiresInSec: PAIR_TTL / 1000,
    };
  });

  fastify.get('/api/auth/pairing/qr/:id', async (req, reply) => {
    const s = pairing.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'expired' });
    let QR;
    try { QR = require('qrcode'); } catch { return reply.code(501).send({ error: 'qr_unavailable' }); }
    const svg = await QR.toString(`${requestOrigin(req)}/pair?code=${s.code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.header('Content-Type', 'image/svg+xml').header('Cache-Control', 'no-store').send(svg);
  });

  fastify.get('/api/auth/pairing/status/:id', async (req, reply) => {
    prunePairing();
    const s = pairing.get(req.params.id);
    if (!s) return { status: 'expired' };
    if (!s.token) return { status: 'pending' };
    pairing.delete(s.id); // the token is handed over exactly once
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.userId);
    if (!u) return { status: 'expired' };
    setCookie(reply, s.token, s.maxAgeMs);
    return { status: 'approved', token: s.token, user: publicUser(u), profiles: listProfiles(u.id) };
  });

  // Phone side. Either already signed in (Bearer/cookie) or supplies
  // credentials once; either way the TV session gets its own fresh token.
  fastify.post('/api/auth/pairing/approve', async (req, reply) => {
    if (limited(`pairapprove:${ip(req)}`, 15, 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
    prunePairing();
    const { code, username, password } = req.body || {};
    const s = [...pairing.values()].find((x) => !x.token && x.code === String(code || '').trim());
    if (!s) return reply.code(404).send({ error: 'That code has expired. Refresh the QR code on your TV.' });
    let user = req.user;
    if (!user) {
      const r = loginWith(username, password, req);
      if (r.error) return reply.code(r.error === 'rate_limited' ? 429 : 401).send({ error: r.error });
      user = r.user;
    }
    const { token, maxAgeMs } = issueToken(user.id, true, 'tv-pairing');
    s.token = token; s.maxAgeMs = maxAgeMs; s.userId = user.id;
    // If the phone signed in with credentials, give it a session too so a
    // second approval doesn't ask again ("authenticates both devices").
    let phoneToken = null;
    if (!req.user) {
      const t = issueToken(user.id, true, 'phone');
      phoneToken = t.token;
      setCookie(reply, t.token, t.maxAgeMs);
    }
    return { ok: true, user: publicUser(user), phoneToken };
  });

  // --- Admin: overview, watch history, resets (Tautulli-style) -------------
  fastify.get('/api/admin/overview', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const users = db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id').all();
    const profiles = db.prepare(`
      SELECT p.id, p.name, p.avatar, p.user_id, p.is_child,
             (SELECT COUNT(*) FROM playback_progress WHERE profile_id = p.id) AS titles_watched,
             (SELECT MAX(last_watched_at) FROM playback_progress WHERE profile_id = p.id) AS last_watched_at
      FROM profiles p ORDER BY p.id`).all();
    const sessions = db.prepare('SELECT user_id, COUNT(*) AS n, MAX(last_used_at) AS last_used FROM auth_tokens WHERE expires_at > ? GROUP BY user_id').all(Date.now());
    return users.map((u) => {
      const s = sessions.find((x) => x.user_id === u.id);
      return { ...publicUser(u), createdAt: u.created_at, devices: s ? s.n : 0, lastActive: s ? s.last_used : null,
               profiles: profiles.filter((p) => p.user_id === u.id) };
    });
  });

  activity.register(fastify, requireAdmin);
  peers.register(fastify, { requireAdmin, hasUsers, version: require('../package.json').version });

  // Reset an account: new password + sign out every device.
  fastify.post('/api/admin/users/:id/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const { password } = req.body || {};
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return reply.code(404).send({ error: 'No such account.' });
    if (typeof password !== 'string' || password.length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    const keep = id === req.user.id ? sha(tokenFromRequest(req) || '') : '';
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash != ?').run(id, keep);
    return { ok: true };
  });

  // Reset a profile: wipe its watch history, progress and watchlist (keeps the profile).
  fastify.post('/api/admin/profiles/:id/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id)) return reply.code(404).send({ error: 'No such profile.' });
    const a = db.prepare('DELETE FROM playback_progress WHERE profile_id = ?').run(id).changes;
    const b = db.prepare('DELETE FROM watchlist WHERE profile_id = ?').run(id).changes;
    return { ok: true, historyCleared: a, watchlistCleared: b };
  });

  // Reset a whole account's profiles' history in one go.
  fastify.post('/api/admin/users/:id/reset-history', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const ids = db.prepare('SELECT id FROM profiles WHERE user_id = ?').all(id).map((r) => r.id);
    let n = 0;
    for (const pid of ids) {
      n += db.prepare('DELETE FROM playback_progress WHERE profile_id = ?').run(pid).changes;
      db.prepare('DELETE FROM watchlist WHERE profile_id = ?').run(pid);
    }
    return { ok: true, historyCleared: n };
  });

  // Mobile pairing page.
  fastify.get('/pair', async (req, reply) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'pair.html'), 'utf8');
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
  });
}

module.exports = { listProfiles, register, hashPassword, verifyPassword, issueToken, userForToken, hasUsers, authHook, invalidateUsers };
