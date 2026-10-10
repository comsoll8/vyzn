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
const { Readable } = require('stream');
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

// Lay this profile's saved progress (kept on THIS server) over what the other
// server returned, so Resume / progress bars / watched ticks work.
function overlayProgress(body, remotePath, profileId, serverId) {
  const prog = new Map(db.prepare(
    'SELECT media_id, position_seconds, duration_seconds, completed FROM remote_progress WHERE profile_id = ? AND server_id = ?'
  ).all(profileId, serverId).map((r) => [r.media_id, r]));
  if (prog.size === 0) return body;
  const mark = (row, id) => {
    const p = prog.get(id);
    if (p) { row.position_seconds = p.position_seconds; row.duration_seconds = p.duration_seconds; row.completed = p.completed; }
  };
  if (Array.isArray(body)) {
    for (const r of body) if (r && r.media_type) mark(r, r.id);
  } else if (body && typeof body === 'object') {
    if (Array.isArray(body.movies)) for (const r of body.movies) mark(r, r.id);
    if (Array.isArray(body.seasons)) {
      for (const se of body.seasons) for (const ep of se.episodes || []) mark(ep, ep.media_id);
    } else if (/^\/api\/library\/\d+\/details$/.test(remotePath)) {
      const p = prog.get(body.id);
      body.progress = p ? { position_seconds: p.position_seconds, duration_seconds: p.duration_seconds, completed: p.completed } : null;
    }
  }
  return body;
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
    db.prepare('DELETE FROM remote_progress WHERE server_id = ?').run(Number(req.params.id));
    for (const k of cache.keys()) if (k.startsWith(`${Number(req.params.id)}|`)) cache.delete(k);
    return { ok: true };
  });

  // --- Playback ---------------------------------------------------------
  // Start a stream on the other server. The JSON it returns points at that
  // server's /stream-files/..., so rewrite those to this server's file
  // proxy below; the browser then only ever talks to this server.
  fastify.get('/api/remote/:id/stream/:mediaId', async (req, reply) => {
    const server = get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'No such linked server.' });
    const mediaId = Number(req.params.mediaId);
    if (!Number.isInteger(mediaId)) return reply.code(400).send({ error: 'bad_media_id' });
    const q = req.query.audio_track !== undefined && /^\d+$/.test(String(req.query.audio_track))
      ? `?audio_track=${req.query.audio_track}` : '';
    let res;
    try {
      res = await callPeer(server, `/api/stream/${mediaId}${q}`, { timeoutMs: 90000 });
    } catch {
      return reply.code(502).send({ error: `${server.name} can't be reached right now.` });
    }
    if (res.status === 401) return reply.code(502).send({ error: `${server.name} no longer accepts this server's token.` });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok || !body) return reply.code(res.ok ? 502 : res.status).send(body || { error: 'remote_error' });
    const base = `/api/remote/${server.id}/files/`;
    const rewrite = (u) => (typeof u === 'string' && u.startsWith('/stream-files/') ? base + u.slice('/stream-files/'.length) : u);
    return { ...body, playlistUrl: rewrite(body.playlistUrl), subtitleUrl: rewrite(body.subtitleUrl) };
  });

  // Pipe a file from the other server through (HLS playlist/segments,
  // subtitles, or the original media file), forwarding Range so seeking works.
  async function pipeFromPeer(server, upstreamPath, req, reply) {
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    let up;
    try {
      const headers = { Authorization: `Bearer ${server.token}`, 'User-Agent': 'vyzn-linked' };
      if (req.headers.range) headers.Range = req.headers.range;
      up = await fetch(`${server.url}${upstreamPath}`, { headers, signal: ac.signal });
    } catch {
      return reply.code(502).send({ error: 'server_unreachable' });
    }
    reply.code(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = up.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (!up.body) return reply.send();
    return reply.send(Readable.fromWeb(up.body));
  }

  fastify.get('/api/remote/:id/files/*', async (req, reply) => {
    const server = get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'No such linked server.' });
    const rel = String(req.params['*'] || '');
    if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) return reply.code(400).send({ error: 'bad_path' });
    return pipeFromPeer(server, `/stream-files/${rel.split('/').map(encodeURIComponent).join('/')}`, req, reply);
  });

  // The original file, byte-for-byte (the Android TV native player's route).
  fastify.get('/api/remote/:id/raw/:mediaId', async (req, reply) => {
    const server = get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'No such linked server.' });
    if (!/^\d+$/.test(String(req.params.mediaId))) return reply.code(400).send({ error: 'bad_media_id' });
    return pipeFromPeer(server, `/api/raw/${req.params.mediaId}`, req, reply);
  });

  fastify.get('/api/remote/:id/raw/:mediaId/subtitles', async (req, reply) => {
    const server = get(req.params.id);
    if (!server) return reply.code(404).send({ error: 'No such linked server.' });
    if (!/^\d+$/.test(String(req.params.mediaId))) return reply.code(400).send({ error: 'bad_media_id' });
    let res;
    try { res = await callPeer(server, `/api/raw/${req.params.mediaId}/subtitles`, { timeoutMs: 15000 }); }
    catch { return reply.code(502).send({ error: 'server_unreachable' }); }
    if (!res.ok) return reply.code(res.status === 401 ? 502 : res.status).send({ error: 'remote_error' });
    const body = await res.json().catch(() => null);
    if (!body) return reply.code(502).send({ error: 'remote_error' });
    const u = body.subtitleUrl;
    return { ...body, subtitleUrl: typeof u === 'string' && u.startsWith('/stream-files/') ? `/api/remote/${server.id}/files/${u.slice('/stream-files/'.length)}` : u };
  });

  // --- Progress for titles that live on a linked server ------------------
  fastify.post('/api/profiles/:profileId/remote-progress', async (req, reply) => {
    const profileId = Number(req.params.profileId);
    const { server_id: serverId, media_id: mediaId, position_seconds: position, duration_seconds: duration, item } = req.body || {};
    if (!get(serverId) || !Number.isInteger(Number(mediaId)) || position === undefined || !(duration > 0)) {
      return reply.code(400).send({ error: 'Provide {"server_id","media_id","position_seconds","duration_seconds"}' });
    }
    const completed = position / duration >= 0.9 ? 1 : 0;
    let itemJson = null;
    if (item && typeof item === 'object') {
      const j = JSON.stringify(item);
      if (j.length <= 30000) itemJson = j;
    }
    db.prepare(`
      INSERT INTO remote_progress (profile_id, server_id, media_id, position_seconds, duration_seconds, completed, item_json, last_watched_at)
      VALUES (@profileId, @serverId, @mediaId, @position, @duration, @completed, @itemJson, datetime('now'))
      ON CONFLICT(profile_id, server_id, media_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = excluded.completed,
        item_json = COALESCE(excluded.item_json, item_json),
        last_watched_at = datetime('now')
    `).run({ profileId, serverId: Number(serverId), mediaId: Number(mediaId), position, duration, completed, itemJson });
    return { ok: true, completed: Boolean(completed) };
  });

  fastify.delete('/api/profiles/:profileId/remote-progress/:serverId/:mediaId', async (req) => {
    db.prepare('DELETE FROM remote_progress WHERE profile_id = ? AND server_id = ? AND media_id = ?')
      .run(Number(req.params.profileId), Number(req.params.serverId), Number(req.params.mediaId));
    return { ok: true };
  });

  // Continue Watching for one linked server (same 5%-90% rule as local).
  fastify.get('/api/remote/:id/continue-watching', async (req) => {
    const profileId = Number(req.query.profile_id);
    if (!profileId) return [];
    const rows = db.prepare(`
      SELECT media_id, position_seconds, duration_seconds, item_json, last_watched_at FROM remote_progress
      WHERE profile_id = ? AND server_id = ? AND completed = 0 AND item_json IS NOT NULL
        AND duration_seconds > 0
        AND (position_seconds * 1.0 / duration_seconds) >= 0.05
        AND (position_seconds * 1.0 / duration_seconds) < 0.9
      ORDER BY last_watched_at DESC LIMIT 20`).all(profileId, Number(req.params.id));
    const items = [];
    for (const r of rows) {
      try {
        items.push({ ...JSON.parse(r.item_json), id: r.media_id, position_seconds: r.position_seconds,
                     duration_seconds: r.duration_seconds, last_watched_at: r.last_watched_at });
      } catch { /* skip a corrupt snapshot */ }
    }
    return filterByProfile(items, profileId);
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
      body = overlayProgress(structuredClone(body), remotePath, profileId, server.id);
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
