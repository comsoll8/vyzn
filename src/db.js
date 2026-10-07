// src/db.js
// SQLite database setup for the media library.
// Uses better-sqlite3 (synchronous, fast, no callback hell — fine for a
// single-writer local media server).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'library.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS media_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    file_path     TEXT NOT NULL UNIQUE,
    file_size     INTEGER,
    duration_sec  REAL,
    resolution    TEXT,
    codec         TEXT,
    poster_url    TEXT,
    backdrop_url  TEXT,
    overview      TEXT,
    release_year  INTEGER,
    rating        REAL,
    tmdb_id       INTEGER,
    tmdb_matched_title TEXT,
    media_type    TEXT,
    content_rating TEXT,
    added_at      TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(title);

  CREATE TABLE IF NOT EXISTS scan_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    files_found INTEGER,
    files_added INTEGER,
    status      TEXT DEFAULT 'running'
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    avatar             TEXT,
    is_child           INTEGER NOT NULL DEFAULT 0,
    max_content_rating TEXT,
    created_at         TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playback_progress (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    media_id         INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    completed        INTEGER NOT NULL DEFAULT 0,
    last_watched_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(profile_id, media_id)
  );

  CREATE INDEX IF NOT EXISTS idx_playback_profile ON playback_progress(profile_id);

  -- TV hierarchy: a show has seasons, a season has episodes. Each episode
  -- links to the underlying media_items row (media_item_id) so streaming,
  -- playback progress and content-rating filtering all keep working
  -- unchanged — this is a metadata layer on top, not a replacement.
  CREATE TABLE IF NOT EXISTS tv_shows (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id         INTEGER UNIQUE,
    title           TEXT NOT NULL,
    overview        TEXT,
    poster_url      TEXT,
    backdrop_url    TEXT,
    first_air_date  TEXT,
    content_rating  TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tv_seasons (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id       INTEGER NOT NULL REFERENCES tv_shows(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    tmdb_id       INTEGER,
    title         TEXT,
    overview      TEXT,
    poster_url    TEXT,
    air_date      TEXT,
    UNIQUE(show_id, season_number)
  );

  CREATE TABLE IF NOT EXISTS tv_episodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id       INTEGER NOT NULL REFERENCES tv_seasons(id) ON DELETE CASCADE,
    show_id         INTEGER NOT NULL REFERENCES tv_shows(id) ON DELETE CASCADE,
    media_item_id   INTEGER NOT NULL UNIQUE REFERENCES media_items(id) ON DELETE CASCADE,
    episode_number  INTEGER NOT NULL,
    title           TEXT,
    overview        TEXT,
    still_url       TEXT,
    air_date        TEXT,
    UNIQUE(season_id, episode_number)
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_show ON tv_episodes(show_id);

  -- Genres: id is TMDB's own genre id (not autoincrement), so movie and TV
  -- genre lists share rows for concepts both use (Action, Comedy, Drama,
  -- etc.) while still storing TV-only ones (Sci-Fi & Fantasy, Kids, ...)
  -- without collision. media_genres links movies (media_items rows);
  -- show_genres links whole TV shows, since genre is a show-level concept,
  -- not a per-episode one.
  CREATE TABLE IF NOT EXISTS genres (
    id   INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS media_genres (
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, genre_id)
  );

  CREATE TABLE IF NOT EXISTS show_genres (
    show_id  INTEGER NOT NULL REFERENCES tv_shows(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (show_id, genre_id)
  );

  CREATE INDEX IF NOT EXISTS idx_media_genres_genre ON media_genres(genre_id);
  CREATE INDEX IF NOT EXISTS idx_show_genres_genre ON show_genres(genre_id);

  -- Caches the movie detail page's TMDB lookups (credits + similar-movies
  -- list) so opening a movie's detail page repeatedly doesn't re-hit TMDB
  -- every time. Keyed by tmdb_id (not media_items.id) since the same movie
  -- could in principle be indexed from more than one file. JSON blobs are
  -- the raw TMDB-shaped data (cast list, similar-movie id/title refs) —
  -- the "similar" list is re-joined against the local library fresh on
  -- every request regardless of cache state, since library membership
  -- changes far more often than a movie's actual cast/crew does.
  CREATE TABLE IF NOT EXISTS tmdb_detail_cache (
    tmdb_id      INTEGER NOT NULL,
    media_type   TEXT NOT NULL,
    cast_json    TEXT,
    director     TEXT,
    writers_json TEXT,
    similar_json TEXT,
    similar_source TEXT,
    fetched_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (tmdb_id, media_type)
  );

  -- A profile's saved-for-later list. item_type + item_id together identify
  -- either a media_items row ('movie') or a tv_shows row ('tv') — kept as a
  -- loose pair rather than two separate FK columns since the two tables
  -- have completely different id spaces and a watchlist entry only ever
  -- points at one of them.
  CREATE TABLE IF NOT EXISTS watchlist (
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL,
    item_type   TEXT NOT NULL,
    added_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, item_id, item_type)
  );

  -- Runtime-editable configuration overrides (TMDB/Seerr keys, transcode
  -- options, Tailscale auth key, etc.) set from the Control Center Settings
  -- panel. A key present here wins over the matching docker-compose.yml
  -- env var for that key — see src/config.js, which is the only module
  -- that reads/writes this table directly. Deleting a row (rather than
  -- storing an empty string) is how a cleared override falls back to the
  -- env var again, so this table only ever holds explicit overrides.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Accounts + login sessions (src/auth.js). Distinct from `profiles`: an
// account is who may use the server at all (username/password), while a
// profile is "who's watching" within the household (watch history,
// parental limits). Until the first account exists the server stays fully
// open exactly as before — see auth.js's authHook. Tokens are stored only
// as SHA-256 hashes, so a leaked database file can't be replayed as
// working logins; expires_at/last_used_at are epoch milliseconds.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
`);

// tmdb_detail_cache predates `similar_source` (added when "More Like This"
// switched from TMDB's /similar endpoint — mostly shared genres/keywords,
// prone to odd pairings — to the higher-quality /recommendations endpoint).
// A row with no similar_source is one cached under the old logic; leaving
// it NULL (rather than backfilling a guessed value) is what lets
// server.js tell "cached under the old, weaker logic" apart from "cached
// fresh under the new one" and force a one-time refetch for the former,
// without needing a special one-off cleanup step.
const detailCacheColumns = new Set(db.prepare(`PRAGMA table_info(tmdb_detail_cache)`).all().map((c) => c.name));
if (!detailCacheColumns.has('similar_source')) {
  db.exec(`ALTER TABLE tmdb_detail_cache ADD COLUMN similar_source TEXT`);
}
// Play log (Tautulli-style): one row per viewing session, written by
// src/activity.js from the player's progress pings. Name/title snapshots
// are stored so history survives deleting a profile, account or file.
db.exec(`
  CREATE TABLE IF NOT EXISTS play_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id       INTEGER,
    profile_name     TEXT,
    user_id          INTEGER,
    user_name        TEXT,
    media_id         INTEGER,
    title            TEXT,
    group_title      TEXT,
    started_at       INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL,
    position_seconds REAL DEFAULT 0,
    duration_seconds REAL DEFAULT 0,
    watched_seconds  REAL DEFAULT 0,
    completed        INTEGER DEFAULT 0,
    platform         TEXT,
    ip               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_play_log_started ON play_log(started_at);
  CREATE INDEX IF NOT EXISTS idx_play_log_profile ON play_log(profile_id, media_id, last_seen_at);
`);

// Profiles belong to an account (src/auth.js): each login sees only its own
// "Who's watching?" list. NULL = created before accounts existed; the first
// account created claims all of those.
const profileColumns = new Set(db.prepare(`PRAGMA table_info(profiles)`).all().map((c) => c.name));
if (!profileColumns.has('user_id')) {
  db.exec(`ALTER TABLE profiles ADD COLUMN user_id INTEGER`);
}
// Added for the post-playback recommendation screen's franchise-first
// ordering (direct sequels/prequels before generic "similar" picks) — a
// movie's TMDB collection (belongs_to_collection -> /collection/{id})
// cached alongside everything else in this row instead of a fresh fetch
// on every "up next" lookup. NULL/absent for rows cached before this
// existed, or for a movie with no collection, or for a `tv` row (shows
// don't have TMDB collections) — all three read back as "no collection",
// no special-casing needed by callers.
if (!detailCacheColumns.has('collection_json')) {
  db.exec(`ALTER TABLE tmdb_detail_cache ADD COLUMN collection_json TEXT`);
}
// Added for the movie/show detail pages' "Watch Trailer" button — a YouTube
// video key from TMDB's /videos endpoint, fetched and cached alongside
// everything else in this row. Same tolerance as collection_json above: a
// row cached before this existed just reads back as "no trailer" until its
// normal 365-day cache expiry re-fetches it, rather than needing a forced
// one-time refresh like similar_source did.
if (!detailCacheColumns.has('trailer_key')) {
  db.exec(`ALTER TABLE tmdb_detail_cache ADD COLUMN trailer_key TEXT`);
}

// Lightweight migration: add any columns above that don't exist yet on a
// database created by an earlier version of this schema, so upgrading
// doesn't require deleting library.db.
const existingColumns = new Set(db.prepare(`PRAGMA table_info(media_items)`).all().map((c) => c.name));
const expectedColumns = {
  backdrop_url: 'TEXT',
  overview: 'TEXT',
  release_year: 'INTEGER',
  rating: 'REAL',
  tmdb_id: 'INTEGER',
  tmdb_matched_title: 'TEXT',
  media_type: 'TEXT',
  content_rating: 'TEXT',
  // JSON arrays: [{index, codec, language, channels}] for audio,
  // [{index, codec, language}] for subtitles — `index` is the type-relative
  // stream index ffmpeg's `-map 0:a:N`/`0:s:N` selectors expect, populated
  // by ffprobe during scanning. Powers the player's audio-track selector
  // and the subtitle sidecar used by "Instant Replay".
  audio_tracks: 'TEXT',
  subtitle_tracks: 'TEXT',
};
for (const [col, type] of Object.entries(expectedColumns)) {
  if (!existingColumns.has(col)) {
    db.exec(`ALTER TABLE media_items ADD COLUMN ${col} ${type}`);
  }
}

// Backfill media_type for rows scanned before that column existed (it's
// added as NULL by the ALTER TABLE above, or by an earlier migration, and
// nothing retroactively fills it in otherwise). Without this, existing TV
// episodes never get routed to the TV matcher because the scanner branches
// on media_type — they'd silently keep going through the movie matcher
// forever, which is why previously-scanned TV files show up as "not
// found" even after the show/season/episode support was added.
db.exec(`
  UPDATE media_items SET media_type = 'tv'
  WHERE media_type IS NULL AND (file_path LIKE '%/TvShows/%' OR file_path LIKE '%\\TvShows\\%');
  UPDATE media_items SET media_type = 'movie'
  WHERE media_type IS NULL AND (file_path LIKE '%/Movies/%' OR file_path LIKE '%\\Movies\\%');
`);

module.exports = db;
