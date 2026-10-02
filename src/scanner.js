// src/scanner.js
// Recursively scans MEDIA_DIR for video files, pulls metadata with
// ffprobe, and upserts each item into the SQLite library. Runs in two
// parallel phases (file probing, then TMDB enrichment) instead of one
// slow serial pass, since a few thousand files at one-at-a-time speed
// takes well over an hour.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const db = require('./db');
const tmdb = require('./tmdb');
const { mapWithConcurrency } = require('./concurrency');

// Emits scan progress so the API/UI can show a live progress bar instead of
// just polling scan_log for a final status. Events:
//   { stage: 'walking' }
//   { stage: 'probing', current, total, filename, percent }
//   { stage: 'matching', current, total, filename, percent }
//   { stage: 'complete', filesFound, filesAdded }
//   { stage: 'error', message }
const scanEvents = new EventEmitter();
// A single scan can be watched by more than one open browser tab.
scanEvents.setMaxListeners(50);

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);

// How many files to ffprobe at once, and how many TMDB lookups to run at
// once. ffprobe is a real subprocess (CPU-bound), so keep that number
// modest relative to CPU cores. TMDB is network-bound and its actual
// rate limit is generous, so a higher number there is safe and fast.
const PROBE_CONCURRENCY = parseInt(process.env.SCAN_PROBE_CONCURRENCY || '4', 10);
const TMDB_CONCURRENCY = parseInt(process.env.SCAN_TMDB_CONCURRENCY || '8', 10);

// Directory names to never descend into: Unraid's Recycle Bin plugin
// (.Trash-<uid>), download-client working dirs, and standard hidden/
// junk folders. Matched case-insensitively against the folder's own
// name (not the full path), at any depth.
const DEFAULT_SKIP_DIRS = [
  '@eaDir', // Synology thumbnail cache, shows up on some NAS-backed mounts
  '.recycle',
  '#recycle',
  'lost+found',
];
const SKIP_DIR_PATTERNS = [
  /^\.trash-?\d*$/i, // .Trash-99, .Trash, .trash-1000
  /^\.trash$/i,
];
const EXTRA_SKIP_DIRS = (process.env.SCAN_SKIP_DIRS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_DOWNLOADS = String(process.env.SCAN_INCLUDE_DOWNLOADS || 'false').toLowerCase() === 'true';

// Whitelist of top-level folders (direct children of MEDIA_DIR) to scan.
// When set, everything else directly under MEDIA_DIR is ignored entirely —
// this is stricter than SCAN_SKIP_DIRS, which is a blacklist applied at
// every depth. Comma-separated, case-insensitive, defaults to the standard
// Movies/TvShows split. Set SCAN_ONLY_DIRS= (empty) to disable and fall
// back to scanning everything under MEDIA_DIR except the skip list above.
const ONLY_TOP_LEVEL_DIRS = (
  process.env.SCAN_ONLY_DIRS !== undefined ? process.env.SCAN_ONLY_DIRS : 'Movies,TvShows'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Which of the top-level folders above (if any match SCAN_ONLY_DIRS) hold TV
// content rather than movies — used by mediaTypeFromPath() below. This used
// to be a single hardcoded check for a folder literally named "TvShows",
// completely independent of SCAN_ONLY_DIRS: a library whose TV folder was
// scanned under a different name (e.g. a plain "tv" folder, allowed in via
// SCAN_ONLY_DIRS=Movies,tv) would have every one of its files silently
// classified as a movie and searched against the wrong TMDB endpoint,
// guaranteeing a "no match" for all of them. Comma-separated,
// case-insensitive, defaults to "TvShows" for backwards compatibility.
const TV_TOP_LEVEL_DIRS = (process.env.SCAN_TV_DIRS || 'TvShows')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function shouldSkipDir(name) {
  if (name.startsWith('.') && name !== '.' && name !== '..') return true; // hidden dirs generally
  const lower = name.toLowerCase();
  if (DEFAULT_SKIP_DIRS.some((d) => d.toLowerCase() === lower)) return true;
  if (SKIP_DIR_PATTERNS.some((re) => re.test(name))) return true;
  if (EXTRA_SKIP_DIRS.some((d) => d.toLowerCase() === lower)) return true;
  if (!INCLUDE_DOWNLOADS && lower === 'downloads') return true;
  return false;
}

function walk(dir, files = [], depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[scanner] Cannot read directory ${dir}:`, err.message);
    return files;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(dir, entry.name));
      }
      continue;
    }

    if (shouldSkipDir(entry.name)) continue;

    // At the top level (direct children of MEDIA_DIR), enforce the
    // whitelist if one is configured — anything not named here is
    // skipped outright rather than walked and filtered later.
    if (depth === 0 && ONLY_TOP_LEVEL_DIRS.length > 0) {
      const isAllowed = ONLY_TOP_LEVEL_DIRS.some(
        (allowed) => allowed.toLowerCase() === entry.name.toLowerCase()
      );
      if (!isAllowed) continue;
    }

    walk(path.join(dir, entry.name), files, depth + 1);
  }
  return files;
}

// Subtitle codecs ffmpeg can actually convert to WebVTT text. PGS/DVD/DVB
// subtitles are bitmap images burned into the stream, not text — there's
// no text to extract, so they're left out rather than offered as a track
// that will fail when a user picks it.
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

function probeFile(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`[scanner] ffprobe failed for ${filePath}:`, err.message);
        resolve(null);
        return;
      }
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');

      // `index` here is the position within streams of the SAME type (the
      // 2nd audio stream is index 1, regardless of its absolute stream
      // index in the file) — that's what ffmpeg's `-map 0:a:N`/`0:s:N`
      // selectors expect, so it has to be computed this way rather than
      // read off ffprobe's own (absolute) `stream.index`.
      const audioStreams = metadata.streams.filter((s) => s.codec_type === 'audio');
      const audioTracks = audioStreams.map((s, i) => ({
        index: i,
        codec: s.codec_name || null,
        language: (s.tags && s.tags.language) || null,
        channels: s.channels || null,
      }));

      const subtitleStreams = metadata.streams.filter((s) => s.codec_type === 'subtitle');
      const subtitleTracks = subtitleStreams
        .map((s, i) => ({ index: i, codec: s.codec_name || null, language: (s.tags && s.tags.language) || null }))
        .filter((t) => TEXT_SUBTITLE_CODECS.has(t.codec));

      resolve({
        duration: metadata.format.duration || null,
        resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : null,
        codec: videoStream ? videoStream.codec_name : null,
        audioTracks,
        subtitleTracks,
      });
    });
  });
}

function titleFromFilename(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[._]/g, ' ')
    .trim();
}

/**
 * Extracts show title, season number and episode number from a TV
 * filename or its folder hierarchy. Handles "Show.Name.S01E05...",
 * "Show Name - 1x05", and a folder layout like
 * ".../Show Name/Season 02/05 - Title.mkv". Returns null when nothing
 * recognizable is found (caller falls back to a plain show-level match).
 */
function parseTvFilename(filePath) {
  const fileName = path.basename(filePath, path.extname(filePath));

  const sxxExx = fileName.match(/^(.*?)[.\s_-]+S(\d{1,2})E(\d{1,3})/i);
  if (sxxExx) {
    return {
      showTitle: sxxExx[1].replace(/[._]/g, ' ').trim(),
      seasonNumber: parseInt(sxxExx[2], 10),
      episodeNumber: parseInt(sxxExx[3], 10),
    };
  }

  const nxnn = fileName.match(/^(.*?)[.\s_-]+(\d{1,2})x(\d{2,3})\b/i);
  if (nxnn) {
    return {
      showTitle: nxnn[1].replace(/[._]/g, ' ').trim(),
      seasonNumber: parseInt(nxnn[2], 10),
      episodeNumber: parseInt(nxnn[3], 10),
    };
  }

  // Fallback: infer from folder structure, e.g. .../Show Name/Season 02/05.mkv
  const parts = filePath.split(path.sep);
  if (parts.length >= 3) {
    const seasonDir = parts[parts.length - 2];
    const showDir = parts[parts.length - 3];
    const seasonMatch = seasonDir.match(/season\s*(\d+)/i);
    const episodeMatch = fileName.match(/(\d{1,3})/);
    if (seasonMatch && episodeMatch) {
      return {
        showTitle: showDir.replace(/[._]/g, ' ').trim(),
        seasonNumber: parseInt(seasonMatch[1], 10),
        episodeNumber: parseInt(episodeMatch[1], 10),
      };
    }
  }

  return null;
}

// In-memory caches (per process, cleared at the start of each enrichment
// run) so concurrent episodes of the same show only hit TMDB's show/season
// endpoints once each instead of once per episode.
let showCache = new Map();
let seasonCache = new Map();

// Genre linking: genres.id is TMDB's own genre id, so this is just an
// upsert-by-id followed by a junction-row insert. Existing links are
// cleared first so a rematch doesn't leave stale genres behind.
const upsertGenreStmt = db.prepare('INSERT OR IGNORE INTO genres (id, name) VALUES (@id, @name)');
const clearMediaGenresStmt = db.prepare('DELETE FROM media_genres WHERE media_id = ?');
const linkMediaGenreStmt = db.prepare('INSERT OR IGNORE INTO media_genres (media_id, genre_id) VALUES (?, ?)');
const clearShowGenresStmt = db.prepare('DELETE FROM show_genres WHERE show_id = ?');
const linkShowGenreStmt = db.prepare('INSERT OR IGNORE INTO show_genres (show_id, genre_id) VALUES (?, ?)');

function linkMediaGenres(mediaId, genres) {
  clearMediaGenresStmt.run(mediaId);
  for (const g of genres || []) {
    if (!g || !g.id || !g.name) continue;
    upsertGenreStmt.run({ id: g.id, name: g.name });
    linkMediaGenreStmt.run(mediaId, g.id);
  }
}

function linkShowGenres(showId, genres) {
  clearShowGenresStmt.run(showId);
  for (const g of genres || []) {
    if (!g || !g.id || !g.name) continue;
    upsertGenreStmt.run({ id: g.id, name: g.name });
    linkShowGenreStmt.run(showId, g.id);
  }
}

const insertShowStmt = db.prepare(`
  INSERT INTO tv_shows (tmdb_id, title, overview, poster_url, backdrop_url, first_air_date, content_rating)
  VALUES (@tmdbId, @title, @overview, @posterUrl, @backdropUrl, @firstAirDate, @contentRating)
  ON CONFLICT(tmdb_id) DO UPDATE SET
    title = excluded.title, overview = excluded.overview, poster_url = excluded.poster_url,
    backdrop_url = excluded.backdrop_url, content_rating = excluded.content_rating
`);

const insertSeasonStmt = db.prepare(`
  INSERT INTO tv_seasons (show_id, season_number, tmdb_id, title, overview, poster_url, air_date)
  VALUES (@showId, @seasonNumber, @tmdbId, @title, @overview, @posterUrl, @airDate)
  ON CONFLICT(show_id, season_number) DO UPDATE SET
    tmdb_id = excluded.tmdb_id, title = excluded.title, overview = excluded.overview,
    poster_url = excluded.poster_url, air_date = excluded.air_date
`);

const insertEpisodeStmt = db.prepare(`
  INSERT INTO tv_episodes (season_id, show_id, media_item_id, episode_number, title, overview, still_url, air_date)
  VALUES (@seasonId, @showId, @mediaItemId, @episodeNumber, @title, @overview, @stillUrl, @airDate)
  ON CONFLICT(media_item_id) DO UPDATE SET
    season_id = excluded.season_id, show_id = excluded.show_id, episode_number = excluded.episode_number,
    title = excluded.title, overview = excluded.overview, still_url = excluded.still_url, air_date = excluded.air_date
`);

// Finds a tv_shows row by title (created by an earlier scan) or creates one
// via a single TMDB show search. Cached per-run so 20 episodes of the same
// show only trigger one TMDB lookup, not 20.
function findOrCreateShow(showTitle) {
  const key = showTitle.trim().toLowerCase();
  if (showCache.has(key)) return showCache.get(key);

  const promise = (async () => {
    const existing = db.prepare('SELECT * FROM tv_shows WHERE title = ? COLLATE NOCASE').get(showTitle);
    if (existing) return existing;

    const match = await tmdb.lookupTv(showTitle);
    if (!match) return null;

    insertShowStmt.run({
      tmdbId: match.tmdbId,
      title: match.matchedTitle,
      overview: match.overview,
      posterUrl: match.posterUrl,
      backdropUrl: match.backdropUrl,
      firstAirDate: match.releaseYear ? `${match.releaseYear}-01-01` : null,
      contentRating: match.contentRating,
    });
    const showRow = db.prepare('SELECT * FROM tv_shows WHERE tmdb_id = ?').get(match.tmdbId);
    if (showRow && match.genres && match.genres.length) {
      linkShowGenres(showRow.id, match.genres);
    }
    return showRow;
  })();

  showCache.set(key, promise);
  return promise;
}

// Finds or creates a tv_seasons row, fetching season-level metadata from
// TMDB (title/overview/poster) once per show+season.
function findOrCreateSeason(show, seasonNumber) {
  const key = `${show.id}:${seasonNumber}`;
  if (seasonCache.has(key)) return seasonCache.get(key);

  const promise = (async () => {
    const existing = db
      .prepare('SELECT * FROM tv_seasons WHERE show_id = ? AND season_number = ?')
      .get(show.id, seasonNumber);
    if (existing) return existing;

    const details = show.tmdb_id ? await tmdb.getSeasonDetails(show.tmdb_id, seasonNumber) : null;
    insertSeasonStmt.run({
      showId: show.id,
      seasonNumber,
      tmdbId: details ? details.tmdbId : null,
      title: (details && details.title) || `Season ${seasonNumber}`,
      overview: details ? details.overview : null,
      posterUrl: details ? details.posterUrl : null,
      airDate: details ? details.airDate : null,
    });
    return db.prepare('SELECT * FROM tv_seasons WHERE show_id = ? AND season_number = ?').get(show.id, seasonNumber);
  })();

  seasonCache.set(key, promise);
  return promise;
}

// Resolves one media_items row (a TV episode file) against the show/season/
// episode hierarchy: parses the filename, finds-or-creates the show and
// season, fetches episode-level metadata, links tv_episodes to this row,
// and returns a match object shaped like tmdb.lookupMovie/lookupTv's so the
// caller can save it the same way. Falls back to a plain show-level match
// when the filename doesn't parse (no season/episode grouping, but still
// gets a poster/overview/rating from the show itself).
async function enrichTvEpisode(row) {
  const parsed = parseTvFilename(row.file_path);
  if (!parsed) {
    return tmdb.lookupTv(row.title);
  }

  const show = await findOrCreateShow(parsed.showTitle);
  if (!show) return null;

  const season = await findOrCreateSeason(show, parsed.seasonNumber);
  const epDetails = show.tmdb_id
    ? await tmdb.getEpisodeDetails(show.tmdb_id, parsed.seasonNumber, parsed.episodeNumber)
    : null;

  const episodeTitle = (epDetails && epDetails.title) || `Episode ${parsed.episodeNumber}`;
  const seasonStr = String(parsed.seasonNumber).padStart(2, '0');
  const episodeStr = String(parsed.episodeNumber).padStart(2, '0');
  const fullTitle = `${show.title} - S${seasonStr}E${episodeStr} - ${episodeTitle}`;

  try {
    insertEpisodeStmt.run({
      seasonId: season.id,
      showId: show.id,
      mediaItemId: row.id,
      episodeNumber: parsed.episodeNumber,
      title: episodeTitle,
      overview: epDetails ? epDetails.overview : null,
      stillUrl: epDetails ? epDetails.stillUrl : null,
      airDate: epDetails ? epDetails.airDate : null,
    });
  } catch (err) {
    console.error(`[scanner] Failed to link episode for ${row.file_path}:`, err.message);
  }

  return {
    tmdbId: show.tmdb_id,
    matchedTitle: fullTitle,
    overview: (epDetails && epDetails.overview) || show.overview,
    releaseYear: epDetails && epDetails.airDate
      ? parseInt(epDetails.airDate.slice(0, 4), 10)
      : (show.first_air_date ? parseInt(show.first_air_date.slice(0, 4), 10) : null),
    rating: null,
    posterUrl: (epDetails && epDetails.stillUrl) || show.poster_url,
    backdropUrl: show.backdrop_url,
    mediaType: 'tv',
    contentRating: show.content_rating,
  };
}

// Which top-level folder a file lives under decides whether we search TMDB's
// movie or TV catalog for it. TV_TOP_LEVEL_DIRS (SCAN_TV_DIRS) is the
// configurable list of folder names that count as TV — anything else
// defaults to movie, same as before, but the TV folder name itself is no
// longer hardcoded to "TvShows".
function mediaTypeFromPath(filePath) {
  const rel = path.relative(MEDIA_DIR, filePath).split(path.sep);
  const top = (rel[0] || '').toLowerCase();
  if (TV_TOP_LEVEL_DIRS.includes(top)) return 'tv';
  return 'movie'; // default guess for anything not under a configured TV folder
}

const upsertStmt = db.prepare(`
  INSERT INTO media_items (title, file_path, file_size, duration_sec, resolution, codec, media_type, audio_tracks, subtitle_tracks, updated_at)
  VALUES (@title, @file_path, @file_size, @duration_sec, @resolution, @codec, @media_type, @audio_tracks, @subtitle_tracks, datetime('now'))
  ON CONFLICT(file_path) DO UPDATE SET
    file_size = excluded.file_size,
    duration_sec = excluded.duration_sec,
    resolution = excluded.resolution,
    codec = excluded.codec,
    media_type = excluded.media_type,
    audio_tracks = excluded.audio_tracks,
    subtitle_tracks = excluded.subtitle_tracks,
    updated_at = datetime('now')
`);

const saveTmdbStmt = db.prepare(`
  UPDATE media_items SET
    tmdb_id = @tmdbId,
    tmdb_matched_title = @matchedTitle,
    poster_url = @posterUrl,
    backdrop_url = @backdropUrl,
    overview = @overview,
    release_year = @releaseYear,
    rating = @rating,
    media_type = @mediaType,
    content_rating = @contentRating,
    updated_at = datetime('now')
  WHERE id = @id
`);

// Runs TMDB matching, with concurrency, for every media_items row that
// doesn't have a tmdb_id yet. Shared between a fresh scan's second phase
// and the standalone /api/library/retry-unmatched endpoint.
async function enrichUnmatched({ emitComplete = true } = {}) {
  if (!tmdb.isConfigured()) {
    console.warn('[scanner] TMDB_API_KEY/TMDB_AUTH_TOKEN not set — skipping poster/metadata lookup.');
    if (emitComplete) {
      scanEvents.emit('progress', { stage: 'complete', filesAdded: 0, matched: 0, candidates: 0 });
    }
    return { candidates: 0, matched: 0 };
  }

  // Fresh per run so a stale show/season lookup from a previous scan
  // doesn't linger indefinitely, while still deduping within this run.
  showCache = new Map();
  seasonCache = new Map();

  // Reprocess anything unmatched, PLUS any TV row that already has a
  // tmdb_id but was never linked into tv_episodes — that's the signature
  // of a file matched by the old flat/movie-only matcher before the show/
  // season/episode hierarchy existed. Without this second clause those
  // rows would keep their stale match forever, since the normal
  // tmdb_id IS NULL check would skip them.
  const rows = db.prepare(`
    SELECT id, title, file_path, media_type FROM media_items
    WHERE tmdb_id IS NULL
       OR (media_type = 'tv' AND id NOT IN (SELECT media_item_id FROM tv_episodes))
  `).all();
  console.log(`[scanner] Matching ${rows.length} items against TMDB (concurrency ${TMDB_CONCURRENCY})...`);

  let matched = 0;
  let done = 0;
  const total = rows.length;
  await mapWithConcurrency(rows, TMDB_CONCURRENCY, async (row) => {
    try {
      const match = row.media_type === 'tv' ? await enrichTvEpisode(row) : await tmdb.lookupMovie(row.title);
      if (match) {
        saveTmdbStmt.run({
          id: row.id,
          tmdbId: match.tmdbId,
          matchedTitle: match.matchedTitle,
          posterUrl: match.posterUrl,
          backdropUrl: match.backdropUrl,
          overview: match.overview,
          releaseYear: match.releaseYear,
          rating: match.rating,
          mediaType: match.mediaType || row.media_type,
          contentRating: match.contentRating || null,
        });
        // Only movies carry genres directly on `match` here — TV episodes'
        // synthesized match object doesn't, since genre is linked at the
        // show level inside findOrCreateShow instead.
        if (row.media_type !== 'tv' && match.genres && match.genres.length) {
          linkMediaGenres(row.id, match.genres);
        }
        matched += 1;
      } else {
        console.log(`[scanner] No TMDB match for "${row.title}"`);
      }
    } catch (err) {
      console.error(`[scanner] TMDB lookup failed for "${row.title}":`, err.message);
    } finally {
      done += 1;
      scanEvents.emit('progress', {
        stage: 'matching',
        current: done,
        total,
        filename: path.basename(row.file_path),
        percent: total > 0 ? Math.round((done / total) * 100) : 100,
      });
    }
  });

  console.log(`[scanner] TMDB matching done: ${matched}/${rows.length} newly matched.`);
  // Only the standalone caller (POST /api/library/retry-unmatched) wants a
  // 'complete' event here — runScan() calls this as its second phase and
  // emits its own 'complete' afterward (with filesFound/filesAdded from the
  // whole scan), so it passes emitComplete: false to avoid ending the SSE
  // stream early with an incomplete/misleading progress payload.
  if (emitComplete) {
    scanEvents.emit('progress', {
      stage: 'complete',
      filesAdded: matched,
      matched,
      candidates: rows.length,
    });
  }
  return { candidates: rows.length, matched };
}

// Re-fetches genres for every already-matched movie and show, without
// touching anything else (title, poster, overview, rating, etc. are left
// alone). This is the "Backfill Genres" settings action: genre tagging was
// added after this server already had a matched library, and the normal
// matching passes (runScan/enrichUnmatched) only ever touch items that
// don't have a tmdb_id yet, so anything matched before genres existed
// would otherwise never get tagged. Shares the same progress-bar SSE
// channel as scanning/retry-unmatched so it's visible the same way.
async function backfillGenres({ emitComplete = true } = {}) {
  if (!tmdb.isConfigured()) {
    console.warn('[scanner] TMDB_API_KEY/TMDB_AUTH_TOKEN not set — skipping genre backfill.');
    if (emitComplete) {
      scanEvents.emit('progress', { stage: 'complete', filesAdded: 0, matched: 0, candidates: 0 });
    }
    return { candidates: 0, updated: 0 };
  }

  const movies = db.prepare(`
    SELECT id, tmdb_id FROM media_items WHERE media_type = 'movie' AND tmdb_id IS NOT NULL
  `).all();
  const shows = db.prepare(`SELECT id, tmdb_id FROM tv_shows WHERE tmdb_id IS NOT NULL`).all();
  const total = movies.length + shows.length;
  console.log(`[scanner] Backfilling genres for ${movies.length} movies and ${shows.length} shows...`);

  let done = 0;
  let updated = 0;

  await mapWithConcurrency(movies, TMDB_CONCURRENCY, async (row) => {
    try {
      const genres = await tmdb.getMovieGenres(row.tmdb_id);
      if (genres.length) {
        linkMediaGenres(row.id, genres);
        updated += 1;
      }
    } catch (err) {
      console.error(`[scanner] Genre backfill failed for movie #${row.id}:`, err.message);
    } finally {
      done += 1;
      scanEvents.emit('progress', {
        stage: 'matching',
        current: done,
        total,
        filename: `Movie genres (${done}/${total})`,
        percent: total > 0 ? Math.round((done / total) * 100) : 100,
      });
    }
  });

  await mapWithConcurrency(shows, TMDB_CONCURRENCY, async (row) => {
    try {
      const genres = await tmdb.getTvGenres(row.tmdb_id);
      if (genres.length) {
        linkShowGenres(row.id, genres);
        updated += 1;
      }
    } catch (err) {
      console.error(`[scanner] Genre backfill failed for show #${row.id}:`, err.message);
    } finally {
      done += 1;
      scanEvents.emit('progress', {
        stage: 'matching',
        current: done,
        total,
        filename: `Show genres (${done}/${total})`,
        percent: total > 0 ? Math.round((done / total) * 100) : 100,
      });
    }
  });

  console.log(`[scanner] Genre backfill done: ${updated}/${total} items tagged.`);
  if (emitComplete) {
    scanEvents.emit('progress', {
      stage: 'complete',
      filesAdded: updated,
      matched: updated,
      candidates: total,
    });
  }
  return { candidates: total, updated };
}

async function runScan() {
  const scopeDesc = ONLY_TOP_LEVEL_DIRS.length > 0
    ? `${MEDIA_DIR} (only: ${ONLY_TOP_LEVEL_DIRS.join(', ')})`
    : MEDIA_DIR;
  console.log(`[scanner] Starting scan of ${scopeDesc}`);
  const insertLog = db.prepare(
    `INSERT INTO scan_log (files_found, files_added, status) VALUES (0, 0, 'running')`
  );
  const logId = insertLog.run().lastInsertRowid;

  try {
    scanEvents.emit('progress', { stage: 'walking', message: `Scanning ${scopeDesc}...` });
    const files = walk(MEDIA_DIR);
    console.log(`[scanner] Found ${files.length} files, probing with concurrency ${PROBE_CONCURRENCY}...`);

    let added = 0;
    const probeTotal = files.length;
    await mapWithConcurrency(files, PROBE_CONCURRENCY, async (filePath) => {
      const stat = fs.statSync(filePath);
      const meta = await probeFile(filePath);

      upsertStmt.run({
        title: titleFromFilename(filePath),
        file_path: filePath,
        file_size: stat.size,
        duration_sec: meta ? meta.duration : null,
        resolution: meta ? meta.resolution : null,
        codec: meta ? meta.codec : null,
        media_type: mediaTypeFromPath(filePath),
        audio_tracks: meta && meta.audioTracks ? JSON.stringify(meta.audioTracks) : null,
        subtitle_tracks: meta && meta.subtitleTracks ? JSON.stringify(meta.subtitleTracks) : null,
      });
      added += 1;
      scanEvents.emit('progress', {
        stage: 'probing',
        current: added,
        total: probeTotal,
        filename: path.basename(filePath),
        percent: probeTotal > 0 ? Math.round((added / probeTotal) * 100) : 100,
      });
    });

    console.log(`[scanner] File probing done: ${added}/${files.length} indexed. Starting TMDB matching phase...`);
    await enrichUnmatched({ emitComplete: false });

    db.prepare(
      `UPDATE scan_log SET finished_at = datetime('now'), files_found = ?, files_added = ?, status = 'complete' WHERE id = ?`
    ).run(files.length, added, logId);

    console.log(`[scanner] Scan complete. Found ${files.length} files, indexed ${added}.`);
    scanEvents.emit('progress', {
      stage: 'complete',
      filesFound: files.length,
      filesAdded: added,
      percent: 100,
    });
    return { filesFound: files.length, filesAdded: added };
  } catch (err) {
    console.error('[scanner] Scan failed:', err);
    db.prepare(`UPDATE scan_log SET finished_at = datetime('now'), status = 'error' WHERE id = ?`).run(logId);
    scanEvents.emit('progress', { stage: 'error', message: err.message });
    throw err;
  }
}

// Allow running directly: `node src/scanner.js`
if (require.main === module) {
  runScan()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[scanner] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = {
  runScan,
  enrichUnmatched,
  backfillGenres,
  parseTvFilename,
  scanEvents,
  linkMediaGenres,
  linkShowGenres,
};
