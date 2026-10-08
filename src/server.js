// src/server.js
// Entry point: Fastify HTTP server exposing the media library API and
// HLS streaming endpoints described in the project plan:
//   GET  /api/library        -> list indexed media
//   GET  /api/library/:id    -> single item detail
//   POST /api/scan           -> trigger a library scan
//   GET  /api/stream/:id     -> HLS playlist + segments for playback
//   GET  /health             -> basic liveness check

const path = require('path');
const fs = require('fs');
const fastifyStatic = require('@fastify/static');
const cors = require('@fastify/cors');

// Server log, written to a file in addition to stdout (`docker logs` still
// works exactly as before — that's the `pino-pretty` target below, piped to
// stdout via destination 1) so Settings can offer a "Download Server Log"
// button (see GET /api/logs/download further down) that actually has a file
// to serve. Lives under DATA_DIR (the /config volume) so it survives
// container restarts/rebuilds, same as the SQLite database. `pino/file` is
// pino's own built-in raw-NDJSON-to-a-file transport — no extra dependency
// beyond pino-pretty, which fastify already pulls in.
const LOG_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(LOG_DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
// Cheap safeguard against the file growing forever on a long-running
// container: if it's already past 20MB when this process starts, archive
// it aside (one rotation is enough for "diagnose what just went wrong" —
// this isn't meant to be a long-term log archive) and start a fresh one.
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 20 * 1024 * 1024) {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
  }
} catch (err) {
  // Non-fatal either way — worst case the file just keeps growing.
}

const fastify = require('fastify')({
  logger: {
    transport: {
      targets: [
        { target: 'pino-pretty', options: { destination: 1 } },
        { target: 'pino/file', options: { destination: LOG_FILE, mkdir: true } },
      ],
    },
  },
});

const db = require('./db');
const { runScan, enrichUnmatched, backfillGenres, scanEvents, linkMediaGenres } = require('./scanner');
const { startHlsJob, listActiveJobs, stopJob, extractSubtitlesIfNeeded, startTranscodeCleanup } = require('./streamer');
const tmdb = require('./tmdb');
const ratings = require('./ratings');
const seerr = require('./seerr');
const config = require('./config');
const tailscale = require('./tailscale');
const auth = require('./auth');
const activity = require('./activity');
const autoscan = require('./autoscan');

// Plain X.Y.Z numeric comparison for the "Check for Updates" route —
// returns >0 if `a` is newer than `b`. Not full semver (no pre-release/
// build-metadata handling) since this project's own tags are always
// vX.Y.Z.
function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const PORT = process.env.PORT || 8080;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
// Must match streamer.js's TRANSCODE_DIR exactly — this is where ffmpeg
// actually writes HLS output, and it's what the Unraid compose file maps
// as a volume (/transcode). A hardcoded '../transcode' here would resolve
// to /app/transcode instead, a different (empty) directory inside the
// container, causing a 404 on the .m3u8 even though ffmpeg ran fine.
const TRANSCODE_DIR = process.env.TRANSCODE_DIR || path.join(__dirname, '..', 'transcode');

// Filters a list of media_items rows down to what a given profile is
// allowed to see, based on content_rating vs. the profile's
// max_content_rating. No profile_id (or an unknown one) means no filtering.
function filterByProfile(rows, profileId) {
  if (!profileId) return rows;
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  if (!profile || !profile.max_content_rating) return rows;
  return rows.filter((row) =>
    ratings.isAllowed(row.content_rating, profile.max_content_rating, Boolean(profile.is_child))
  );
}

// Rotates a list so the "first" item changes once a day instead of being
// permanently pinned to whatever a shelf sorts highest (rating DESC,
// alphabetical, ...). The full list is preserved and nothing is dropped —
// only the starting point shifts — so every item eventually leads, and a
// reload later the same day still shows the same order (no jitter).
function rotateForToday(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return arr;
  const dayIndex = Math.floor(Date.now() / 86400000);
  const offset = dayIndex % arr.length;
  return offset === 0 ? arr : arr.slice(offset).concat(arr.slice(0, offset));
}

// Used only by GET /api/raw/:id (the native-player direct-file route) —
// covers the container formats VYZN's scanner actually indexes; falls back
// to a generic binary type for anything else rather than guessing wrong.
function mimeTypeForVideoFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.mkv': 'video/x-matroska',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.ts': 'video/mp2t',
    '.wmv': 'video/x-ms-wmv',
  };
  return types[ext] || 'application/octet-stream';
}

// --- Movie detail page: TMDB credits/similar cache ------------------------
// Credits and "similar movies" barely ever change for a given film, so
// caching them avoids hitting TMDB every single time a detail page opens
// (and keeps the page snappy even if TMDB is slow/rate-limiting). The
// local-library join for "similar" is deliberately NOT cached — that
// depends on what's currently indexed, which changes far more often than
// a movie's cast does — only the raw TMDB response is.
const DETAIL_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

const getDetailCacheStmt = db.prepare(
  'SELECT * FROM tmdb_detail_cache WHERE tmdb_id = ? AND media_type = ?'
);
const upsertDetailCacheStmt = db.prepare(`
  INSERT INTO tmdb_detail_cache (tmdb_id, media_type, cast_json, director, writers_json, similar_json, similar_source, collection_json, trailer_key, fetched_at)
  VALUES (@tmdbId, @mediaType, @castJson, @director, @writersJson, @similarJson, @similarSource, @collectionJson, @trailerKey, datetime('now'))
  ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
    cast_json = excluded.cast_json, director = excluded.director,
    writers_json = excluded.writers_json, similar_json = excluded.similar_json,
    similar_source = excluded.similar_source, collection_json = excluded.collection_json,
    trailer_key = excluded.trailer_key, fetched_at = excluded.fetched_at
`);

// --- Show Detail page: theme music ----------------------------------------
// TMDB has no theme-song audio API (nor does any other free, reliable
// source) to fetch this from automatically, so this is a convention-based
// local lookup instead of a real TMDB call: if you want a show's theme to
// play on its detail page, drop an mp3 at
// public/theme-music/{tmdbId}.mp3 (find the tmdb_id via Settings -> Edit
// Match, or the show's TMDB URL) and it's picked up automatically next time
// that page loads — no server restart needed, this checks the filesystem
// on every request. No file there just means no theme plays; the frontend
// handles a missing/null themeUrl silently (see playThemeMusic in app.js).
const THEME_MUSIC_DIR = path.join(__dirname, '..', 'public', 'theme-music');
function getShowThemeUrl(tmdbId) {
  if (!tmdbId) return null;
  const filePath = path.join(THEME_MUSIC_DIR, `${tmdbId}.mp3`);
  try {
    return fs.existsSync(filePath) ? `/theme-music/${tmdbId}.mp3` : null;
  } catch (err) {
    return null;
  }
}

// Returns { cast, director, writers, similarRefs } for a movie, from cache
// when fresh, otherwise fetched from TMDB and cached for next time.
// `similarRefs` is TMDB's raw [{tmdbId, title}, ...] — still needs to be
// joined against the local library by the caller.
async function getMovieDetailData(tmdbId, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = getDetailCacheStmt.get(tmdbId, 'movie');
    // A row with no similar_source predates the /recommendations switch
    // (see db.js's comment on that column) — treat it as stale regardless
    // of age so every movie gets re-fetched under the better logic once,
    // instead of being stuck with /similar's weaker matches for up to a
    // year.
    if (cached && cached.similar_source) {
      const ageMs = Date.now() - new Date(`${cached.fetched_at}Z`).getTime();
      if (ageMs < DETAIL_CACHE_TTL_MS) {
        return {
          cast: JSON.parse(cached.cast_json || '[]'),
          director: cached.director,
          writers: JSON.parse(cached.writers_json || '[]'),
          similarRefs: JSON.parse(cached.similar_json || '[]'),
          collectionRefs: JSON.parse(cached.collection_json || '[]'),
          trailerKey: cached.trailer_key || null,
        };
      }
    }
  }

  // Only cache a result that actually came from TMDB successfully — a
  // network blip, rate limit, or auth hiccup must never get baked into the
  // 365-day cache as "this movie has no cast," which would otherwise be
  // indistinguishable from a genuinely empty result and stick around for a
  // year. On failure we log it (so it's visible in `docker logs`) and hand
  // back an empty-but-uncached result, so the very next page load tries
  // TMDB again instead of quietly staying broken.
  try {
    const [credits, recommended, collectionRefs, trailerKey] = await Promise.all([
      tmdb.getMovieCredits(tmdbId),
      tmdb.getMovieRecommendationsRaw(tmdbId),
      tmdb.getMovieCollection(tmdbId),
      tmdb.getTrailerKey(tmdbId, 'movie'),
    ]);

    // /recommendations (real "people who watched this also watched" data)
    // is noticeably more relevant than /similar (mostly shared genres/
    // keywords — how you end up with, say, Alien: Romulus next to Lilo &
    // Stitch). Only fall back to /similar for a title with no
    // recommendations data at all, so "More Like This" still shows
    // something rather than nothing.
    let similarRefs = recommended;
    let similarSource = 'recommendations';
    if (similarRefs.length === 0) {
      similarRefs = await tmdb.getSimilarMovies(tmdbId);
      similarSource = 'similar';
    }

    upsertDetailCacheStmt.run({
      tmdbId,
      mediaType: 'movie',
      castJson: JSON.stringify(credits.cast),
      director: credits.director,
      writersJson: JSON.stringify(credits.writers),
      similarJson: JSON.stringify(similarRefs),
      similarSource,
      collectionJson: JSON.stringify(collectionRefs),
      trailerKey,
    });
    return { cast: credits.cast, director: credits.director, writers: credits.writers, similarRefs, collectionRefs, trailerKey };
  } catch (err) {
    fastify.log.error(err, `Failed to fetch TMDB credits/similar for movie ${tmdbId} — not caching this failure`);
    return { cast: [], director: null, writers: [], similarRefs: [], collectionRefs: [], trailerKey: null };
  }
}

// TV counterpart to getMovieDetailData above, used by both the post-
// playback recommendations screen (getShowRecommendations below, which only
// needs similarRefs) and the Show Detail page (which also wants cast +
// creators). Cached in the same tmdb_detail_cache table under
// media_type='tv' (the table's primary key is (tmdb_id, media_type), so a
// movie and a show that happen to share a tmdb_id never collide). Shows
// have no single "director" credit, so that column is repurposed here to
// hold nothing (kept null) — creators are stored in writers_json instead,
// the closest existing column to "the people credited with making this,"
// rather than adding a show-only column for one extra field.
async function getShowDetailData(tmdbId, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = getDetailCacheStmt.get(tmdbId, 'tv');
    // A row with no cast_json predates the cast/creators fetch added for
    // the Show Detail page — treat it as stale regardless of age so every
    // show gets that data filled in once, instead of waiting up to a year.
    if (cached && cached.cast_json) {
      const ageMs = Date.now() - new Date(`${cached.fetched_at}Z`).getTime();
      if (ageMs < DETAIL_CACHE_TTL_MS) {
        return {
          cast: JSON.parse(cached.cast_json || '[]'),
          creators: JSON.parse(cached.writers_json || '[]'),
          similarRefs: JSON.parse(cached.similar_json || '[]'),
          trailerKey: cached.trailer_key || null,
        };
      }
    }
  }

  try {
    const [credits, recommended, trailerKey] = await Promise.all([
      tmdb.getShowCredits(tmdbId),
      tmdb.getTvRecommendationsRaw(tmdbId),
      tmdb.getTrailerKey(tmdbId, 'tv'),
    ]);
    let similarRefs = recommended;
    let similarSource = 'recommendations';
    if (similarRefs.length === 0) {
      similarRefs = await tmdb.getSimilarTv(tmdbId);
      similarSource = 'similar';
    }

    upsertDetailCacheStmt.run({
      tmdbId,
      mediaType: 'tv',
      castJson: JSON.stringify(credits.cast),
      director: null,
      writersJson: JSON.stringify(credits.creators),
      similarJson: JSON.stringify(similarRefs),
      similarSource,
      collectionJson: null,
      trailerKey,
    });
    return { cast: credits.cast, creators: credits.creators, similarRefs, trailerKey };
  } catch (err) {
    fastify.log.error(err, `Failed to fetch TMDB credits/recommendations for show ${tmdbId} — not caching this failure`);
    return { cast: [], creators: [], similarRefs: [], trailerKey: null };
  }
}

// Cross-references a movie's TMDB collection + "More Like This" refs
// against the local library, for the post-playback recommendation screen.
// Direct franchise entries (collectionRefs) are listed first — the "direct
// sequels/prequels before generic similar picks" ordering — followed by
// the same recommendation data "More Like This" already uses, capped at 5
// total. Only ever returns titles that actually exist locally, same as
// "More Like This", since this server can only offer to play what it has.
async function getMovieRecommendations(movie, profileId) {
  if (!movie.tmdb_id || !tmdb.isConfigured()) return [];
  const { collectionRefs, similarRefs } = await getMovieDetailData(movie.tmdb_id);
  const collectionIds = new Set(collectionRefs.map((r) => r.tmdbId));
  const orderedRefs = [...collectionRefs, ...similarRefs.filter((r) => !collectionIds.has(r.tmdbId))];
  if (!orderedRefs.length) return [];

  const tmdbIds = orderedRefs.map((r) => r.tmdbId);
  const placeholders = tmdbIds.map(() => '?').join(',');
  const localMatches = db.prepare(`
    SELECT * FROM media_items
    WHERE tmdb_id IN (${placeholders}) AND media_type = 'movie' AND id != ?
  `).all(...tmdbIds, movie.id);
  const filtered = filterByProfile(localMatches, profileId);
  const order = new Map(tmdbIds.map((id, idx) => [id, idx]));
  return filtered
    .sort((a, b) => order.get(a.tmdb_id) - order.get(b.tmdb_id))
    .slice(0, 5)
    .map((m) => ({ ...m, kind: 'movie' }));
}

// Show counterpart to getMovieRecommendations above — no franchise/
// collection concept for TV on TMDB, so this is just similarRefs cross-
// referenced against the local `tv_shows` table. Capped at 5 by default for
// the post-playback recommendations screen; the Show Detail page's "More
// Like This" shelf passes a higher limit since it has room for more than a
// tight end-of-playback grid does.
async function getShowRecommendations(show, profileId, limit = 5) {
  if (!show.tmdb_id || !tmdb.isConfigured()) return [];
  const { similarRefs } = await getShowDetailData(show.tmdb_id);
  if (!similarRefs.length) return [];

  const tmdbIds = similarRefs.map((r) => r.tmdbId);
  const placeholders = tmdbIds.map(() => '?').join(',');
  const localMatches = db.prepare(`
    SELECT s.*, COUNT(e.id) AS total_episodes
    FROM tv_shows s
    LEFT JOIN tv_episodes e ON e.show_id = s.id
    WHERE s.tmdb_id IN (${placeholders}) AND s.id != ?
    GROUP BY s.id
  `).all(...tmdbIds, show.id);

  let filtered = localMatches;
  if (profileId) {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (profile && profile.max_content_rating) {
      filtered = localMatches.filter((s) =>
        ratings.isAllowed(s.content_rating, profile.max_content_rating, Boolean(profile.is_child))
      );
    }
  }
  const order = new Map(tmdbIds.map((id, idx) => [id, idx]));
  return filtered
    .sort((a, b) => order.get(a.tmdb_id) - order.get(b.tmdb_id))
    .slice(0, limit)
    .map((s) => ({ ...s, kind: 'show' }));
}

// One-time self-heal on startup: earlier versions cached a TMDB
// credits/similar fetch failure as if it were a genuinely-empty result,
// baking "no cast, no crew, no similar" into the 365-day cache for any
// movie that happened to hit a transient TMDB error on its first detail-
// page open. Clearing those rows (rather than leaving them to expire in a
// year) lets the next detail-page open for that movie retry TMDB properly.
// Harmless to run every startup — matches nothing once the cache is clean.
function clearPoisonedDetailCache() {
  const result = db.prepare(`
    DELETE FROM tmdb_detail_cache
    WHERE (cast_json IS NULL OR cast_json = '[]')
      AND (similar_json IS NULL OR similar_json = '[]')
      AND director IS NULL
  `).run();
  if (result.changes > 0) {
    fastify.log.info(`Cleared ${result.changes} empty tmdb_detail_cache row(s) so they'll be retried against TMDB`);
  }
}

// Profile avatars are ids of the built-in set in public/assets/avatars/.
function cleanAvatar(v) {
  return typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v) ? v : null;
}

async function main() {
  clearPoisonedDetailCache();

  // credentials:true so the browser keeps sending the vyzn_auth cookie.
  await fastify.register(cors, { origin: true, credentials: true });
  auth.register(fastify);

  // Serve HLS segments/playlists as static files once ffmpeg has written them.
  await fastify.register(fastifyStatic, {
    root: TRANSCODE_DIR,
    prefix: '/stream-files/',
    decorateReply: false,
  });

  // Serve the browser frontend (public/index.html, app.js, style.css) at
  // the site root. Registered after /stream-files so its wildcard route
  // doesn't shadow that prefix; decorateReply is false here too since
  // only one static-plugin instance may add the reply.sendFile decorator.
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  fastify.get('/health', async () => ({ status: 'ok' }));

  // Streams the server log file back as a plain-text download (see the
  // LOG_FILE / pino/file transport setup at the top of this file) — the
  // "Download Server Log" button in Settings just links straight to this
  // URL with a `download` attribute, so this only ever needs to serve the
  // file, no auth/UI logic here.
  fastify.get('/api/logs/download', async (request, reply) => {
    if (!fs.existsSync(LOG_FILE)) {
      reply.code(404);
      return { error: 'No log file yet — the server needs to log at least once first.' };
    }
    const filename = `vyzn-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('text/plain; charset=utf-8');
    return fs.createReadStream(LOG_FILE);
  });

  // --- Settings ------------------------------------------------------

  // Read-only server/library info for the settings page: what's configured,
  // and a few at-a-glance counts. Doesn't expose secrets (no API keys).
  fastify.get('/api/settings', async () => {
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media_items) AS totalItems,
        (SELECT COUNT(*) FROM media_items WHERE media_type = 'movie') AS movieCount,
        (SELECT COUNT(*) FROM media_items WHERE media_type = 'tv') AS episodeCount,
        (SELECT COUNT(*) FROM media_items WHERE tmdb_id IS NULL) AS unmatchedCount,
        (SELECT COUNT(*) FROM tv_shows) AS showCount,
        (SELECT COUNT(*) FROM profiles) AS profileCount
    `).get();
    const lastScan = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').get();

    return {
      version: require('../package.json').version,
      mediaDir: MEDIA_DIR,
      transcodeDir: TRANSCODE_DIR,
      tmdbConfigured: tmdb.isConfigured(),
      seerrConfigured: seerr.isConfigured(),
      hwTranscode: config.getBool('HW_TRANSCODE', false),
      scanOnlyDirs: process.env.SCAN_ONLY_DIRS !== undefined ? process.env.SCAN_ONLY_DIRS : 'Movies,TvShows',
      probeConcurrency: parseInt(process.env.SCAN_PROBE_CONCURRENCY || '4', 10),
      tmdbConcurrency: parseInt(process.env.SCAN_TMDB_CONCURRENCY || '8', 10),
      counts,
      lastScan: lastScan || null,
    };
  });

  // Editable config: TMDB/Seerr/transcode values the Control Center
  // Settings panel can read and write without touching docker-compose.yml
  // or restarting the container (see src/config.js for the override-over-
  // env-var mechanics). Secrets come back masked — the client only ever
  // learns whether one is set, never its value — and the PUT route below
  // treats an unchanged masked field as "leave this one alone".
  fastify.get('/api/settings/config', async () => {
    return config.describeAll();
  });

  // "Check for Updates" — a manual check, not automatic/Watchtower-style,
  // per explicit choice: it compares this running image's baked-in
  // package.json version against the latest GitHub release tag, so
  // nothing is pulled or restarted without the person clicking the
  // button and then running `docker compose pull && docker compose up -d`
  // themselves (or their own update flow). UPDATE_REPO defaults to this
  // project's own repo but is overridable for a fork.
  fastify.get('/api/version', async () => {
    const current = require('../package.json').version;
    const repo = process.env.UPDATE_REPO || 'comsoll8/vyzn';
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vyzn-update-check' },
      });
      if (!res.ok) {
        return { current, latest: null, updateAvailable: false, error: `GitHub returned HTTP ${res.status}` };
      }
      const data = await res.json();
      const latest = (data.tag_name || '').replace(/^v/, '');
      return { current, latest: latest || null, updateAvailable: latest ? compareVersions(latest, current) > 0 : false, releaseUrl: data.html_url || null };
    } catch (err) {
      return { current, latest: null, updateAvailable: false, error: `Could not reach GitHub: ${err.message}` };
    }
  });

  fastify.put('/api/settings/config', async (request, reply) => {
    const body = request.body || {};
    const unknown = Object.keys(body).filter((k) => !(k in config.SCHEMA));
    if (unknown.length) {
      reply.code(400);
      return { error: `Unknown setting(s): ${unknown.join(', ')}` };
    }
    for (const [key, value] of Object.entries(body)) {
      // A secret field the user didn't touch still comes back from the
      // form holding the mask placeholder — skip it rather than
      // overwriting the real stored value with dots.
      if (config.SCHEMA[key].secret && value === config.SECRET_MASK) continue;
      config.set(key, value);
    }
    if ('AUTO_SCAN_MODE' in body || 'AUTO_SCAN_TIME' in body) autoscan.reconfigure();
    return config.describeAll();
  });

  // --- Tailscale -------------------------------------------------------

  // Status of the Tailscale client running inside this container (see
  // src/tailscale.js) — whether it's installed, logged in, and this
  // node's assigned Tailscale IP/hostname, for the Control Center panel.
  fastify.get('/api/tailscale/status', async () => {
    return tailscale.status();
  });

  // Brings Tailscale up using an auth key pasted into the Settings panel
  // (saved to config so reconnects/restarts don't need it re-entered).
  // Runs `tailscale up` inside this container — there's no separate
  // sidecar — so the container needs NET_ADMIN + /dev/net/tun, documented
  // in docker-compose.yml.
  fastify.post('/api/tailscale/connect', async (request, reply) => {
    const { authKey } = request.body || {};
    const key = authKey || config.get('TAILSCALE_AUTHKEY');
    if (!key) {
      reply.code(400);
      return { error: 'No Tailscale auth key provided or saved' };
    }
    if (authKey) config.set('TAILSCALE_AUTHKEY', authKey);
    try {
      const result = await tailscale.up(key);
      return result;
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  fastify.post('/api/tailscale/disconnect', async (request, reply) => {
    try {
      return await tailscale.down();
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // --- Library -------------------------------------------------------

  // Grid/shelf listing. When a profile is given, each row also carries that
  // profile's `completed` flag (via a 1:1 LEFT JOIN on playback_progress,
  // safe because (profile_id, media_id) is unique there) so cards can show
  // a "watched" checkmark the same way Continue Watching already can.
  fastify.get('/api/library', async (request) => {
    const { q, profile_id: profileId } = request.query;
    let rows;
    if (profileId) {
      const base = `
        SELECT m.*, p.completed
        FROM media_items m
        LEFT JOIN playback_progress p ON p.media_id = m.id AND p.profile_id = @profileId
        ${q ? 'WHERE m.title LIKE @q' : ''}
        ORDER BY m.title
      `;
      rows = db.prepare(base).all({ profileId, q: q ? `%${q}%` : null });
    } else if (q) {
      rows = db
        .prepare('SELECT * FROM media_items WHERE title LIKE ? ORDER BY title')
        .all(`%${q}%`);
    } else {
      rows = db.prepare('SELECT * FROM media_items ORDER BY title').all();
    }
    return filterByProfile(rows, profileId);
  });

  // Everything without a TMDB match yet, for the settings page's "Unmatched"
  // list — enough fields to show each item and let the user retry it with
  // a corrected title/media type without needing a rescan.
  fastify.get('/api/library/unmatched', async () => {
    return db.prepare(`
      SELECT id, title, file_path, media_type, added_at
      FROM media_items
      WHERE tmdb_id IS NULL
      ORDER BY title
    `).all();
  });

  fastify.get('/api/library/:id', async (request, reply) => {
    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get(request.params.id);
    if (!item) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return item;
  });

  // Full detail payload for the movie detail page: base item fields, its
  // genres, playback progress for the given profile, director/writers/top
  // cast (fetched live from TMDB — not stored locally, always current),
  // and "More Like This" — TMDB's similar-movies list filtered down to
  // whatever's actually in the local library (and rating-filtered for the
  // profile the same way the rest of the API is). TV episodes get the base
  // fields only; cast/crew/similar are a movie-detail-page concept.
  fastify.get('/api/library/:id/details', async (request, reply) => {
    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get(request.params.id);
    if (!item) {
      reply.code(404);
      return { error: 'Not found' };
    }

    const { profile_id: profileId } = request.query;

    const genres = db.prepare(`
      SELECT g.id, g.name FROM genres g
      JOIN media_genres mg ON mg.genre_id = g.id
      WHERE mg.media_id = ?
      ORDER BY g.name ASC
    `).all(item.id);

    const progress = profileId
      ? db.prepare(`
          SELECT position_seconds, duration_seconds, completed
          FROM playback_progress WHERE profile_id = ? AND media_id = ?
        `).get(profileId, item.id) || null
      : null;

    let cast = [];
    let director = null;
    let writers = [];
    let similar = [];
    let trailerKey = null;

    if (item.media_type === 'movie' && item.tmdb_id && tmdb.isConfigured()) {
      const forceRefresh = request.query.refresh === 'true';
      const { cast: cachedCast, director: cachedDirector, writers: cachedWriters, similarRefs, trailerKey: cachedTrailerKey } =
        await getMovieDetailData(item.tmdb_id, { forceRefresh });
      cast = cachedCast;
      director = cachedDirector;
      writers = cachedWriters;
      trailerKey = cachedTrailerKey || null;

      if (similarRefs.length) {
        const tmdbIds = similarRefs.map((r) => r.tmdbId);
        const placeholders = tmdbIds.map(() => '?').join(',');
        const localMatches = db.prepare(`
          SELECT * FROM media_items
          WHERE tmdb_id IN (${placeholders}) AND media_type = 'movie' AND id != ?
        `).all(...tmdbIds, item.id);
        const filtered = filterByProfile(localMatches, profileId);
        // Preserve TMDB's own relevance ordering rather than whatever
        // order SQLite's IN() happened to return.
        const order = new Map(tmdbIds.map((id, idx) => [id, idx]));
        similar = filtered.sort((a, b) => order.get(a.tmdb_id) - order.get(b.tmdb_id));
      }
    }

    const inWatchlist = profileId
      ? Boolean(db.prepare(
          `SELECT 1 FROM watchlist WHERE profile_id = ? AND item_id = ? AND item_type = 'movie'`
        ).get(profileId, item.id))
      : false;

    return { ...item, genres, progress, director, writers, cast, similar, trailerKey, inWatchlist };
  });

  // --- Scan ------------------------------------------------------------

  fastify.post('/api/scan', async (request, reply) => {
    // Fire-and-return: scanning can take a while for large libraries, so
    // we kick it off and let the client poll /api/library or /api/scan/status.
    runScan().catch((err) => fastify.log.error(err, 'Scan failed'));
    reply.code(202);
    return { status: 'scan_started', mediaDir: MEDIA_DIR };
  });

  // Automatic scanning (src/autoscan.js): current mode/time plus when it
  // last ran / will run next. Changing it goes through PUT /api/settings/config.
  fastify.get('/api/autoscan', async () => ({
    ...autoscan.status(),
  }));

  fastify.get('/api/scan/status', async () => {
    const last = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').get();
    return last || { status: 'never_run' };
  });

  // Live scan progress via Server-Sent Events. The scanner emits 'progress'
  // events (walking/probing/matching/complete/error) on the shared
  // `scanEvents` emitter; each connected client just gets them relayed as
  // they happen. Multiple tabs can watch the same scan at once.
  fastify.get('/api/scan/progress', async (request, reply) => {
    // Take full manual control of the raw response — this is a long-lived
    // stream, not a normal request/response cycle, so Fastify shouldn't try
    // to finalize/serialize a reply once this handler returns.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // avoid proxy buffering (e.g. behind nginx)
    });
    reply.raw.write('\n');

    const send = (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Let the client know immediately whether a scan is already running.
    const last = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').get();
    send({ stage: last && last.status === 'running' ? 'running' : 'idle' });

    const onProgress = (event) => send(event);
    scanEvents.on('progress', onProgress);

    // Keep intermediate proxies/load balancers from timing out the connection.
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      scanEvents.off('progress', onProgress);
      reply.raw.end();
    });
  });

  // Bulk-delete library rows whose file_path contains a given substring.
  // Meant for one-off cleanup, e.g. removing everything indexed from a
  // Recycle Bin or Downloads folder before the scanner was told to skip
  // those: {"path_contains": "/.Trash-"}. Does not touch files on disk.
  fastify.post('/api/library/purge', async (request, reply) => {
    const pathContains = request.body && request.body.path_contains;
    if (!pathContains || typeof pathContains !== 'string' || pathContains.length < 3) {
      reply.code(400);
      return { error: 'Provide {"path_contains": "<substring>"} with at least 3 characters' };
    }
    const result = db
      .prepare('DELETE FROM media_items WHERE file_path LIKE ?')
      .run(`%${pathContains}%`);
    return { deleted: result.changes };
  });

  // Wipe the entire library (metadata only — never touches files on disk),
  // for a clean re-scan. Requires ?confirm=true to avoid accidental calls.
  fastify.delete('/api/library', async (request, reply) => {
    if (request.query.confirm !== 'true') {
      reply.code(400);
      return { error: 'Pass ?confirm=true to wipe the entire library' };
    }
    const result = db.prepare('DELETE FROM media_items').run();
    return { deleted: result.changes };
  });

  // Re-run the TMDB match for one item (useful when the auto-match on a
  // messy filename got it wrong, or picked the wrong year).
  fastify.post('/api/library/:id/rematch', async (request, reply) => {
    if (!tmdb.isConfigured()) {
      reply.code(400);
      return { error: 'TMDB_API_KEY is not configured on the server' };
    }
    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get(request.params.id);
    if (!item) {
      reply.code(404);
      return { error: 'Not found' };
    }

    const query = request.body && request.body.title ? request.body.title : item.title;
    const forcedType = request.body && request.body.media_type; // optional override: 'movie' | 'tv'
    const lookup = (forcedType || item.media_type) === 'tv' ? tmdb.lookupTv : tmdb.lookupMovie;
    const match = await lookup(query);
    if (!match) {
      reply.code(404);
      return { error: 'No TMDB match found' };
    }

    db.prepare(`
      UPDATE media_items SET
        tmdb_id = @tmdbId, tmdb_matched_title = @matchedTitle, poster_url = @posterUrl,
        backdrop_url = @backdropUrl, overview = @overview, release_year = @releaseYear,
        rating = @rating, media_type = @mediaType, content_rating = @contentRating,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({ id: item.id, ...match });

    // Only a movie rematch carries genres directly on `match` — a TV
    // episode's genres live on its show, which this per-episode override
    // doesn't touch.
    if (match.mediaType !== 'tv' && match.genres && match.genres.length) {
      linkMediaGenres(item.id, match.genres);
    }

    return db.prepare('SELECT * FROM media_items WHERE id = ?').get(item.id);
  });

  // Retry TMDB matching for every item that doesn't have a match yet,
  // without re-scanning the filesystem or re-running ffprobe. Useful
  // after a tmdb.js title-cleaning fix, so a slow full rescan doesn't
  // need to be re-run just to pick up better matches. Runs in the
  // background like /api/scan; poll /api/library to watch it progress.
  fastify.post('/api/library/retry-unmatched', async (request, reply) => {
    if (!tmdb.isConfigured()) {
      reply.code(400);
      return { error: 'TMDB_API_KEY is not configured on the server' };
    }
    const candidateCount = db
      .prepare('SELECT COUNT(*) AS c FROM media_items WHERE tmdb_id IS NULL')
      .get().c;

    enrichUnmatched().catch((err) => fastify.log.error(err, 'retry-unmatched background job failed'));

    reply.code(202);
    return { status: 'retry_started', candidates: candidateCount };
  });

  // Re-fetch genres for every already-matched movie/show, without touching
  // anything else. Needed because genre tagging only happens as part of
  // the normal TMDB-matching pass, which skips anything that already has a
  // tmdb_id — so a library matched before genres existed would otherwise
  // never get tagged short of a full metadata rescan. Runs in the
  // background like scan/retry-unmatched; progress shows on the same bar.
  fastify.post('/api/library/backfill-genres', async (request, reply) => {
    if (!tmdb.isConfigured()) {
      reply.code(400);
      return { error: 'TMDB_API_KEY is not configured on the server' };
    }
    const candidateCount = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media_items WHERE media_type = 'movie' AND tmdb_id IS NOT NULL) +
        (SELECT COUNT(*) FROM tv_shows WHERE tmdb_id IS NOT NULL) AS c
    `).get().c;

    backfillGenres().catch((err) => fastify.log.error(err, 'genre backfill background job failed'));

    reply.code(202);
    return { status: 'backfill_started', candidates: candidateCount };
  });

  // --- Profiles ----------------------------------------------------------

  fastify.get('/api/profiles', async (request) => {
    if (auth.hasUsers()) return auth.listProfiles(request.user.id);
    return db.prepare('SELECT * FROM profiles ORDER BY id').all();
  });

  fastify.post('/api/profiles', async (request, reply) => {
    const { name, avatar, is_child: isChild, max_content_rating: maxRating } = request.body || {};
    if (!name || typeof name !== 'string') {
      reply.code(400);
      return { error: 'Provide {"name": "..."}' };
    }
    const result = db
      .prepare('INSERT INTO profiles (name, avatar, is_child, max_content_rating, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(name, cleanAvatar(avatar), isChild ? 1 : 0, maxRating || null, request.user ? request.user.id : null);
    return db.prepare('SELECT * FROM profiles WHERE id = ?').get(result.lastInsertRowid);
  });

  fastify.put('/api/profiles/:id', async (request, reply) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(request.params.id);
    if (!profile) {
      reply.code(404);
      return { error: 'Not found' };
    }
    const body = request.body || {};
    const merged = {
      name: body.name !== undefined ? body.name : profile.name,
      avatar: body.avatar !== undefined ? cleanAvatar(body.avatar) : profile.avatar,
      is_child: body.is_child !== undefined ? (body.is_child ? 1 : 0) : profile.is_child,
      max_content_rating: body.max_content_rating !== undefined ? body.max_content_rating : profile.max_content_rating,
    };
    db.prepare(
      'UPDATE profiles SET name = @name, avatar = @avatar, is_child = @is_child, max_content_rating = @max_content_rating WHERE id = @id'
    ).run({ id: profile.id, ...merged });
    return db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id);
  });

  fastify.delete('/api/profiles/:id', async (request, reply) => {
    const result = db.prepare('DELETE FROM profiles WHERE id = ?').run(request.params.id);
    if (result.changes === 0) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return { deleted: true };
  });

  // --- Playback progress ("Continue Watching") ----------------------------

  // Record/update how far a profile got into an item. Called periodically
  // (e.g. every 10-30s) by the player, and once more on pause/close.
  fastify.post('/api/profiles/:profileId/progress', async (request, reply) => {
    const profileId = Number(request.params.profileId);
    const { media_id: mediaId, position_seconds: position, duration_seconds: duration } = request.body || {};
    if (!mediaId || position === undefined || !duration) {
      reply.code(400);
      return { error: 'Provide {"media_id", "position_seconds", "duration_seconds"}' };
    }
    const pct = duration > 0 ? position / duration : 0;
    const completed = pct >= 0.9 ? 1 : 0;

    db.prepare(`
      INSERT INTO playback_progress (profile_id, media_id, position_seconds, duration_seconds, completed, last_watched_at)
      VALUES (@profileId, @mediaId, @position, @duration, @completed, datetime('now'))
      ON CONFLICT(profile_id, media_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = excluded.completed,
        last_watched_at = datetime('now')
    `).run({ profileId, mediaId, position, duration, completed });

    activity.recordPlay({
      profileId, mediaId, position, duration, completed,
      user: request.user, ua: request.headers['user-agent'], ip: request.ip,
    });
    return { ok: true, completed: Boolean(completed) };
  });

  // "Continue Watching" shelf: items between 5% and 90% watched, most
  // recent first. Below 5% isn't meaningfully "in progress" yet; above
  // 90% counts as finished and drops off this list.
  fastify.get('/api/profiles/:profileId/continue-watching', async (request) => {
    const profileId = Number(request.params.profileId);
    const rows = db.prepare(`
      SELECT m.*, p.position_seconds, p.duration_seconds, p.last_watched_at
      FROM playback_progress p
      JOIN media_items m ON m.id = p.media_id
      WHERE p.profile_id = ?
        AND p.completed = 0
        AND p.duration_seconds > 0
        AND (p.position_seconds * 1.0 / p.duration_seconds) >= 0.05
        AND (p.position_seconds * 1.0 / p.duration_seconds) < 0.9
      ORDER BY p.last_watched_at DESC
      LIMIT 20
    `).all(profileId);
    return rows;
  });

  // "Because you watched X" carousels: one per each of the profile's last
  // few completed items, built from TMDB's recommendations endpoint.
  //
  // TMDB's recommendations have no idea what's actually in this library, so
  // every result is cross-referenced back against media_items/tv_shows by
  // tmdb_id. A match gets the local row's real id/poster/etc merged in
  // (`owned: true`) so its card behaves exactly like any other library
  // card; a miss is normalized into the same snake_case shape the rest of
  // the app expects (`owned: false`, no local `id`) so the frontend can
  // still render its poster/title/year and offer a "Request" action
  // instead of Play. Previously these were returned as TMDB's raw
  // camelCase objects (posterUrl/releaseYear/etc), which every card
  // component here ignores (they read poster_url/release_year) — that
  // mismatch is why unowned recommendations rendered as blank
  // no-poster placeholders instead of real cards.
  fastify.get('/api/profiles/:profileId/recommendations', async (request) => {
    const profileId = Number(request.params.profileId);
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);

    const recentlyCompleted = db.prepare(`
      SELECT m.* FROM playback_progress p
      JOIN media_items m ON m.id = p.media_id
      WHERE p.profile_id = ? AND p.completed = 1 AND m.tmdb_id IS NOT NULL
      ORDER BY p.last_watched_at DESC
      LIMIT 3
    `).all(profileId);

    const findLocalMovie = db.prepare(
      "SELECT id, poster_url, release_year, tmdb_matched_title, title FROM media_items WHERE tmdb_id = ? AND media_type = 'movie' LIMIT 1"
    );
    const findLocalShow = db.prepare(`
      SELECT s.*, COUNT(e.id) AS total_episodes
      FROM tv_shows s
      LEFT JOIN tv_episodes e ON e.show_id = s.id
      WHERE s.tmdb_id = ?
      GROUP BY s.id
    `);

    const shelves = [];
    for (const item of recentlyCompleted) {
      const recs = await tmdb.getRecommendations(item.tmdb_id, item.media_type);
      if (recs.length === 0) continue;

      const normalized = recs.map((r) => {
        if (r.mediaType === 'tv') {
          const local = findLocalShow.get(r.tmdbId);
          if (local) {
            return { ...local, kind: 'show', owned: true };
          }
          return {
            tmdb_id: r.tmdbId,
            media_type: 'tv',
            kind: 'show',
            owned: false,
            title: r.title,
            overview: r.overview,
            poster_url: r.posterUrl,
            backdrop_url: r.backdropUrl,
            release_year: r.releaseYear,
          };
        }
        const local = findLocalMovie.get(r.tmdbId);
        if (local) {
          return { ...local, media_type: 'movie', owned: true };
        }
        return {
          tmdb_id: r.tmdbId,
          media_type: 'movie',
          owned: false,
          title: r.title,
          overview: r.overview,
          poster_url: r.posterUrl,
          backdrop_url: r.backdropUrl,
          release_year: r.releaseYear,
        };
      });

      // Content-rating gating only applies to unowned items — an owned
      // item is already in this library and subject to the same rating
      // filter everywhere else it's shown, so re-filtering it here would
      // just make an already-approved title inconsistently disappear from
      // this one shelf.
      const filtered = profile
        ? normalized.filter((r) => r.owned || ratings.isAllowed(r.content_rating, profile.max_content_rating, Boolean(profile.is_child)))
        : normalized;
      if (filtered.length === 0) continue;
      shelves.push({
        basedOn: item.tmdb_matched_title || item.title,
        items: filtered.slice(0, 15),
      });
    }
    return shelves;
  });

  // One-click "request this on Seerr" for a recommendation card the user
  // doesn't already own. Body: { tmdbId, mediaType }.
  fastify.post('/api/seerr/request', async (request, reply) => {
    if (!seerr.isConfigured()) {
      reply.code(400);
      return { error: 'Seerr is not configured on the server (set SEERR_URL and SEERR_API_KEY)' };
    }
    const { tmdbId, mediaType } = request.body || {};
    if (!tmdbId) {
      reply.code(400);
      return { error: 'tmdbId is required' };
    }
    try {
      await seerr.requestMedia(tmdbId, mediaType);
      return { ok: true };
    } catch (err) {
      if (err.alreadyRequested) {
        return { ok: true, alreadyRequested: true };
      }
      reply.code(502);
      return { error: err.message };
    }
  });

  // Extends the search box past the local library into "things you could
  // add" — proxies Seerr's own /search (itself a TMDB search wrapper that
  // also knows what's already requested/available on that Seerr instance).
  // Same owned-vs-not normalization as /recommendations above: a hit that's
  // actually already in this library gets the real local row merged in
  // (owned: true, plays/opens like any other card) instead of showing a
  // separate, confusing "add it" card for something already sitting in the
  // library. profile_id is optional but strongly recommended — without it,
  // content-rating gating is skipped entirely (an unowned result has no
  // local content_rating of its own to check).
  fastify.get('/api/seerr/search', async (request) => {
    if (!seerr.isConfigured()) return [];
    const query = String(request.query.query || '').trim();
    if (!query) return [];

    const profileId = Number(request.query.profile_id);
    const profile = profileId ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) : null;

    let results;
    try {
      results = await seerr.search(query);
    } catch (err) {
      fastify.log.error(err, 'Seerr search failed');
      return [];
    }

    const findLocalMovie = db.prepare(
      "SELECT id, poster_url, release_year, tmdb_matched_title, title FROM media_items WHERE tmdb_id = ? AND media_type = 'movie' LIMIT 1"
    );
    const findLocalShow = db.prepare(`
      SELECT s.*, COUNT(e.id) AS total_episodes
      FROM tv_shows s
      LEFT JOIN tv_episodes e ON e.show_id = s.id
      WHERE s.tmdb_id = ?
      GROUP BY s.id
    `);

    const normalized = results.map((r) => {
      if (r.mediaType === 'tv') {
        const local = findLocalShow.get(r.tmdbId);
        if (local) return { ...local, kind: 'show', owned: true };
        return {
          tmdb_id: r.tmdbId,
          media_type: 'tv',
          kind: 'show',
          owned: false,
          title: r.title,
          overview: r.overview,
          poster_url: r.posterUrl,
          backdrop_url: r.backdropUrl,
          release_year: r.releaseYear,
          already_available: r.alreadyAvailable,
          already_requested: r.alreadyRequested,
        };
      }
      const local = findLocalMovie.get(r.tmdbId);
      if (local) return { ...local, media_type: 'movie', owned: true };
      return {
        tmdb_id: r.tmdbId,
        media_type: 'movie',
        owned: false,
        title: r.title,
        overview: r.overview,
        poster_url: r.posterUrl,
        backdrop_url: r.backdropUrl,
        release_year: r.releaseYear,
        already_available: r.alreadyAvailable,
        already_requested: r.alreadyRequested,
      };
    });

    const filtered = profile
      ? normalized.filter((r) => r.owned || ratings.isAllowed(r.content_rating, profile.max_content_rating, Boolean(profile.is_child)))
      : normalized;
    return filtered.slice(0, 20);
  });

  // Simple "Trending" shelf: highest-rated matched movies plus shows, as a
  // stand-in for real trending data (this server has no viewing stats
  // across all households to base "trending" on). Movies and shows are
  // mixed into one shelf — each row tagged `kind` so the frontend knows
  // which card/detail-page to use — the same way a genre shelf already
  // mixes them. Shows have no `rating` column (TMDB's per-show score
  // isn't stored locally), so they can't be sorted into the same
  // highest-rated-first order as movies; they're just appended by title
  // and the whole list is rotated daily (rotateForToday, same as every
  // other shelf) so shows aren't permanently stuck at the end.
  fastify.get('/api/profiles/:profileId/trending', async (request) => {
    const profileId = Number(request.params.profileId);
    const movies = db.prepare(`
      SELECT m.*, p.completed, 'movie' AS kind
      FROM media_items m
      LEFT JOIN playback_progress p ON p.media_id = m.id AND p.profile_id = @profileId
      WHERE m.tmdb_id IS NOT NULL
      ORDER BY m.rating DESC LIMIT 22
    `).all({ profileId });
    const shows = db.prepare(`
      SELECT s.*, COUNT(e.id) AS total_episodes, 'show' AS kind
      FROM tv_shows s
      LEFT JOIN tv_episodes e ON e.show_id = s.id
      GROUP BY s.id
      ORDER BY s.title ASC LIMIT 8
    `).all();
    const rows = [...movies, ...shows];
    return rotateForToday(filterByProfile(rows, profileId));
  });

  // Removes a profile's playback progress for one item — used both for
  // "Remove from Continue Watching" (just drops the row, nothing else to
  // do) and "Restart from Beginning" (the frontend deletes the old
  // progress here, then starts playback fresh at position 0, so the next
  // progress report creates a brand new row instead of resuming).
  fastify.delete('/api/profiles/:profileId/progress/:mediaId', async (request) => {
    const profileId = Number(request.params.profileId);
    const mediaId = Number(request.params.mediaId);
    db.prepare('DELETE FROM playback_progress WHERE profile_id = ? AND media_id = ?').run(profileId, mediaId);
    return { ok: true };
  });

  // --- Watchlist -----------------------------------------------------------
  // A profile's saved-for-later list, for the movie/show detail pages'
  // bookmark toggle. item_type is 'movie' (media_items.id) or 'tv'
  // (tv_shows.id) — see db.js's comment on the watchlist table for why
  // those aren't two separate FK columns.

  fastify.get('/api/profiles/:profileId/watchlist', async (request) => {
    const profileId = Number(request.params.profileId);
    const rows = db.prepare('SELECT item_id, item_type, added_at FROM watchlist WHERE profile_id = ? ORDER BY added_at DESC').all(profileId);

    const movieIds = rows.filter((r) => r.item_type === 'movie').map((r) => r.item_id);
    const showIds = rows.filter((r) => r.item_type === 'tv').map((r) => r.item_id);

    const movies = movieIds.length
      ? db.prepare(`SELECT * FROM media_items WHERE id IN (${movieIds.map(() => '?').join(',')})`).all(...movieIds)
      : [];
    const shows = showIds.length
      ? db.prepare(`
          SELECT s.*, COUNT(e.id) AS total_episodes FROM tv_shows s
          LEFT JOIN tv_episodes e ON e.show_id = s.id
          WHERE s.id IN (${showIds.map(() => '?').join(',')})
          GROUP BY s.id
        `).all(...showIds)
      : [];

    // Preserve the watchlist's own most-recently-added-first ordering
    // rather than whichever order the two IN() queries happened to return.
    const order = new Map(rows.map((r, idx) => [`${r.item_type}:${r.item_id}`, idx]));
    const combined = [
      ...movies.map((m) => ({ ...m, kind: 'movie' })),
      ...shows.map((s) => ({ ...s, kind: 'show' })),
    ];
    combined.sort((a, b) => {
      const aKey = a.kind === 'movie' ? `movie:${a.id}` : `tv:${a.id}`;
      const bKey = b.kind === 'movie' ? `movie:${b.id}` : `tv:${b.id}`;
      return order.get(aKey) - order.get(bKey);
    });
    return filterByProfile(combined, profileId);
  });

  fastify.post('/api/profiles/:profileId/watchlist', async (request, reply) => {
    const profileId = Number(request.params.profileId);
    const { item_id: itemId, item_type: itemType } = request.body || {};
    if (!itemId || (itemType !== 'movie' && itemType !== 'tv')) {
      reply.code(400);
      return { error: 'Provide {"item_id", "item_type": "movie"|"tv"}' };
    }
    db.prepare(`
      INSERT INTO watchlist (profile_id, item_id, item_type, added_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(profile_id, item_id, item_type) DO NOTHING
    `).run(profileId, itemId, itemType);
    return { ok: true, inWatchlist: true };
  });

  fastify.delete('/api/profiles/:profileId/watchlist/:itemType/:itemId', async (request, reply) => {
    const profileId = Number(request.params.profileId);
    const { itemType, itemId } = request.params;
    if (itemType !== 'movie' && itemType !== 'tv') {
      reply.code(400);
      return { error: 'item_type must be "movie" or "tv"' };
    }
    db.prepare('DELETE FROM watchlist WHERE profile_id = ? AND item_id = ? AND item_type = ?').run(profileId, Number(itemId), itemType);
    return { ok: true, inWatchlist: false };
  });

  // --- Post-playback: "Up Next" / end-of-playback recommendations --------
  //
  // Called by the player once a title finishes (or is about to — see
  // app.js's near-end/`ended` handling). Two possible shapes come back,
  // both under one endpoint so the frontend doesn't need to already know
  // which case it's in before asking:
  //   { type: 'episode', episode: {...} }         — an episode just
  //     finished and there's a next one (same season, or season+1 ep 1).
  //   { type: 'recommendations', items: [...up to 5] } — a movie finished,
  //     or an episode finished and it was the last one in the show.
  fastify.get('/api/playback/:mediaId/next', async (request, reply) => {
    const mediaId = Number(request.params.mediaId);
    const { profile_id: profileId } = request.query;

    const episodeCtx = db.prepare(`
      SELECT e.id AS episode_id, e.episode_number, e.season_id,
             s.season_number, s.show_id
      FROM tv_episodes e
      JOIN tv_seasons s ON s.id = e.season_id
      WHERE e.media_item_id = ?
    `).get(mediaId);

    const nextEpisodeQuery = `
      SELECT e.*, m.id AS media_id, m.poster_url AS fallback_poster,
             m.duration_sec, m.audio_tracks, sh.title AS show_title, sh.id AS show_id,
             s.season_number
      FROM tv_episodes e
      JOIN media_items m ON m.id = e.media_item_id
      JOIN tv_seasons s ON s.id = e.season_id
      JOIN tv_shows sh ON sh.id = s.show_id
      WHERE e.season_id = @seasonId AND e.episode_number = @episodeNumber
    `;

    if (episodeCtx) {
      let next = db.prepare(nextEpisodeQuery).get({
        seasonId: episodeCtx.season_id,
        episodeNumber: episodeCtx.episode_number + 1,
      });

      if (!next) {
        const nextSeason = db.prepare(`
          SELECT * FROM tv_seasons WHERE show_id = ? AND season_number > ?
          ORDER BY season_number ASC LIMIT 1
        `).get(episodeCtx.show_id, episodeCtx.season_number);
        if (nextSeason) {
          next = db.prepare(nextEpisodeQuery).get({ seasonId: nextSeason.id, episodeNumber: 1 });
        }
      }

      const show = db.prepare('SELECT * FROM tv_shows WHERE id = ?').get(episodeCtx.show_id);

      // Rating-gate the next episode the same way everything else is —
      // episodes don't carry their own content_rating, the show's does.
      const profile = profileId ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) : null;
      const nextAllowed = next && (!profile || !profile.max_content_rating ||
        ratings.isAllowed(show.content_rating, profile.max_content_rating, Boolean(profile.is_child)));

      if (next && nextAllowed) {
        return {
          type: 'episode',
          episode: {
            id: next.media_id,
            media_id: next.media_id,
            title: next.title,
            overview: next.overview,
            episode_number: next.episode_number,
            season_number: next.season_number,
            show_id: next.show_id,
            show_title: next.show_title,
            still_url: next.still_url || next.fallback_poster,
            duration_seconds: next.duration_sec,
            audio_tracks: next.audio_tracks,
          },
        };
      }

      // No more (allowed) episodes in the show — end of series/season.
      return { type: 'recommendations', items: await getShowRecommendations(show, profileId) };
    }

    // Not an episode — a movie just finished.
    const movie = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId);
    if (!movie) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return { type: 'recommendations', items: await getMovieRecommendations(movie, profileId) };
  });

  // --- TV shows / seasons / episodes --------------------------------------

  // List all indexed shows with an episode count, optionally rating-filtered
  // for a profile the same way /api/library is.
  fastify.get('/api/shows', async (request) => {
    const { profile_id: profileId } = request.query;
    const shows = db.prepare(`
      SELECT s.*, COUNT(e.id) AS total_episodes
      FROM tv_shows s
      LEFT JOIN tv_episodes e ON s.id = e.show_id
      GROUP BY s.id
      ORDER BY s.title
    `).all();
    if (!profileId) return shows;
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile || !profile.max_content_rating) return shows;
    return shows.filter((s) => ratings.isAllowed(s.content_rating, profile.max_content_rating, Boolean(profile.is_child)));
  });

  // Full show detail: seasons, each with its episodes. Each episode carries
  // its underlying media_items id as `media_id` (what /api/stream/:id and
  // /api/profiles/:id/progress expect), plus any playback progress for the
  // given profile so the UI can show per-episode progress bars.
  fastify.get('/api/shows/:id', async (request, reply) => {
    const show = db.prepare('SELECT * FROM tv_shows WHERE id = ?').get(request.params.id);
    if (!show) {
      reply.code(404);
      return { error: 'Show not found' };
    }

    const { profile_id: profileId } = request.query;
    const seasons = db
      .prepare('SELECT * FROM tv_seasons WHERE show_id = ? ORDER BY season_number ASC')
      .all(show.id);

    for (const season of seasons) {
      season.episodes = db.prepare(`
        SELECT
          e.id, e.episode_number, e.title, e.overview, e.still_url, e.air_date,
          m.id AS media_id, m.file_path, m.duration_sec, m.resolution, m.poster_url,
          m.content_rating, m.audio_tracks
          ${profileId ? ', p.position_seconds, p.duration_seconds, p.completed' : ''}
        FROM tv_episodes e
        JOIN media_items m ON m.id = e.media_item_id
        ${profileId ? 'LEFT JOIN playback_progress p ON p.media_id = m.id AND p.profile_id = @profileId' : ''}
        WHERE e.season_id = @seasonId
        ORDER BY e.episode_number ASC
      `).all({ seasonId: season.id, profileId: profileId || null });
    }

    return { ...show, seasons };
  });

  // Show Detail page data: genres, season count, an approximate air-year
  // range, cast/creators, theme music (if any), and a "More Like This"
  // shelf — everything /api/shows/:id doesn't already cover. Kept as a
  // separate endpoint (mirroring /api/library/:id/details for movies)
  // rather than folded into /api/shows/:id, so opening the season/episode
  // list doesn't always also pay for a TMDB round-trip.
  fastify.get('/api/shows/:id/details', async (request, reply) => {
    const show = db.prepare('SELECT * FROM tv_shows WHERE id = ?').get(request.params.id);
    if (!show) {
      reply.code(404);
      return { error: 'Show not found' };
    }

    const { profile_id: profileId } = request.query;

    const genres = db.prepare(`
      SELECT g.id, g.name FROM genres g
      JOIN show_genres sg ON sg.genre_id = g.id
      WHERE sg.show_id = ?
      ORDER BY g.name ASC
    `).all(show.id);

    const seasonCount = db.prepare('SELECT COUNT(*) AS c FROM tv_seasons WHERE show_id = ?').get(show.id).c;

    // VYZN doesn't track a show's official "ended"/"continuing" status (that
    // would mean caching yet another TMDB field just for this one label),
    // so the end year is approximated from the most recent episode air date
    // actually indexed locally — good enough for "2019-2023" at a glance,
    // though a show could air later seasons TMDB knows about that just
    // haven't been added to this library yet.
    const startYear = show.first_air_date ? parseInt(show.first_air_date.slice(0, 4), 10) : null;
    const latestAirDate = db.prepare(`
      SELECT MAX(e.air_date) AS latest FROM tv_episodes e
      JOIN tv_seasons se ON se.id = e.season_id
      WHERE se.show_id = ?
    `).get(show.id).latest;
    const endYear = latestAirDate ? parseInt(latestAirDate.slice(0, 4), 10) : null;
    let yearRange = null;
    if (startYear && endYear && endYear !== startYear) yearRange = `${startYear}–${endYear}`;
    else if (startYear) yearRange = `${startYear}`;

    let cast = [];
    let creators = [];
    let similar = [];
    let trailerKey = null;

    if (show.tmdb_id && tmdb.isConfigured()) {
      const forceRefresh = request.query.refresh === 'true';
      const detailData = await getShowDetailData(show.tmdb_id, { forceRefresh });
      cast = detailData.cast;
      creators = detailData.creators;
      trailerKey = detailData.trailerKey || null;
      similar = await getShowRecommendations(show, profileId, 10);
    }

    const themeUrl = getShowThemeUrl(show.tmdb_id);

    const inWatchlist = profileId
      ? Boolean(db.prepare(
          `SELECT 1 FROM watchlist WHERE profile_id = ? AND item_id = ? AND item_type = 'tv'`
        ).get(profileId, show.id))
      : false;

    return { ...show, genres, seasonCount, yearRange, cast, creators, similar, themeUrl, trailerKey, inWatchlist };
  });

  // --- Genres --------------------------------------------------------------

  // All genres actually present in the indexed library (movies + shows),
  // alphabetical, with a combined item count so the frontend can skip
  // building a pill/shelf for a genre nothing is tagged with.
  fastify.get('/api/genres', async () => {
    return db.prepare(`
      SELECT id, name, itemCount FROM (
        SELECT g.id, g.name,
          (SELECT COUNT(*) FROM media_genres mg WHERE mg.genre_id = g.id) +
          (SELECT COUNT(*) FROM show_genres sg WHERE sg.genre_id = g.id) AS itemCount
        FROM genres g
      )
      WHERE itemCount > 0
      ORDER BY name ASC
    `).all();
  });

  // Items (movies + shows) tagged with a given genre, rating-filtered for
  // the given profile the same way /api/library and /api/shows are. Movies
  // come back as media_items rows; shows come back as tv_shows rows — each
  // tagged with `kind` so the frontend knows how to render/open it (a movie
  // plays directly, a show opens the season/episode detail view).
  fastify.get('/api/genres/:id/media', async (request, reply) => {
    const genreId = request.params.id;
    const genre = db.prepare('SELECT * FROM genres WHERE id = ?').get(genreId);
    if (!genre) {
      reply.code(404);
      return { error: 'Genre not found' };
    }

    const { profile_id: profileId } = request.query;

    const movies = profileId
      ? db.prepare(`
          SELECT m.*, p.completed FROM media_items m
          JOIN media_genres mg ON mg.media_id = m.id
          LEFT JOIN playback_progress p ON p.media_id = m.id AND p.profile_id = @profileId
          WHERE mg.genre_id = @genreId AND m.media_type = 'movie'
          ORDER BY m.rating DESC
        `).all({ genreId, profileId })
      : db.prepare(`
          SELECT m.* FROM media_items m
          JOIN media_genres mg ON mg.media_id = m.id
          WHERE mg.genre_id = ? AND m.media_type = 'movie'
          ORDER BY m.rating DESC
        `).all(genreId);

    const shows = db.prepare(`
      SELECT s.*, COUNT(e.id) AS total_episodes
      FROM tv_shows s
      JOIN show_genres sg ON sg.show_id = s.id
      LEFT JOIN tv_episodes e ON e.show_id = s.id
      WHERE sg.genre_id = ?
      GROUP BY s.id
      ORDER BY s.title ASC
    `).all(genreId);

    const filteredMovies = filterByProfile(movies, profileId);
    let filteredShows = shows;
    if (profileId) {
      const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
      if (profile && profile.max_content_rating) {
        filteredShows = shows.filter((s) =>
          ratings.isAllowed(s.content_rating, profile.max_content_rating, Boolean(profile.is_child))
        );
      }
    }

    return rotateForToday([
      ...filteredMovies.map((m) => ({ ...m, kind: 'movie' })),
      ...filteredShows.map((s) => ({ ...s, kind: 'show' })),
    ]);
  });

  // --- Streaming ---------------------------------------------------------

  // ?audio_track=<N> selects a non-default audio stream (N is the
  // type-relative index from media_items.audio_tracks, i.e. what ffmpeg's
  // `-map 0:a:N` expects) — switching tracks starts a separate transcode
  // job rather than remapping an already-running one, so playback briefly
  // re-buffers on switch, same as changing quality on most simple players.
  fastify.get('/api/stream/:id', async (request, reply) => {
    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get(request.params.id);
    if (!item) {
      reply.code(404);
      return { error: 'Media item not found' };
    }

    const audioTrackParam = request.query.audio_track;
    const audioTrackIndex = audioTrackParam !== undefined && audioTrackParam !== '' ? parseInt(audioTrackParam, 10) : undefined;
    const audioTrackKey = audioTrackIndex === undefined || Number.isNaN(audioTrackIndex) ? 'default' : String(audioTrackIndex);

    const audioTracks = item.audio_tracks ? JSON.parse(item.audio_tracks) : [];
    const subtitleTracks = item.subtitle_tracks ? JSON.parse(item.subtitle_tracks) : [];

    try {
      const hlsPromise = startHlsJob(item.id, item.file_path, {
        audioTrackIndex: Number.isNaN(audioTrackIndex) ? undefined : audioTrackIndex,
        title: item.tmdb_matched_title || item.title,
      });
      const subtitlePromise = extractSubtitlesIfNeeded(item.id, item.file_path, subtitleTracks);

      // Subtitle extraction is a full, un-timed demux of the source file —
      // fast when its .vtt is already cached from a previous play (the
      // common case), but on a title's very first play it can take tens of
      // seconds. It must never hold up video start for that long, so we
      // only give it a couple seconds' grace here: if it wins, the client
      // gets subtitles immediately; if not, playback starts without them
      // and extractSubtitlesIfNeeded keeps running in the background (it
      // never rejects), so the .vtt is cached and ready on the next play.
      const subtitleGracePeriod = new Promise((resolve) => setTimeout(() => resolve(null), 2000));

      const [, subtitlePath] = await Promise.all([
        hlsPromise,
        Promise.race([subtitlePromise, subtitleGracePeriod]),
      ]);

      return {
        playlistUrl: `/stream-files/${item.id}/${audioTrackKey}/index.m3u8`,
        subtitleUrl: subtitlePath ? `/stream-files/${item.id}/subs.vtt` : null,
        audioTracks,
      };
    } catch (err) {
      fastify.log.error(err, `Failed to start stream for item ${item.id}`);
      reply.code(500);
      return { error: 'Failed to start stream' };
    }
  });

  // Subtitle sidecar for /api/raw's native-player path. /api/stream triggers
  // extraction itself (it already demuxes the file for the HLS job), but
  // /api/raw just pipes the original bytes straight through and never
  // touches ffmpeg — so the native (ExoPlayer) player calls this
  // separately, before/while it starts playback, to get the same .vtt the
  // browser player would have gotten. Same extraction + grace-period
  // behavior as /api/stream, just without also starting an HLS job.
  fastify.get('/api/raw/:id/subtitles', async (request, reply) => {
    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get(request.params.id);
    if (!item) {
      reply.code(404);
      return { error: 'Media item not found' };
    }

    const subtitleTracks = item.subtitle_tracks ? JSON.parse(item.subtitle_tracks) : [];
    const subtitleGracePeriod = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
    const subtitlePath = await Promise.race([
      extractSubtitlesIfNeeded(item.id, item.file_path, subtitleTracks),
      subtitleGracePeriod,
    ]);

    return {
      subtitleUrl: subtitlePath ? `/stream-files/${item.id}/subs.vtt` : null,
      language: subtitleTracks[0] ? subtitleTracks[0].language : null,
    };
  });

  // Serves the ORIGINAL media file byte-for-byte, with HTTP Range support,
  // for a client that can decode the source container/codecs itself —
  // currently only the Android TV app's native (ExoPlayer) player, which
  // uses this instead of /api/stream specifically to get the source's real
  // multichannel audio. Browsers never call this: they go through
  // /api/stream's transcoded HLS, which downmixes to stereo (see
  // streamer.js) because browsers can't decode most of what a raw MKV
  // might contain (AC-3/DTS especially) and can't reliably handle
  // multichannel AAC via MSE either — this route exists so a *native*
  // player, which doesn't have either limitation, can bypass all of that
  // and play the file directly, no transcoding involved.
  fastify.get('/api/raw/:id', async (request, reply) => {
    const item = db.prepare('SELECT * FROM media_items WHERE id = ?').get(request.params.id);
    if (!item) {
      reply.code(404);
      return { error: 'Media item not found' };
    }
    if (!fs.existsSync(item.file_path)) {
      reply.code(404);
      return { error: 'Source file not found on disk' };
    }

    const stat = fs.statSync(item.file_path);
    reply.header('Accept-Ranges', 'bytes');
    reply.type(mimeTypeForVideoFile(item.file_path));

    const range = request.headers.range;
    if (!range) {
      reply.header('Content-Length', stat.size);
      return fs.createReadStream(item.file_path);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      reply.code(416);
      reply.header('Content-Range', `bytes */${stat.size}`);
      return { error: 'Invalid Range header' };
    }

    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Content-Length', end - start + 1);
    return fs.createReadStream(item.file_path, { start, end });
  });

  // "Active streams" app-switcher panel: everything currently transcoding
  // right now, with enough media_items metadata (poster, title) to render
  // a card, plus a way to stop one.
  fastify.get('/api/streams/active', async () => {
    const jobs = listActiveJobs();
    if (jobs.length === 0) return [];
    const ids = [...new Set(jobs.map((j) => j.itemId))];
    const placeholders = ids.map(() => '?').join(',');
    const items = db.prepare(`SELECT id, title, tmdb_matched_title, poster_url FROM media_items WHERE id IN (${placeholders})`).all(...ids);
    const itemsById = new Map(items.map((i) => [i.id, i]));
    return jobs.map((job) => {
      const item = itemsById.get(job.itemId) || {};
      return {
        itemId: job.itemId,
        audioTrackKey: job.audioTrackKey,
        startedAt: job.startedAt,
        title: item.tmdb_matched_title || item.title || job.title || `Item #${job.itemId}`,
        posterUrl: item.poster_url || null,
      };
    });
  });

  fastify.post('/api/streams/:id/stop', async (request, reply) => {
    const audioTrackKey = request.query.audio_track !== undefined ? String(request.query.audio_track) : 'default';
    const stopped = stopJob(request.params.id, audioTrackKey);
    if (!stopped) {
      reply.code(404);
      return { error: 'No active stream for that item/track' };
    }
    return { stopped: true };
  });

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Media server listening on port ${PORT}, serving ${MEDIA_DIR}`);
  startTranscodeCleanup();
  autoscan.start(fastify.log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
