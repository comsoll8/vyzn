'use strict';
/**
 * Tautulli-style activity tracking for the admin dashboard: a play log
 * (one row per viewing session), "now streaming", and aggregate stats.
 * Sessions are inferred from the player's periodic progress pings
 * (POST /api/profiles/:id/progress) — no extra client work needed.
 */
const db = require('./db');

const SESSION_GAP_MS = 15 * 60 * 1000; // pings further apart than this = new session
const LIVE_MS = 90 * 1000;             // "now streaming" if pinged within this
const MAX_CREDIT_S = 45;               // max watch time credited per ping gap

function platformFromUA(ua) {
  ua = String(ua || '');
  if (/Dalvik|okhttp|ExoPlayer|Media3/i.test(ua)) return 'Android TV (native player)';
  if (/Android/i.test(ua) && /; wv\)|Version\/\d.*Chrome/i.test(ua)) return 'Android TV app';
  if (/Android/i.test(ua)) return 'Android browser';
  if (/iPhone|iPad/i.test(ua)) return 'iOS browser';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}

const TITLE_SQL = `
  SELECT m.title AS media_title, s.title AS show_title, se.season_number, e.episode_number, e.title AS episode_title
  FROM media_items m
  LEFT JOIN tv_episodes e ON e.media_item_id = m.id
  LEFT JOIN tv_seasons se ON se.id = e.season_id
  LEFT JOIN tv_shows s ON s.id = e.show_id
  WHERE m.id = ?`;

function titlesFor(mediaId) {
  const r = db.prepare(TITLE_SQL).get(mediaId);
  if (!r) return { title: `Item ${mediaId}`, group: `Item ${mediaId}` };
  if (r.show_title) {
    const pad = (n) => String(n || 0).padStart(2, '0');
    return {
      title: `${r.show_title} · S${pad(r.season_number)}E${pad(r.episode_number)}${r.episode_title ? ' · ' + r.episode_title : ''}`,
      group: r.show_title,
    };
  }
  return { title: r.media_title, group: r.media_title };
}

function recordPlay({ profileId, mediaId, position, duration, completed, user, ua, ip }) {
  try {
    const now = Date.now();
    const open = db.prepare(`SELECT * FROM play_log WHERE profile_id = ? AND media_id = ? AND last_seen_at > ?
                             ORDER BY last_seen_at DESC LIMIT 1`).get(profileId, mediaId, now - SESSION_GAP_MS);
    if (open) {
      const moved = Math.abs(position - open.position_seconds) > 0.5;
      const credit = moved && position >= open.position_seconds - 1 ? Math.min((now - open.last_seen_at) / 1000, MAX_CREDIT_S) : 0;
      db.prepare(`UPDATE play_log SET last_seen_at = ?, position_seconds = ?, duration_seconds = ?,
                  watched_seconds = watched_seconds + ?, completed = MAX(completed, ?) WHERE id = ?`)
        .run(now, position, duration, credit, completed ? 1 : 0, open.id);
      return;
    }
    const profile = db.prepare('SELECT name FROM profiles WHERE id = ?').get(profileId);
    const t = titlesFor(mediaId);
    db.prepare(`INSERT INTO play_log (profile_id, profile_name, user_id, user_name, media_id, title, group_title,
                started_at, last_seen_at, position_seconds, duration_seconds, watched_seconds, completed, platform, ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(profileId, profile ? profile.name : null, user ? user.id : null,
           user ? (user.display_name || user.username) : 'Household', mediaId, t.title, t.group,
           now, now, position, duration, completed ? 1 : 0, platformFromUA(ua), ip || null);
  } catch (e) { /* never let stats break playback progress */ }
}

function register(fastify, requireAdmin) {
  const guard = (req, reply) => requireAdmin(req, reply);
  const pct = (r) => (r.duration_seconds > 0 ? Math.min(100, Math.round((r.position_seconds / r.duration_seconds) * 100)) : 0);

  fastify.get('/api/admin/activity', async (req, reply) => {
    if (!guard(req, reply)) return;
    const rows = db.prepare(`SELECT * FROM play_log WHERE last_seen_at > ? ORDER BY started_at DESC`).all(Date.now() - LIVE_MS);
    return rows.map((r) => ({
      id: r.id, user: r.user_name, profile: r.profile_name, title: r.title, platform: r.platform, ip: r.ip,
      percent: pct(r), positionSeconds: r.position_seconds, durationSeconds: r.duration_seconds,
      startedAt: r.started_at, mediaId: r.media_id,
    }));
  });

  fastify.get('/api/admin/playlog', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const where = []; const args = {};
    if (/^\d+$/.test(q.user || '')) { where.push('user_id = @user'); args.user = Number(q.user); }
    if (/^\d+$/.test(q.profile || '')) { where.push('profile_id = @profile'); args.profile = Number(q.profile); }
    if (q.q) { where.push('title LIKE @q'); args.q = `%${String(q.q).slice(0, 80)}%`; }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM play_log ${w}`).get(args).n;
    const rows = db.prepare(`SELECT * FROM play_log ${w} ORDER BY started_at DESC LIMIT @limit OFFSET @offset`).all({ ...args, limit, offset });
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id, user: r.user_name, profile: r.profile_name, title: r.title, platform: r.platform, ip: r.ip,
        startedAt: r.started_at, watchedSeconds: Math.round(r.watched_seconds), percent: pct(r), completed: !!r.completed,
      })),
    };
  });

  fastify.delete('/api/admin/playlog/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    db.prepare('DELETE FROM play_log WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  fastify.get('/api/admin/stats', async (req, reply) => {
    if (!guard(req, reply)) return;
    const days = Math.min(Math.max(parseInt((req.query || {}).days, 10) || 30, 1), 365);
    const since = Date.now() - days * 86400000;
    const PLAY = '(watched_seconds >= 30 OR completed = 1)';
    const base = `FROM play_log WHERE started_at >= ? AND ${PLAY}`;
    const totals = db.prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(watched_seconds),0) AS secs,
                               COUNT(DISTINCT user_name) AS users, COUNT(DISTINCT group_title) AS titles ${base}`).get(since);
    const perDayRaw = db.prepare(`SELECT date(started_at/1000,'unixepoch','localtime') AS d, COUNT(*) AS plays,
                                  SUM(watched_seconds) AS secs ${base} GROUP BY d`).all(since);
    const map = new Map(perDayRaw.map((r) => [r.d, r]));
    const perDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86400000);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const r = map.get(key);
      perDay.push({ date: key, plays: r ? r.plays : 0, hours: r ? +(r.secs / 3600).toFixed(2) : 0 });
    }
    const byHour = Array(24).fill(0); const byWeekday = Array(7).fill(0);
    for (const r of db.prepare(`SELECT CAST(strftime('%H', started_at/1000,'unixepoch','localtime') AS INT) AS h,
                                CAST(strftime('%w', started_at/1000,'unixepoch','localtime') AS INT) AS w, COUNT(*) AS n ${base} GROUP BY h, w`).all(since)) {
      byHour[r.h] += r.n; byWeekday[r.w] += r.n;
    }
    return {
      days,
      totals: { plays: totals.plays, hours: +(totals.secs / 3600).toFixed(1), users: totals.users, titles: totals.titles },
      perDay, byHour, byWeekday,
      topUsers: db.prepare(`SELECT user_name AS name, COUNT(*) AS plays, ROUND(SUM(watched_seconds)/3600.0,1) AS hours ${base}
                            GROUP BY user_name ORDER BY plays DESC LIMIT 10`).all(since),
      topTitles: db.prepare(`SELECT group_title AS name, COUNT(*) AS plays, ROUND(SUM(watched_seconds)/3600.0,1) AS hours ${base}
                             GROUP BY group_title ORDER BY plays DESC LIMIT 10`).all(since),
      platforms: db.prepare(`SELECT COALESCE(platform,'Other') AS name, COUNT(*) AS plays ${base} GROUP BY platform ORDER BY plays DESC`).all(since),
    };
  });
}

module.exports = { recordPlay, register, platformFromUA };
