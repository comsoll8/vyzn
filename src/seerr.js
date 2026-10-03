// src/seerr.js
// Minimal client for Jellyseerr/Overseerr's request API, so a "Because you
// watched X" recommendation the user doesn't already own can be requested
// with one click instead of them having to go open Seerr themselves and
// search for it again.
//
// Jellyseerr is a fork of Overseerr and keeps the same v1 REST API, so one
// client covers both — the only thing that differs between them is the
// instance URL and API key the user points us at.
//
// Requires SEERR_URL (e.g. http://192.168.1.50:5055, no trailing slash
// needed) and SEERR_API_KEY (Settings > General > API Key in Jellyseerr/
// Overseerr's own UI).

const config = require('./config');

// Read dynamically (not cached at module load) so a URL/key entered in the
// Control Center Settings panel takes effect on the very next request,
// with no restart — see src/config.js.
function getUrl() {
  const raw = (config.get('SEERR_URL') || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  // fetch() throws "Failed to parse URL" on a schemeless host:port (e.g.
  // "192.168.1.246:5055", which is exactly what Jellyseerr/Overseerr's own
  // Settings > General page shows as "the URL" and what people naturally
  // paste in here) — it needs a protocol to be a valid URL at all. Default
  // to http:// (same as the rest of this app's own LAN-only setup guide)
  // rather than making every caller re-derive this.
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}
function getApiKey() {
  return config.get('SEERR_API_KEY') || null;
}

function isConfigured() {
  return Boolean(getUrl() && getApiKey());
}

// Submits a request for a movie or TV show by its TMDB id. For a TV show,
// Jellyseerr/Overseerr requests "all seasons" when no `seasons` array is
// given — the right default for a one-click request off a recommendation
// card, where the user just wants the show added, not a per-season prompt.
async function requestMedia(tmdbId, mediaType) {
  if (!isConfigured()) {
    throw new Error('Seerr is not configured (set SEERR_URL and SEERR_API_KEY)');
  }
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const seerrUrl = getUrl();

  let res;
  try {
    res = await fetch(`${seerrUrl}/api/v1/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': getApiKey(),
      },
      body: JSON.stringify({ mediaType: kind, mediaId: Number(tmdbId) }),
    });
  } catch (err) {
    throw new Error(`Could not reach Seerr at ${seerrUrl}: ${err.message}`);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page) — fall through with {}, the
    // res.ok check below still reports the right status.
  }

  if (!res.ok) {
    // Overseerr/Jellyseerr return 409 when the title has already been
    // requested (or is already available) — that's not really a failure
    // from the user's point of view, so it's flagged distinctly rather
    // than surfaced as a generic error.
    const err = new Error(data.message || `Seerr request failed (HTTP ${res.status})`);
    err.alreadyRequested = res.status === 409;
    throw err;
  }

  return data;
}

const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Seerr's own /search endpoint — a thin wrapper over TMDB search that also
// tags each hit with `mediaInfo.status` when Seerr already knows about it
// (2/3/4 = some flavor of "requested", 5 = "available"), so the search box
// can tell "add this" apart from "already on the way" without a second
// round trip. Person results are dropped — this app only ever shows movies
// and shows. Overseerr/Jellyseerr's REST API is camelCase throughout
// (posterPath, releaseDate, firstAirDate, etc.), unlike raw TMDB's
// snake_case, which is why this doesn't reuse tmdb.js's parsing.
async function search(query) {
  if (!isConfigured() || !query) return [];
  const seerrUrl = getUrl();

  let res;
  try {
    res = await fetch(`${seerrUrl}/api/v1/search?query=${encodeURIComponent(query)}&page=1`, {
      headers: { 'X-Api-Key': getApiKey() },
    });
  } catch (err) {
    throw new Error(`Could not reach Seerr at ${seerrUrl}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Seerr search failed (HTTP ${res.status})`);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON body — fall through with {}, results below just ends up [].
  }

  return (data.results || [])
    .filter((r) => r.mediaType === 'movie' || r.mediaType === 'tv')
    .map((r) => {
      const status = r.mediaInfo ? r.mediaInfo.status : null;
      return {
        tmdbId: r.id,
        mediaType: r.mediaType,
        title: r.mediaType === 'tv' ? r.name : r.title,
        overview: r.overview || null,
        releaseYear: (r.releaseDate || r.firstAirDate)
          ? parseInt((r.releaseDate || r.firstAirDate).slice(0, 4), 10)
          : null,
        posterUrl: r.posterPath ? `${IMAGE_BASE}/w500${r.posterPath}` : null,
        backdropUrl: r.backdropPath ? `${IMAGE_BASE}/w1280${r.backdropPath}` : null,
        // 5 = fully available in Seerr's own library already; 2/3/4 cover
        // pending/processing/partially-available — all "already in motion",
        // just not the finished state yet.
        alreadyAvailable: status === 5,
        alreadyRequested: status === 2 || status === 3 || status === 4,
      };
    });
}

module.exports = { isConfigured, requestMedia, search };
