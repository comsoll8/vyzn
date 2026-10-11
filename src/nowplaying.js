'use strict';
/**
 * "Now playing" sessions + remote control.
 *
 * Every player (the Android TV native player, the in-page web player) reports
 * its state here every few seconds. Another device signed in to the same
 * account — e.g. a phone — can list those sessions and send commands
 * (play / pause / seek / stop), which the playing device picks up through a
 * long-poll. Sessions live in memory only: they're ephemeral by nature and a
 * restart simply means players re-register on their next report.
 */
const db = require('./db');

const LIVE_MS = 20 * 1000;          // a session that hasn't reported in this long is gone
const POLL_MS = 25 * 1000;          // long-poll hold time
const MAX_QUEUE = 20;
const ACTIONS = new Set(['play', 'pause', 'toggle', 'seek_rel', 'seek', 'stop']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const sessions = new Map();         // id -> session
const waiters = new Map();          // id -> Set<fn> (wake a pending long-poll)

function wake(id) {
  const set = waiters.get(id);
  if (!set) return;
  for (const fn of [...set]) fn();
}

function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > LIVE_MS) { sessions.delete(id); wake(id); }
  }
}
setInterval(prune, 30 * 1000).unref();

// Title / poster for a local media item, so players only have to send an id.
function describeLocal(mediaId) {
  try {
    const r = db.prepare(`
      SELECT COALESCE(m.tmdb_matched_title, m.title) AS title, m.poster_url,
             s.title AS show_title, s.poster_url AS show_poster, se.season_number, e.episode_number, e.title AS ep_title
      FROM media_items m
      LEFT JOIN tv_episodes e ON e.media_item_id = m.id
      LEFT JOIN tv_seasons se ON se.id = e.season_id
      LEFT JOIN tv_shows s ON s.id = e.show_id
      WHERE m.id = ?`).get(mediaId);
    if (!r) return null;
    if (r.show_title) {
      return {
        title: r.show_title,
        subtitle: `S${r.season_number || 0}:E${r.episode_number || 0}${r.ep_title ? ' · ' + r.ep_title : ''}`,
        posterUrl: r.show_poster || r.poster_url,
      };
    }
    return { title: r.title, subtitle: '', posterUrl: r.poster_url };
  } catch { return null; }
}

// ...and for one that lives on a linked server (snapshot kept by remote_progress).
function describeRemote(profileId, serverId, mediaId) {
  try {
    const r = db.prepare('SELECT item_json FROM remote_progress WHERE profile_id = ? AND server_id = ? AND media_id = ?')
      .get(profileId, serverId, mediaId);
    if (!r || !r.item_json) return null;
    const it = JSON.parse(r.item_json);
    return { title: it.show_title || it.tmdb_matched_title || it.title, subtitle: '', posterUrl: it.poster_url || it.still_url || null };
  } catch { return null; }
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function register(fastify, { hasUsers }) {
  const ownerOf = (req) => (req.user ? req.user.id : null);
  const canAccess = (req, s) => !hasUsers() || (req.user && (req.user.is_admin || s.userId === req.user.id));

  // A player reports its state. profileId ties it to the account (and is
  // ownership-checked by the auth hook, since the route is under /api/profiles/).
  fastify.post('/api/profiles/:profileId/sessions', async (req, reply) => {
    const profileId = Number(req.params.profileId);
    const b = req.body || {};
    const id = String(b.session_id || '');
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'Provide a session_id (8-64 letters/digits/-/_).' });

    const existing = sessions.get(id);
    if (existing && existing.userId !== ownerOf(req)) return reply.code(403).send({ error: 'not_your_session' });

    if (b.state === 'stopped') {
      sessions.delete(id);
      wake(id);
      return { ok: true, seq: 0 };
    }

    const mediaId = Number(b.media_id);
    const remoteId = Number(b.remote_server_id) || 0;
    let meta = { title: str(b.title, 200), subtitle: str(b.subtitle, 200), posterUrl: str(b.poster_url, 500) || null };
    if (!meta.title || !meta.posterUrl) {
      const found = remoteId ? describeRemote(profileId, remoteId, mediaId) : describeLocal(mediaId);
      if (found) meta = { title: meta.title || found.title, subtitle: meta.subtitle || found.subtitle, posterUrl: meta.posterUrl || found.posterUrl };
    }

    const s = existing || { id, userId: ownerOf(req), queue: [], seq: 0 };
    Object.assign(s, {
      profileId,
      kind: b.kind === 'native' ? 'native' : 'web',
      deviceName: str(b.device_name, 60) || (b.kind === 'native' ? 'TV' : 'Browser'),
      mediaId: Number.isFinite(mediaId) ? mediaId : null,
      remoteServerId: remoteId || null,
      title: meta.title || 'Playing',
      subtitle: meta.subtitle,
      posterUrl: meta.posterUrl,
      position: Math.max(0, num(b.position_seconds)),
      duration: Math.max(0, num(b.duration_seconds)),
      paused: b.state === 'paused',
      updatedAt: Date.now(),
    });
    sessions.set(id, s);
    return { ok: true, seq: s.seq };
  });

  // Sessions visible to this account.
  fastify.get('/api/sessions', async (req) => {
    prune();
    const now = Date.now();
    const list = [...sessions.values()]
      .filter((s) => !hasUsers() || (req.user && s.userId === req.user.id))
      .map((s) => ({
        id: s.id, kind: s.kind, deviceName: s.deviceName, mediaId: s.mediaId, remoteServerId: s.remoteServerId,
        title: s.title, subtitle: s.subtitle, posterUrl: s.posterUrl, position: s.position, duration: s.duration,
        paused: s.paused, ageMs: now - s.updatedAt,
      }));
    return { sessions: list, serverTime: now };
  });

  // Send a command to a playing device.
  fastify.post('/api/sessions/:id/command', async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'That player has stopped.' });
    if (!canAccess(req, s)) return reply.code(403).send({ error: 'not_your_session' });
    const { action, delta, position } = req.body || {};
    if (!ACTIONS.has(action)) return reply.code(400).send({ error: 'Unknown action.' });
    s.seq += 1;
    s.queue.push({ seq: s.seq, action, delta: num(delta), position: num(position) });
    if (s.queue.length > MAX_QUEUE) s.queue.shift();
    wake(s.id);
    return { ok: true, seq: s.seq };
  });

  // Long-poll: the playing device asks for commands newer than `after`.
  fastify.get('/api/sessions/:id/commands', async (req, reply) => {
    const id = req.params.id;
    const first = sessions.get(id);
    if (!first) return reply.code(404).send({ error: 'unknown_session' });
    if (!canAccess(req, first)) return reply.code(403).send({ error: 'not_your_session' });
    const after = Number(req.query.after) || 0;
    const pending = () => {
      const s = sessions.get(id);
      return s ? s.queue.filter((c) => c.seq > after) : null;
    };

    let cmds = pending();
    if (cmds && cmds.length === 0) {
      await new Promise((resolve) => {
        const set = waiters.get(id) || new Set();
        waiters.set(id, set);
        const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) waiters.delete(id); resolve(); };
        const timer = setTimeout(done, POLL_MS);
        set.add(done);
        req.raw.on('close', done);
      });
      cmds = pending();
    }
    if (cmds === null) return reply.code(404).send({ error: 'unknown_session' });
    const s = sessions.get(id);
    return { commands: cmds, seq: s ? s.seq : after };
  });
}

module.exports = { register, _sessions: sessions };
