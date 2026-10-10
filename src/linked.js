'use strict';
/**
 * Linked servers — the CONSUMING side.
 *
 * An admin adds another VYZN server (address + the peer token that server's
 * admin created). The browser never talks to that server directly and never
 * sees its token: it asks THIS server for `/api/remote/:id/...`, which
 * forwards a read-only request, applies the current profile's content-rating
 * limit to the answer, and hands it back. Browsing only — playback is
 * proxied separately.
 */
const db = require('./db');
const peers = require('./peers');

const TTL_MS = 30 * 1000;
const cache = new Map();

// Browse routes only; streaming routes are handled separately.
const BROWSE_ALLOWED = (p) =>
  peers.isAllowed('GET', p) && !/^\/api\/(stream|raw)\//.test(p) && !p.startsWith('/stream-files/');

function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.protocol}//${u.host}`;
}

async function callPeer(server, pathAndQuery, { timeoutMs = 15000 } = {}) {
  return fetch(server.url + pathAndQuery, {
    headers: { Authorization: `Bearer ${server.token}`, Accept: 'application/json', 'User-Agent': 'vyzn-linked' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function register(fastify, { filterByProfile, hasUsers }) {
  const adminOnly = (req, reply) => {
    if (!hasUsers()) return true;
    if (!req.user || !req.user.is_admin) { reply.code(403).send({ error: 'admin_required' }); return false; }
    return true;
  };
  const get = (id) => db.prepare('SELECT * FROM linked_servers WHERE id = ?').get(Number(id));

  // Everyone signed in can see the names (for the switcher); only admins
  // see the addresses.
  fastify.get('/api/linked-servers', async (req) => {
    const admin = !hasUsers() || (req.user && req.user.is_admin);
    return db.prepare('SELECT id, name, url FROM linked_servers ORDER BY id').all()
      .map((r) => (admin ? r : { id: r.id, name: r.name }));
  });

  fastify.post('/api/linked-servers', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const { name, url, token } = req.body || {};
    const base = cleanUrl(url);
    if (!base) return reply.code(400).send({ error: 'Enter the other server\'s address, e.g. http://cupcake:8080' });
    if (!token || typeof token !== 'string' || !token.startsWith(peers.PREFIX)) {
      return reply.code(400).send({ error: 'That doesn\'t look like a VYZN access token (it starts with vzp_).' });
    }
    // Prove the address and token work before saving anything.
    let info;
    try {
      const res = await callPeer({ url: base, token: token.trim() }, '/api/peer/info', { timeoutMs: 10000 });
      if (res.status === 401) return reply.code(400).send({ error: 'That server rejected the token. Check it was copied in full, and that it hasn\'t been revoked.' });
      if (!res.ok) return reply.code(400).send({ error: `That server answered HTTP ${res.status}. Is it running VYZN 0.6.0 or newer?` });
      info = await res.json();
    } catch (err) {
      return reply.code(400).send({ error: `Couldn't reach ${base} (${err.message}). Check the address and that both servers are on Tailscale.` });
    }
    const label = String(name || '').trim().slice(0, 60) || (info && info.name) || base;
    const r = db.prepare('INSERT INTO linked_servers (name, url, token, created_at) VALUES (?, ?, ?, ?)')
      .run(label, base, token.trim(), Date.now());
    return { id: r.lastInsertRowid, name: label, url: base, movies: info.movies, shows: info.shows };
  });

  fastify.delete('/api/linked-servers/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    db.prepare('DELETE FROM linked_servers WHERE id = ?').run(Number(req.params.id));
    for (const k of cache.keys()) if (k.startsWith(`${Number(req.params.id)}|`)) cache.delete(k);
    return { ok: true };
  });

  // Read-only browse proxy: /api/remote/:id/<anything on the allowlist>
  fastify.get('/api/remote/:id/*', async (req, reply) => {
    const server = get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'No such linked server.' });
    const remotePath = '/api/' + String(req.params['*'] || '');
    if (!BROWSE_ALLOWED(remotePath)) return reply.code(403).send({ error: 'not_allowed' });

    const profileId = req.query.profile_id ? Number(req.query.profile_id) : null;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) if (k !== 'profile_id' && typeof v === 'string') qs.set(k, v);
    const pq = remotePath + (qs.toString() ? `?${qs}` : '');

    const key = `${server.id}|${pq}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.t > TTL_MS) {
      try {
        const res = await callPeer(server, pq);
        if (res.status === 401) return reply.code(502).send({ error: 'token_rejected', message: `${server.name} no longer accepts this server's token.` });
        const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
        hit = { t: Date.now(), status: res.status, body };
        if (res.ok) {
          cache.set(key, hit);
          if (cache.size > 300) cache.delete(cache.keys().next().value);
        }
      } catch (err) {
        return reply.code(502).send({ error: 'server_unreachable', message: `${server.name} can't be reached right now.` });
      }
    }
    if (hit.status !== 200 || hit.body == null) return reply.code(hit.status === 200 ? 502 : hit.status).send(hit.body || { error: 'remote_error' });

    // This server's profile limits apply to what it browses elsewhere.
    let body = hit.body;
    if (profileId) {
      if (Array.isArray(body)) body = filterByProfile(body, profileId);
      else if (body && typeof body === 'object') {
        if (Array.isArray(body.movies) || Array.isArray(body.shows)) {
          body = { ...body, movies: filterByProfile(body.movies || [], profileId), shows: filterByProfile(body.shows || [], profileId) };
        } else if ('content_rating' in body && filterByProfile([body], profileId).length === 0) {
          return reply.code(403).send({ error: 'blocked_by_profile' });
        }
      }
    }
    return body;
  });
}

module.exports = { register, cleanUrl };
