'use strict';
/**
 * Linked servers — the SHARING side.
 *
 * An admin creates a peer token for another VYZN server (e.g. "Cupcake").
 * That server presents it as `Authorization: Bearer vzp_…` and may then
 * browse and stream this library READ-ONLY, over a small allowlist of GET
 * routes. A peer token is not a user: it has no profile, can't touch
 * accounts/settings/progress, and never sees file paths. Only a SHA-256
 * hash is stored, so a leaked database can't be replayed.
 *
 * We only log "peer X streamed title Y" — never which profile or person.
 */
const crypto = require('crypto');
const os = require('os');
const db = require('./db');

const PREFIX = 'vzp_';
const PLAY_GAP_MS = 15 * 60 * 1000;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// GET-only allowlist. Everything else is refused for peer tokens.
const ALLOWED = [
  /^\/api\/peer\/(info|new)$/,
  /^\/api\/library$/,
  /^\/api\/library\/\d+(\/details)?$/,
  /^\/api\/shows$/,
  /^\/api\/shows\/\d+(\/details)?$/,
  /^\/api\/genres$/,
  /^\/api\/genres\/\d+\/media$/,
  /^\/api\/stream\/\d+$/,
  /^\/api\/raw\/\d+(\/subtitles)?$/,
  /^\/stream-files\//,
];
const isAllowed = (method, p) => method === 'GET' && ALLOWED.some((re) => re.test(p));

// Failed-token throttle (per IP) so a peer token can't be brute-forced.
const fails = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (fails.get(ip) || []).filter((t) => now - t < 60 * 1000);
  fails.set(ip, arr);
  return arr.length >= 20;
}
function noteFail(ip) {
  const arr = fails.get(ip) || [];
  arr.push(Date.now());
  fails.set(ip, arr);
  if (fails.size > 2000) for (const [k, v] of fails) if (!v.length) fails.delete(k);
}

function bearer(req) {
  const h = req.headers.authorization;
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : null;
}

function peerForToken(token) {
  if (!token || token.length > 200) return null;
  return db.prepare('SELECT id, name FROM peer_tokens WHERE token_hash = ?').get(sha(token)) || null;
}

// Called from auth.js's authHook. Returns:
//   null            -> not a peer request, carry on with normal auth
//   { ok: true }    -> peer authenticated (req.peer set), allow it
//   { status, error } -> reject
function handle(req, p) {
  const tok = bearer(req);
  if (!tok || !tok.startsWith(PREFIX)) return null;
  const ip = req.ip || 'unknown';
  if (throttled(ip)) return { status: 429, error: 'rate_limited' };
  const peer = peerForToken(tok);
  if (!peer) { noteFail(ip); return { status: 401, error: 'invalid_peer_token' }; }
  if (!isAllowed(req.method, p)) return { status: 403, error: 'peer_forbidden' };
  req.peer = peer;
  db.prepare('UPDATE peer_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), peer.id);
  return { ok: true };
}

// Remove anything that reveals where files live on this server.
const HIDDEN_KEYS = new Set(['file_path', 'file_paths']);
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (!HIDDEN_KEYS.has(k)) out[k] = scrub(val);
    return out;
  }
  return v;
}

function titleFor(mediaId) {
  const r = db.prepare(`
    SELECT COALESCE(m.tmdb_matched_title, m.title) AS title, s.title AS show_title,
           se.season_number, e.episode_number
    FROM media_items m
    LEFT JOIN tv_episodes e ON e.media_item_id = m.id
    LEFT JOIN tv_seasons se ON se.id = e.season_id
    LEFT JOIN tv_shows s ON s.id = e.show_id
    WHERE m.id = ?`).get(mediaId);
  if (!r) return `Item ${mediaId}`;
  if (r.show_title) {
    const pad = (n) => String(n || 0).padStart(2, '0');
    return `${r.show_title} · S${pad(r.season_number)}E${pad(r.episode_number)}`;
  }
  return r.title;
}

// "Peer X is streaming Y": one row per (peer, title), extended while the
// peer keeps requesting it, new row after a gap.
function recordPlay(peer, mediaId) {
  const now = Date.now();
  const open = db.prepare(`SELECT id FROM peer_plays WHERE peer_id = ? AND media_id = ? AND last_seen_at > ?
                           ORDER BY last_seen_at DESC LIMIT 1`).get(peer.id, mediaId, now - PLAY_GAP_MS);
  if (open) {
    db.prepare('UPDATE peer_plays SET last_seen_at = ? WHERE id = ?').run(now, open.id);
  } else {
    db.prepare(`INSERT INTO peer_plays (peer_id, peer_name, media_id, title, started_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(peer.id, peer.name, mediaId, titleFor(mediaId), now, now);
  }
}

function register(fastify, { requireAdmin, hasUsers, version }) {
  const adminOnly = (req, reply) => (hasUsers() ? requireAdmin(req, reply) : true);

  // Strip file paths from every JSON payload sent to a peer, and drop any
  // profile selector so a peer can't read this server's per-profile state.
  fastify.addHook('preHandler', async (req) => {
    if (!req.peer) return;
    if (req.query && typeof req.query === 'object') delete req.query.profile_id;
    const m = req.raw.url.split('?')[0].match(/^\/api\/(?:stream|raw)\/(\d+)(?:\/subtitles)?$/);
    if (m) { try { recordPlay(req.peer, Number(m[1])); } catch { /* logging only */ } }
  });
  fastify.addHook('preSerialization', async (req, reply, payload) => (req.peer ? scrub(payload) : payload));

  // What a linked server sees when it first connects.
  fastify.get('/api/peer/info', async (req) => {
    const movies = db.prepare("SELECT COUNT(*) AS n FROM media_items WHERE media_type = 'movie'").get().n;
    const shows = db.prepare('SELECT COUNT(*) AS n FROM tv_shows').get().n;
    return {
      name: process.env.SERVER_NAME || os.hostname(),
      version,
      peer: req.peer ? req.peer.name : null,
      movies,
      shows,
    };
  });

  // --- Admin: manage peers --------------------------------------------
  fastify.get('/api/peers', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const peers = db.prepare('SELECT id, name, created_at, last_used_at FROM peer_tokens ORDER BY id').all();
    const recent = db.prepare(`SELECT peer_id, media_id, title, started_at, last_seen_at FROM peer_plays
                               ORDER BY last_seen_at DESC LIMIT 100`).all();
    const now = Date.now();
    return peers.map((p) => ({
      id: p.id, name: p.name, createdAt: p.created_at, lastUsedAt: p.last_used_at,
      streaming: recent.filter((r) => r.peer_id === p.id && now - r.last_seen_at < 90 * 1000)
        .map((r) => ({ title: r.title, since: r.started_at })),
      recent: recent.filter((r) => r.peer_id === p.id).slice(0, 10)
        .map((r) => ({ title: r.title, startedAt: r.started_at, lastSeenAt: r.last_seen_at })),
    }));
  });

  // The token is returned exactly once, here.
  fastify.post('/api/peers', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const name = String((req.body || {}).name || '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Give the linked server a name (e.g. "Cupcake").' });
    const token = PREFIX + crypto.randomBytes(32).toString('hex');
    const info = db.prepare('INSERT INTO peer_tokens (name, token_hash, created_at) VALUES (?, ?, ?)')
      .run(name, sha(token), Date.now());
    return { id: info.lastInsertRowid, name, token };
  });

  fastify.delete('/api/peers/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const id = Number(req.params.id);
    db.prepare('DELETE FROM peer_tokens WHERE id = ?').run(id);
    return { ok: true };
  });
}

module.exports = { handle, register, scrub, isAllowed, PREFIX };
