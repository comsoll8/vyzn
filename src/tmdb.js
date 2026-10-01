// src/tmdb.js
// Minimal TMDB (The Movie Database) client used to enrich scanned files
// with real titles, posters, overviews and ratings.
//
// Requires TMDB_API_KEY (a v3 "API Key", not the longer v4 read token,
// though the v4 bearer token also works if you set TMDB_AUTH_TOKEN
// instead — see below). Get one free at https://www.themoviedb.org/settings/api
//
// Uses Node's built-in fetch (Node 18+).

// Docker containers (Unraid's default bridge network especially) very often
// have a route to the internet over IPv4 but no working IPv6 path. Since
// Node 18.13/20, `net.connect()` — which underlies `fetch()` — defaults to
// "Happy Eyeballs" dual-stack racing (`autoSelectFamily`): it resolves both
// IPv4 and IPv6 addresses and tries them against each other, regardless of
// `dns.setDefaultResultOrder()` (that setting only affects plain
// `dns.lookup()` calls, not this newer connect-racing algorithm — a common
// gotcha). When the IPv6 path is dead, every attempt in that race stalls,
// surfacing as `ETIMEDOUT` from `internalConnectMultiple` even though a
// plain IPv4 connection would work fine. Disabling autoSelectFamily
// entirely (falling back to a single, ordinary DNS-resolved connection)
// sidesteps the dead IPv6 route altogether. `setDefaultResultOrder` is kept
// too, so that single connection resolves IPv4 first.
const net = require('node:net');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}
require('node:dns').setDefaultResultOrder('ipv4first');

const config = require('./config');

const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const API_BASE = 'https://api.themoviedb.org/3';

// Read dynamically (not cached at module load) so a key entered in the
// Control Center Settings panel takes effect on the very next request,
// with no restart — see src/config.js.
function getApiKey() {
  return config.get('TMDB_API_KEY') || null;
}
function getAuthToken() {
  return config.get('TMDB_AUTH_TOKEN') || null; // v4 bearer token, alternative to the API key
}

function isConfigured() {
  return Boolean(getApiKey() || getAuthToken());
}

const MAX_RETRIES = 2;

async function tmdbFetch(pathname, params = {}, attempt = 0) {
  const apiKey = getApiKey();
  const authToken = getAuthToken();
  const url = new URL(API_BASE + pathname);
  if (apiKey) url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const headers = { Accept: 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    // Network-level failure (DNS hiccup, connection reset, etc.) — retry
    // with backoff instead of permanently giving up on this item.
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return tmdbFetch(pathname, params, attempt + 1);
    }
    throw err;
  }

  // 429 (rate limited) and 5xx are worth retrying; anything else (401, 404)
  // won't succeed on retry, so fail fast.
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 300 * (attempt + 1))));
      return tmdbFetch(pathname, params, attempt + 1);
    }
    throw new Error(`TMDB request failed: ${res.status} ${res.statusText} (${pathname}?${url.searchParams.toString()})`);
  }
  return res.json();
}

// TMDB's genre id->name lists are effectively static (they change maybe
// once a year, if ever), so fetch each once per process lifetime and cache
// it rather than hitting /genre/movie/list or /genre/tv/list per item.
// Note: /search/movie and /search/tv only return `genre_ids` (bare numeric
// ids), not names — these maps are what turn those ids into display names.
let movieGenreMap = null;
let tvGenreMap = null;

async function getMovieGenreMap() {
  if (movieGenreMap) return movieGenreMap;
  if (!isConfigured()) return new Map();
  try {
    const data = await tmdbFetch('/genre/movie/list');
    movieGenreMap = new Map((data.genres || []).map((g) => [g.id, g.name]));
  } catch (err) {
    return new Map(); // don't cache a failed fetch — try again next time
  }
  return movieGenreMap;
}

async function getTvGenreMap() {
  if (tvGenreMap) return tvGenreMap;
  if (!isConfigured()) return new Map();
  try {
    const data = await tmdbFetch('/genre/tv/list');
    tvGenreMap = new Map((data.genres || []).map((g) => [g.id, g.name]));
  } catch (err) {
    return new Map();
  }
  return tvGenreMap;
}

/**
 * Picks the best result from a TMDB search results list. Title relevance
 * is already handled by TMDB's own search ranking (results come back best-
 * match-first), so this only adjusts for year: if the filename gave us a
 * year, prefer a result whose release year matches exactly, then whichever
 * result is closest in time, before falling back to TMDB's top result.
 * Deliberately does NOT pass `year` as a hard filter on the API request —
 * TMDB's `year`/`first_air_date_year` params require an EXACT
 * primary_release_year match, and scene-release filenames are frequently
 * off by one from TMDB's canonical year (regional premiere vs. wide
 * release, festival cut, etc.), which silently returns zero results for
 * movies that are definitely in TMDB's database.
 */
function pickBestResult(results, year, dateField) {
  if (!results || results.length === 0) return null;
  if (!year) return results[0];

  let best = null;
  let bestDiff = Infinity;
  for (const r of results) {
    const dateStr = r[dateField];
    if (!dateStr) continue;
    const resultYear = parseInt(dateStr.slice(0, 4), 10);
    if (Number.isNaN(resultYear)) continue;
    const diff = Math.abs(resultYear - year);
    if (diff === 0) return r; // exact year match wins outright
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  // Only trust a near-year match within a couple of years — beyond that
  // it's more likely a same-titled different film than a mislabeled year.
  if (best && bestDiff <= 2) return best;
  return results[0];
}

/**
 * Cleans a raw filename-derived title into something searchable:
 * strips release-group tags, resolution/codec markers, and pulls out a
 * year if present (e.g. "The.Matrix.1999.1080p.BluRay.x264-GROUP").
 */
function parseFilenameTitle(rawTitle) {
  let year = null;

  // First, handle the common "Title (Year) ..." layout explicitly: pull
  // the year out and remove the whole parenthetical, so we don't leave
  // an empty "( )" behind. Anything after the year-parenthetical is
  // assumed to be quality/edition noise (Bluray-1080p, Remux-2160p,
  // Proper, etc.) and cut entirely, since it's never part of the title.
  const parenYearMatch = rawTitle.match(/^(.*?)\s*\((19|20)\d{2}\)\s*(.*)$/);
  let working = rawTitle;
  if (parenYearMatch) {
    year = parseInt(rawTitle.match(/\((19|20)\d{2}\)/)[0].slice(1, -1), 10);
    working = parenYearMatch[1]; // keep only what precedes "(Year)"
  } else {
    const bareYearMatch = rawTitle.match(/\b(19|20)\d{2}\b/);
    if (bareYearMatch) year = parseInt(bareYearMatch[0], 10);
  }

  const junkPattern = new RegExp(
    [
      '\\b(19|20)\\d{2}\\b', // bare year (parenthetical case already stripped above)
      '\\b\\d{3,4}p\\b', // resolution: 1080p, 2160p
      '\\b(BluRay|BRRip|WEBRip|WEB-?DL|HDRip|DVDRip|HDTV|Remux|BR-?DISK)\\b',
      '\\b(x264|x265|H ?264|H ?265|HEVC|AAC|AC3|DTS)\\b',
      '\\b(PROPER|REPACK|EXTENDED|UNRATED|REMASTERED|UNCUT)\\b',
      '\\[.*?\\]', // bracketed release tags
      '-\\w+$', // trailing "-GROUPNAME"
    ].join('|'),
    'gi'
  );

  const cleaned = working
    .replace(junkPattern, ' ')
    .replace(/[()[\]]/g, ' ') // drop any leftover empty/stray brackets
    .replace(/\s*-\s*$/g, '') // trailing dangling hyphen ("Title -")
    .replace(/\s+/g, ' ')
    .trim();

  return { cleanedTitle: cleaned || rawTitle.trim(), year };
}

/**
 * Fetches the US theatrical certification (G/PG/PG-13/R/NC-17) for a movie.
 * Returns null if TMDB has no US certification on file.
 */
async function getMovieCertification(tmdbId) {
  try {
    const data = await tmdbFetch(`/movie/${tmdbId}/release_dates`);
    const us = (data.results || []).find((r) => r.iso_3166_1 === 'US');
    if (!us) return null;
    const withCert = (us.release_dates || []).find((d) => d.certification);
    return withCert ? withCert.certification || null : null;
  } catch (err) {
    return null;
  }
}

/**
 * Fetches the US TV content rating (TV-Y ... TV-MA) for a show.
 */
async function getTvContentRating(tmdbId) {
  try {
    const data = await tmdbFetch(`/tv/${tmdbId}/content_ratings`);
    const us = (data.results || []).find((r) => r.iso_3166_1 === 'US');
    return us ? us.rating || null : null;
  } catch (err) {
    return null;
  }
}

/**
 * Searches TMDB for a movie matching the given title (and optional year),
 * returning the best-guess match or null if nothing configured/found.
 */
async function lookupMovie(rawTitle) {
  if (!isConfigured()) return null;

  const { cleanedTitle, year } = parseFilenameTitle(rawTitle);

  // No `year` param here — see pickBestResult's comment for why passing it
  // as a hard API filter causes false negatives on real matches.
  const data = await tmdbFetch('/search/movie', {
    query: cleanedTitle,
    include_adult: false,
  });

  const best = pickBestResult(data.results, year, 'release_date');
  if (!best) return null;

  const contentRating = await getMovieCertification(best.id);
  const genreMap = await getMovieGenreMap();
  const genres = (best.genre_ids || [])
    .map((id) => ({ id, name: genreMap.get(id) }))
    .filter((g) => g.name);

  return {
    tmdbId: best.id,
    matchedTitle: best.title,
    overview: best.overview || null,
    releaseYear: best.release_date ? parseInt(best.release_date.slice(0, 4), 10) : null,
    rating: typeof best.vote_average === 'number' ? best.vote_average : null,
    posterUrl: best.poster_path ? `${IMAGE_BASE}/w500${best.poster_path}` : null,
    backdropUrl: best.backdrop_path ? `${IMAGE_BASE}/w1280${best.backdrop_path}` : null,
    mediaType: 'movie',
    contentRating,
    genres,
  };
}

/**
 * Searches TMDB for a TV show matching the given title (and optional year).
 * Used for anything under the TvShows top-level folder; individual episode
 * filenames are cleaned the same way as movie filenames before searching,
 * which works reasonably well for show-name matching even though season/
 * episode numbers themselves aren't parsed yet (each episode file just
 * matches to the parent show's metadata).
 */
async function lookupTv(rawTitle) {
  if (!isConfigured()) return null;

  const { cleanedTitle, year } = parseFilenameTitle(rawTitle);

  // No `first_air_date_year` param here — same reasoning as lookupMovie.
  const data = await tmdbFetch('/search/tv', {
    query: cleanedTitle,
    include_adult: false,
  });

  const best = pickBestResult(data.results, year, 'first_air_date');
  if (!best) return null;

  const contentRating = await getTvContentRating(best.id);
  const genreMap = await getTvGenreMap();
  const genres = (best.genre_ids || [])
    .map((id) => ({ id, name: genreMap.get(id) }))
    .filter((g) => g.name);

  return {
    tmdbId: best.id,
    matchedTitle: best.name,
    overview: best.overview || null,
    releaseYear: best.first_air_date ? parseInt(best.first_air_date.slice(0, 4), 10) : null,
    rating: typeof best.vote_average === 'number' ? best.vote_average : null,
    posterUrl: best.poster_path ? `${IMAGE_BASE}/w500${best.poster_path}` : null,
    backdropUrl: best.backdrop_path ? `${IMAGE_BASE}/w1280${best.backdrop_path}` : null,
    mediaType: 'tv',
    contentRating,
    genres,
  };
}

/**
 * Fetches the full genre list for a movie already known to TMDB. Unlike a
 * search result (which only carries bare `genre_ids`), the movie details
 * endpoint returns `genres: [{id, name}, ...]` directly, so no genre-map
 * lookup is needed here — used by the "backfill genres" settings action
 * for movies that were matched before genre tagging existed.
 */
async function getMovieGenres(tmdbId) {
  try {
    const data = await tmdbFetch(`/movie/${tmdbId}`);
    return (data.genres || []).map((g) => ({ id: g.id, name: g.name })).filter((g) => g.name);
  } catch (err) {
    return [];
  }
}

/**
 * Same as getMovieGenres, for a TV show.
 */
async function getTvGenres(tmdbId) {
  try {
    const data = await tmdbFetch(`/tv/${tmdbId}`);
    return (data.genres || []).map((g) => ({ id: g.id, name: g.name })).filter((g) => g.name);
  } catch (err) {
    return [];
  }
}

/**
 * Fetches season-level metadata (title/overview/poster) for a show.
 */
async function getSeasonDetails(showTmdbId, seasonNumber) {
  try {
    const data = await tmdbFetch(`/tv/${showTmdbId}/season/${seasonNumber}`);
    return {
      tmdbId: data.id || null,
      title: data.name || null,
      overview: data.overview || null,
      posterUrl: data.poster_path ? `${IMAGE_BASE}/w500${data.poster_path}` : null,
      airDate: data.air_date || null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Fetches episode-level metadata (title/overview/still) for a show.
 */
async function getEpisodeDetails(showTmdbId, seasonNumber, episodeNumber) {
  try {
    const data = await tmdbFetch(`/tv/${showTmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
    return {
      title: data.name || null,
      overview: data.overview || null,
      stillUrl: data.still_path ? `${IMAGE_BASE}/w300${data.still_path}` : null,
      airDate: data.air_date || null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Fetches top cast + key crew for a movie, for the movie detail page.
 * Cast is capped at 10 (detail page only shows a "top cast" carousel, not
 * the full credits list). Crew is trimmed down to the director and any
 * writer/screenplay credits — TMDB's crew list includes everyone from
 * editors to costume designers, most of which the detail page has no use
 * for.
 */
// Deliberately does NOT catch its own errors — the caller (server.js's
// getMovieDetailData) needs to know a real failure happened so it doesn't
// cache an empty result for 365 days. A genuinely-empty credits list from
// TMDB (rare, but possible for an obscure title) is a valid, cacheable
// result; a network/rate-limit/auth failure is not the same thing and must
// not look identical to one.
async function getMovieCredits(tmdbId) {
  const data = await tmdbFetch(`/movie/${tmdbId}/credits`);
  const cast = (data.cast || []).slice(0, 10).map((c) => ({
    name: c.name,
    character: c.character || null,
    profileUrl: c.profile_path ? `${IMAGE_BASE}/w185${c.profile_path}` : null,
  }));
  const crew = data.crew || [];
  const director = crew.find((c) => c.job === 'Director');
  const writerNames = [...new Set(
    crew
      .filter((c) => c.department === 'Writing' || c.job === 'Writer' || c.job === 'Screenplay')
      .map((c) => c.name)
  )];
  return { cast, director: director ? director.name : null, writers: writerNames };
}

/**
 * Fetches top cast + creators for a TV show, for the Show Detail page.
 * TMDB's /tv/{id}/credits doesn't carry the showrunner/creator credit —
 * that's a separate `created_by` field only on the plain /tv/{id} details
 * endpoint — so this fetches both in parallel. Same non-swallowing contract
 * as getMovieCredits (see its comment): a real TMDB failure must not look
 * like "this show genuinely has no cast" to the caller's 365-day cache.
 */
async function getShowCredits(tmdbId) {
  const [creditsData, showData] = await Promise.all([
    tmdbFetch(`/tv/${tmdbId}/credits`),
    tmdbFetch(`/tv/${tmdbId}`),
  ]);
  const cast = (creditsData.cast || []).slice(0, 10).map((c) => ({
    name: c.name,
    character: c.character || null,
    profileUrl: c.profile_path ? `${IMAGE_BASE}/w185${c.profile_path}` : null,
  }));
  const creators = (showData.created_by || []).map((c) => c.name);
  return { cast, creators };
}

/**
 * Fetches TMDB's "similar movies" list for the movie detail page's "More
 * Like This" shelf. Only tmdbId + title are needed here — the caller
 * cross-references these ids against the local library and pulls full
 * metadata from there, since "More Like This" only ever shows titles that
 * actually exist in the library.
 */
// Also doesn't swallow its own errors, for the same reason as
// getMovieCredits above — see that function's comment.
async function getSimilarMovies(tmdbId) {
  if (!isConfigured() || !tmdbId) return [];
  const data = await tmdbFetch(`/movie/${tmdbId}/similar`);
  return (data.results || []).map((r) => ({ tmdbId: r.id, title: r.title }));
}

/**
 * Non-swallowing counterpart to getRecommendations() below, used only by
 * the movie detail page's "More Like This" shelf (see getMovieDetailData
 * in server.js). TMDB's /recommendations endpoint is based on actual
 * "people who watched this also watched" behavior data and is noticeably
 * more relevant than /similar (getSimilarMovies above), which mostly just
 * groups movies by shared genres/keywords and can turn up odd pairings
 * (an action movie and an unrelated kids' movie sharing a "family" or
 * "adventure" tag, say). getMovieDetailData tries this first and only
 * falls back to getSimilarMovies for titles with no recommendations data
 * at all. Kept separate from getRecommendations() because that function
 * intentionally swallows its own errors (used live on every Home page
 * load, where a transient failure should just skip a shelf) while this
 * one must NOT — see getMovieCredits' comment for why.
 */
async function getMovieRecommendationsRaw(tmdbId) {
  if (!isConfigured() || !tmdbId) return [];
  const data = await tmdbFetch(`/movie/${tmdbId}/recommendations`);
  return (data.results || []).map((r) => ({ tmdbId: r.id, title: r.title }));
}

/**
 * TV counterparts to getMovieRecommendationsRaw/getSimilarMovies above,
 * used by the post-playback "recommendations" screen for a show that just
 * ran out of episodes. Same non-swallowing/caller-cross-references-the-
 * local-library contract as the movie versions.
 */
async function getTvRecommendationsRaw(tmdbId) {
  if (!isConfigured() || !tmdbId) return [];
  const data = await tmdbFetch(`/tv/${tmdbId}/recommendations`);
  return (data.results || []).map((r) => ({ tmdbId: r.id, title: r.name }));
}

async function getSimilarTv(tmdbId) {
  if (!isConfigured() || !tmdbId) return [];
  const data = await tmdbFetch(`/tv/${tmdbId}/similar`);
  return (data.results || []).map((r) => ({ tmdbId: r.id, title: r.name }));
}

/**
 * A movie's other entries in the same TMDB "collection" (its franchise —
 * sequels, prequels, sometimes a reboot), for the post-playback
 * recommendation screen's "direct sequels/prequels first" ordering. TMDB
 * doesn't return `belongs_to_collection` from search results (that's only
 * on the full /movie/{id} details endpoint, one extra fetch beyond what
 * scanning already does), so this fetches that, then the collection
 * itself if there is one. Sorted oldest-release-first, which is usually
 * (not always — some franchises are numbered out of release order) also
 * story order, a reasonable default for "what comes next".
 */
async function getMovieCollection(tmdbId) {
  if (!isConfigured() || !tmdbId) return [];
  const movie = await tmdbFetch(`/movie/${tmdbId}`);
  if (!movie.belongs_to_collection) return [];
  const collection = await tmdbFetch(`/collection/${movie.belongs_to_collection.id}`);
  return (collection.parts || [])
    .filter((p) => p.id !== tmdbId)
    .sort((a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999'))
    .map((p) => ({ tmdbId: p.id, title: p.title }));
}

/**
 * Fetches TMDB's "recommendations" carousel for a given item, used to
 * build "Because you watched X" rows.
 */
async function getRecommendations(tmdbId, mediaType) {
  if (!isConfigured() || !tmdbId) return [];
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  try {
    const data = await tmdbFetch(`/${kind}/${tmdbId}/recommendations`);
    return (data.results || []).map((r) => ({
      tmdbId: r.id,
      title: kind === 'tv' ? r.name : r.title,
      overview: r.overview || null,
      releaseYear: (r.release_date || r.first_air_date)
        ? parseInt((r.release_date || r.first_air_date).slice(0, 4), 10)
        : null,
      posterUrl: r.poster_path ? `${IMAGE_BASE}/w500${r.poster_path}` : null,
      backdropUrl: r.backdrop_path ? `${IMAGE_BASE}/w1280${r.backdrop_path}` : null,
      mediaType: kind,
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Fetches a YouTube trailer key for a movie or show, for the detail page's
 * "Watch Trailer" button. Prefers an official trailer, then any trailer,
 * then a teaser, so something plays even for a title with no proper
 * trailer uploaded. Returns null (not an empty string) when nothing usable
 * is found, so the caller can cleanly tell "no trailer" from "not fetched
 * yet". Same non-swallowing contract as getMovieCredits/getShowCredits (see
 * that comment) — the caller's cache must not learn "no trailer" from a
 * network blip.
 */
async function getTrailerKey(tmdbId, mediaType) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/${kind}/${tmdbId}/videos`);
  const videos = data.results || [];
  const trailer =
    videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
    videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
    videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser');
  return trailer ? trailer.key : null;
}

module.exports = {
  isConfigured,
  parseFilenameTitle,
  lookupMovie,
  lookupTv,
  getSeasonDetails,
  getEpisodeDetails,
  getRecommendations,
  getMovieGenreMap,
  getTvGenreMap,
  getMovieGenres,
  getTvGenres,
  getMovieCredits,
  getShowCredits,
  getSimilarMovies,
  getMovieRecommendationsRaw,
  getTvRecommendationsRaw,
  getSimilarTv,
  getMovieCollection,
  getTrailerKey,
};
