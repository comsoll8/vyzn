# VYZN

A self-hosted media server for Unraid: scans a folder for video files,
indexes them in SQLite with TMDB metadata (movies and a full Show ->
Season -> Episode hierarchy for TV), and serves them as HLS streams for
playback in a browser or the native Android TV app (`android-tv/`). See
"Release history" below for exactly what shipped in which version of each.

## What's here

```
vyzn/
├── src/
│   ├── server.js       # Fastify HTTP API + serves the browser frontend
│   ├── db.js           # SQLite schema + connection
│   ├── scanner.js      # Walks MEDIA_DIR, extracts metadata via ffprobe
│   ├── tmdb.js         # TMDB title cleanup + lookup (movies, TV shows/seasons/episodes)
│   ├── streamer.js     # On-demand ffmpeg -> HLS transcoding
│   ├── seerr.js        # Jellyseerr/Overseerr client for "Add to Library"
│   ├── ratings.js      # Shared movie/TV content-rating ordinal for profile gating
│   └── concurrency.js  # Small concurrency-limited map helper
├── public/             # Browser GUI: poster grid, search, HLS player
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── assets/         # VYZN logo + favicons
├── android-tv/         # Native Android TV / Google TV app (own README.md)
│   └── app/src/main/java/com/vyzn/tv/
│       ├── MainActivity.kt         # WebView shell around the browser GUI
│       ├── PlayerActivity.kt       # Native ExoPlayer screen (real 5.1 audio)
│       └── NativePlayerBridge.kt   # JS <-> native playback handoff
├── Dockerfile
├── entrypoint.sh       # Remaps container user to Unraid's PUID/PGID
├── docker-compose.yml
└── package.json
```

## Browser GUI

Open `http://<unraid-ip>:18080/` in a browser (Chrome/Firefox/Edge; Safari
works too, using native HLS instead of hls.js) for the full app: poster
grid with Movies/TV Shows/genre shelves, a Show -> Season -> Episode
hierarchy, search (local + Seerr), profiles, Settings, and the HLS player.
It's served by the same container — no separate deploy step. This same
frontend is also what the Android TV app shows inside its WebView (see
`android-tv/README.md`), so there isn't a separate "TV UI" to keep in sync
— the one exception is video playback, which the TV app hands off to a
native ExoPlayer screen instead of the browser's HLS player, for real
multichannel audio.

## API

| Method | Path                | Description                          |
|--------|---------------------|---------------------------------------|
| GET    | `/health`            | Liveness check                        |
| GET    | `/api/library`       | List all indexed media (`?q=` search, `?profile_id=` content-rating filter) |
| GET    | `/api/library/:id`   | Single item's metadata                |
| POST   | `/api/scan`          | Kick off a library scan (async)       |
| GET    | `/api/scan/status`   | Status of the most recent scan        |
| GET    | `/api/scan/progress` | Live scan progress (Server-Sent Events) |
| GET    | `/api/stream/:id`    | Starts transcode, returns HLS playlist URL |
| GET    | `/api/profiles`      | List profiles                         |
| POST   | `/api/profiles`      | Create a profile (`{name, is_child, max_content_rating}`) |
| PUT    | `/api/profiles/:id`  | Update a profile                      |
| DELETE | `/api/profiles/:id`  | Delete a profile                      |
| POST   | `/api/profiles/:id/progress` | Record playback position (`{media_id, position_seconds, duration_seconds}`) |
| GET    | `/api/profiles/:id/continue-watching` | Items 5%-90% watched, most recent first |
| GET    | `/api/profiles/:id/recommendations` | "Because you watched X" shelves from TMDB |
| GET    | `/api/profiles/:id/trending` | Highest-rated matched items the profile can see |
| GET    | `/api/seerr/search?query=&profile_id=` | Extends search past the local library into Seerr (owned hits merged into real library cards, unowned ones offered as "+ Add to Library") |
| POST   | `/api/seerr/request` | One-click "add this" on an unowned recommendation/search card (`{tmdbId, mediaType}`) |
| GET    | `/api/settings`      | Server/library info for the settings page (counts, config, last scan) |
| GET    | `/api/settings/config` | Editable TMDB/Seerr/transcode/Tailscale settings (secrets masked) |
| PUT    | `/api/settings/config` | Save editable settings — takes effect immediately, no restart |
| GET    | `/api/version`       | Current version vs. latest GitHub release, for "Check for Updates" |
| GET    | `/api/tailscale/status` | Whether Tailscale is installed/connected, and this node's tailnet IP |
| POST   | `/api/tailscale/connect` | Connect to Tailscale (`{authKey}`, or reuses a previously-saved key) |
| POST   | `/api/tailscale/disconnect` | Disconnect from Tailscale |
| POST   | `/api/library/retry-unmatched` | Re-run TMDB matching for unmatched items only |
| GET    | `/api/library/unmatched` | List items with no TMDB match yet, for the settings page |
| POST   | `/api/library/:id/rematch` | Retry one item with an overridden title/media type (`{title, media_type}`) |
| POST   | `/api/library/purge` | Delete indexed rows whose path contains a substring (`{path_contains}`) |
| DELETE | `/api/library?confirm=true` | Wipe all indexed metadata (files on disk untouched) |
| GET    | `/api/genres`        | All genres present in the library, alphabetical, with a combined item count |
| GET    | `/api/genres/:id/media` | Movies + shows tagged with a genre (`?profile_id=` content-rating filter) |
| POST   | `/api/library/backfill-genres` | Re-fetch genres for already-matched items only (no other fields touched) |
| GET    | `/api/library/:id/details` | Full movie detail page payload: genres, playback progress, director/writers/top cast, "More Like This" (`?refresh=true` bypasses the TMDB cache) |

Streamed files are served under `/stream-files/<id>/index.m3u8`.

**Note:** the stream endpoint is `GET`, not `POST` — an earlier version of
the frontend called it with `POST` while the route was registered as
`GET`, which 404'd and surfaced in the browser as "Failed to start
stream: No playlist URL returned" even though ffmpeg/VAAPI were never
actually invoked. Fixed by making the frontend call it as a plain `GET`.

## Settings page

The gear icon in the top bar opens a settings overlay (`public/index.html`'s
`#settingsOverlay`, wired up in `public/app.js`) with four sections:

- **Library**: trigger a full scan or a metadata-only "Retry Unmatched"
  pass (progress shows in the bar at the top of the page, same as the main
  Scan Library button); purge indexed rows whose path contains a substring
  (handy for cleaning up a Recycle Bin or Downloads folder that got
  scanned before `SCAN_ONLY_DIRS` was set); and a danger-zone "Wipe
  library" button that clears all indexed metadata (never touches files on
  disk) for a clean re-scan.
- **Unmatched items** (`GET /api/library/unmatched`): every item with no
  TMDB match yet, each with its file path, an editable search-title field
  (prefilled with the current title so you can tweak it — drop a stray
  word, fix a typo, add the real title if the filename is too mangled to
  auto-clean), a Movie/TV Show override (for the rare case a file landed
  in the wrong media type), a per-item Rematch button, and a Remove button
  to drop a file from the library entirely (e.g. a sample clip or extra
  that isn't a real title) without touching it on disk. A row disappears
  from the list automatically once it matches.
- **Profiles**: every profile listed with an inline editable name, kids
  toggle, and max content rating, a Save button per row, and a Delete
  button (deleting the profile you're currently using bounces you back to
  the profile picker). A form at the bottom adds new profiles without
  leaving settings.
- **System info**: version, whether TMDB is configured, hardware
  transcoding on/off, the media folder, scanned top-level folders, and
  at-a-glance counts (movies/episodes/shows/unmatched/profiles) plus the
  last scan's result — all read from `GET /api/settings`, which never
  exposes the actual TMDB API key. Also has a "Check for Updates" button
  (see "Versioned releases" below).
- **Connections**: TMDB, Seerr, and hardware-transcoding settings,
  editable from the UI and saved to the server's own database instead of
  docker-compose.yml — see "Runtime-editable settings" below.
- **Remote Access (Tailscale)**: paste an auth key and connect this
  server to your private Tailscale network — see "Remote access via
  Tailscale" below.

## Runtime-editable settings (`src/config.js`)

TMDB, Seerr, and transcoding settings don't have to live in
docker-compose.yml. A `settings` table in the server's own SQLite DB can
hold an override for any of them, and `src/config.js` is the single place
that resolves a setting's live value: a DB override wins if one exists,
otherwise it falls back to the matching environment variable, otherwise
null. Every read goes through `config.get()`/`config.getBool()` at the
moment it's needed — `tmdb.js`, `seerr.js`, and `streamer.js` all read
through it now instead of caching `process.env` into a module-load-time
constant — so a value entered in Control Center > Settings takes effect
on the very next request, with no restart.

The editable keys (`config.SCHEMA`): `TMDB_API_KEY`, `TMDB_AUTH_TOKEN`,
`SEERR_URL`, `SEERR_API_KEY`, `HW_TRANSCODE`, `VAAPI_DEVICE`, and
`TAILSCALE_AUTHKEY`. `GET /api/settings/config` returns all of them
(secrets masked — the client only ever learns whether one is set, never
its value) and `PUT /api/settings/config` saves edits; a secret field left
showing the mask placeholder is treated as "untouched" rather than
overwriting the real stored value with dots. Clearing a field (saving it
empty) deletes the DB override rather than storing an empty string, so the
env var takes over again.

This is what makes a from-scratch install self-configurable: a fresh
`docker-compose.yml` can ship with no TMDB/Seerr values at all, and
whoever's running the server just fills them in from the Settings page
after first launch.

## Public access with Tailscale Funnel (for devices that can't run Tailscale)

Devices like an Xbox can't join a tailnet, but Edge can open a public HTTPS address. Tailscale Funnel publishes VYZN at `https://<hostname>.<tailnet>.ts.net` with no router changes or extra software:

1. In the Tailscale admin console, enable **HTTPS Certificates** (DNS page) and allow Funnel for the node (Access controls → the `funnel` node attribute; new tailnets usually have it by default).
2. Make sure an account exists first (VYZN is open until the first account is created, so never publish it before then).
3. Run, on the Unraid host: `docker exec vyzn tailscale funnel --bg 8080`
4. Check with `docker exec vyzn tailscale funnel status`; stop with `docker exec vyzn tailscale funnel --bg 8080 off`.

Over HTTPS the sign-in cookie is marked `Secure`, and logins are rate-limited per client and per account.

## Remote access via Tailscale

A Tailscale client (`tailscaled` + the `tailscale` CLI) runs inside the
same container as the app — no separate sidecar. `entrypoint.sh` starts
`tailscaled` in the background (state kept under `/config/tailscale`, so
it survives a container recreate) before dropping to the unprivileged
`node` user that runs the Node app; the daemon's control socket is
`chmod 666`'d so that user can still issue `tailscale` CLI commands
without needing to run as root.

Requires `cap_add: NET_ADMIN` and a `/dev/net/tun:/dev/net/tun` device
mapping in docker-compose.yml (both already in the shipped file) — without
them `tailscaled` can't create its network interface at all, and the
Settings panel's Tailscale status just reports "not installed"/errors
instead of the app failing to start.

Connecting is one click from Control Center > Settings > Remote Access:
paste an auth key from the
[Tailscale admin console](https://login.tailscale.com/admin/settings/keys)
and hit Connect. That POSTs to `/api/tailscale/connect`
(`src/tailscale.js`), which shells out to `tailscale up --accept-dns=false
--hostname=vyzn` with the given key (also saved to `config.js` as
`TAILSCALE_AUTHKEY` so a reconnect doesn't need it re-entered) and reports
back the assigned Tailscale IP/hostname. `--accept-dns=false` is
deliberate — letting Tailscale take over the container's DNS resolution
would risk breaking its regular internet access to TMDB/Seerr, which has
nothing to do with the private tailnet. `GET /api/tailscale/status` and
`POST /api/tailscale/disconnect` round out the panel.

With this connected, the server is reachable from any device on your
tailnet (phone, laptop, an Android TV running the official Tailscale app)
at its Tailscale IP/hostname — no port-forwarding, and nothing exposed to
the open internet.

## Versioned releases & GitHub Container Registry

The server image is built and published to `ghcr.io/comsoll8/vyzn` by
`.github/workflows/publish.yml` whenever a `vX.Y.Z` tag is pushed (e.g.
`git tag v0.3.0 && git push origin v0.3.0`) — that one tag push is the
entire "cut a release" step. The same workflow also does a build-only
(non-publishing) run on every push to `main`, as a build-health check.

`docker-compose.ghcr.yml` is the install path for a server that just
wants to *run* VYZN — a friend's Unraid box, say — without ever touching
this source repo: it references the published image (`image:
ghcr.io/comsoll8/vyzn:latest`) instead of building, and otherwise mirrors
`docker-compose.yml`'s env vars, volumes, and devices. Deploying VYZN to a
new machine is then: copy that file in as `docker-compose.yml`, edit the
two volume paths and the timezone, `docker compose up -d`, and finish the
rest (TMDB, Seerr, Tailscale) from the Settings page once it's running —
no editing source, no rebuild.

"Check for Updates" in Control Center > Settings (`GET /api/version`)
compares the running image's `package.json` version against the latest
GitHub release tag and reports whether a newer one exists, with a link to
its release notes. It's deliberately a manual check, not an automatic
puller like Watchtower — installing an available update is still just
`docker compose pull && docker compose up -d`, run by whoever administers
that server, whenever they choose to.

## Release history

Two independently-versioned things live in this one repo: the **server**
(tagged `vX.Y.Z`, published to GHCR as above) and the **Android TV app**
(tagged `tv-vN`, distributed as a GitHub Release APK — see
`android-tv/README.md`). They don't ship in lockstep, so check both lists
for "am I up to date."

**Server** (`package.json` version, [all tags](https://github.com/comsoll8/vyzn/tags)):

- **v0.2.0** — first tagged release. Core server + browser GUI: library
  scan, TMDB matching, HLS playback, TV Show -> Season -> Episode
  hierarchy, profiles/parental ratings, Settings page, Tailscale remote
  access. The Android TV app (still a plain WebView at this point) shipped
  in the same commit.
- **v0.2.1 / v0.2.2** — configurable TV-folder name instead of hardcoded
  `TvShows`, trimmed whitespace in Settings fields, pulsing-logo loading
  state in place of the old top progress bar, hero/first-shelf blend fix,
  an Unraid Community Applications template, and the `media-server` ->
  `vyzn` container rename.
- **v0.3.0** — a TV-focused density/layout pass (smaller poster cards,
  bigger hero, one shelf per screen, overscan safe-area padding, title/year
  overlaid on the poster) plus several WebView-specific scroll/repaint
  fixes for Android TV, and a Google Play privacy-policy page.
- **v0.3.1** — D-pad vertical navigation aligns the whole shelf to the top
  of the screen instead of nudging just the focused card into view.
- **v0.3.2** — fixed `scrollShelfToTop` ignoring the rows
  container's own top padding.
- **v0.3.3** — Seerr URL scheme fix, Home shelves shuffle together, Add to
  Library corner "+" button with long-press, removed the redundant "Not in
  library" badge, TMDB and Abyss attribution.
- **v0.3.4** — automatic transcode cache cleanup (the
  `/transcode` folder previously grew forever).
- **v0.4.0** — accounts and sign-in: login screen with QR
  pairing from your phone, "Remember This Device", Sign Out, Settings >
  Accounts. Off until you create the first account (see "Accounts &
  sign-in").
- **v0.5.0** — Tautulli-style admin dashboard (live activity,
  play log, stats charts, user management) and 25 built-in profile pictures.
- **v0.5.5** (current) — the TV app's native player now also sends the login as a Bearer token and shows the HTTP status in playback errors; Android builds use one fixed debug key so they update in place.
- **v0.5.4** — with sign-in on, old Android TV app builds fall back to the in-page player instead of failing with `ERROR_CODE_IO_BAD_HTTP_STATUS`; the new app build (tv-v3) forwards the login to the native player.
- **v0.5.3** — automatic library scanning (daily at a set time, or when new files appear).
- **v0.5.2** — DVD/Blu-ray extras (bonus content, deleted scenes, alternate endings, trailers) are no longer indexed as extra copies of a movie, and ones already indexed are removed on the next scan.
- **v0.5.1** — hamburger menu replaced by pill tabs in the top bar (matching the
  admin dashboard); Control Center spacing fixed; the genre pill now appears
  only on Movies and TV Shows (where it filters the grid), not Home; the admin dashboard has a "Back to VYZN" button and responds to
  the remote's Back key.

**Android TV app** (`android-tv/`, [all releases](https://github.com/comsoll8/vyzn/releases)):

- **tv-v1 (vyzn1.0)** — first real build: WebView shell (browsing, search,
  settings — all the same web app the browser uses) plus a native
  ExoPlayer playback screen (`GET /api/raw/:id`) so multichannel 5.1 audio
  reaches the TV/AVR untouched instead of being downmixed like browser
  playback. Release signing wired up for Play Console.
- **tv-v2 (vyzn1.1)** — portrait support on phones/tablets (TV hardware
  stays landscape-locked as before), a subtitle on/off toggle in the
  native player, the native player's controls re-themed to match the web
  player's minimalist look, and Continue Watching cards play directly
  instead of detouring through a detail page.
- **Unreleased on `main`** (will be `tv-v3`): native "Up Next" card that
  auto-advances to the next TV episode (see `android-tv/README.md`).

## Genres

Every movie and TV show gets tagged with its TMDB genres during scanning,
and the Home screen builds Apple-TV-style horizontal shelves out of them:

- **Schema** (`src/db.js`): a `genres` table keyed by TMDB's own genre id
  (so "Action", "Comedy", "Drama" etc. share one row between movies and TV,
  while TV-only genres like "Sci-Fi & Fantasy" or "Kids" don't collide with
  anything), plus two junction tables — `media_genres` links a genre to a
  movie (a `media_items` row), `show_genres` links a genre to a whole TV
  show. Genre is a show-level concept, not a per-episode one, so individual
  episodes aren't tagged directly.
- **TMDB ingestion** (`src/tmdb.js`, `src/scanner.js`): TMDB's `/search/movie`
  and `/search/tv` only return bare `genre_ids` (numbers, no names), so
  `tmdb.js` fetches and caches `/genre/movie/list` and `/genre/tv/list`
  once per process (these lists are effectively static) and uses them to
  resolve each match's `genre_ids` into `{id, name}` pairs. `scanner.js`
  upserts those into `genres` and links them — to `media_genres` right
  after a movie is matched, to `show_genres` right after a show is
  created/matched (inside `findOrCreateShow`, so every episode of a show
  contributes the same show-level tags without re-fetching per episode). A
  rematch (`POST /api/library/:id/rematch`) re-links a movie's genres too,
  clearing any stale ones first.
- **API**: `GET /api/genres` lists every genre actually used in the
  library, alphabetical, each with a combined movie+show item count so the
  frontend can skip building UI for a genre nothing is tagged with. `GET
  /api/genres/:id/media` returns that genre's movies and shows together
  (each tagged `kind: "movie"` or `kind: "show"` so the frontend knows
  whether to play it directly or open the show's episode list), honoring
  `?profile_id=` the same way `/api/library` and `/api/shows` do.
- **Frontend** (`public/app.js`): a sticky glassmorphism pill row under the
  tab bar (`#genrePills`) — "All" scrolls back to the top, each genre pill
  smooth-scrolls to that genre's shelf. The Home view renders up to 8
  genre shelves (highest item count first) below Trending, reusing the
  same poster-card component as everything else, plus a hover-revealed
  "⋮" action menu (Play/View Episodes + More Info, which sets that item as
  the hero and scrolls to the top — a lightweight Netflix/Apple-TV-style
  "more info" pattern). A shelf simply doesn't render if a profile's
  content-rating limit filters its genre down to nothing.
- **Backfilling an existing library**: genre tagging only happens as part
  of the normal TMDB-matching pass, which skips anything that already has
  a `tmdb_id` — so a library that was fully matched before genre shelves
  existed won't pick up genres from a plain rescan or "Retry Unmatched".
  Settings → Library → **Backfill Genres**
  (`POST /api/library/backfill-genres`, `scanner.js`'s `backfillGenres()`)
  re-fetches genres for every already-matched movie and show without
  touching titles, posters, overviews or ratings, and shows progress on
  the same bar as a normal scan.

### TV shows on Home

Genre shelves have always mixed in shows, but until now the Trending
shelf (and the hero banner it can feed, since the hero picks from
Continue Watching or Trending) only ever drew from `media_items` —
movies — so a library with shows scanned in could still make Home look
movie-only if none of its top genre shelves happened to catch them.

`GET /api/profiles/:id/trending` now mixes in shows too: up to 22
highest-rated movies plus up to 8 shows (alphabetical — TMDB's per-show
score isn't stored locally the way a movie's `rating` is, so shows can't
be rating-sorted into the same list), each row tagged `kind: "movie"` or
`kind: "show"` the same way a genre shelf's items already are, and the
whole mixed list goes through the existing daily `rotateForToday()`
rotation so shows aren't permanently stuck at the end. The frontend's
`renderShelf(rowsEl, 'Trending', trending, ...)` call now passes the same
`genreMediaCard` dispatcher the genre shelves use, so a show in Trending
renders as a proper show card (episode count instead of a year, opens the
show's season/episode page instead of playing directly) instead of being
forced through the movie-only card. The hero banner already knew how to
show a `kind: "show"` item (View Episodes instead of Play), so a show
landing in Trending can now also become the hero.

"Because you watched X" is unchanged and stays movie-only for now — it's
built from TMDB's *movie* recommendations for a completed title, and
doing the same for shows would need a second TMDB call
(`/tv/{id}/recommendations`) this server doesn't make yet.

## Movie detail page

Clicking a movie poster anywhere (Home shelves, the Movies grid, genre
shelves) now opens a full-page Apple-TV-style detail view instead of
playing directly — TV episodes are unaffected and still play straight
away, since they have their own browsing surface (Show Detail).

- **Backend** (`src/db.js`, `src/tmdb.js`, `src/server.js`): `tmdb.getMovieCredits()`
  fetches `/movie/{id}/credits` and trims it down to the director, any
  writer/screenplay credits, and the top 10 billed cast members (name,
  character, `profile_path` headshot). `tmdb.getSimilarMovies()` fetches
  `/movie/{id}/similar`. `GET /api/library/:id/details` combines all of it
  with the item's own genres and the requesting profile's playback
  progress, and cross-references "similar" against the local library so
  "More Like This" only ever suggests titles you actually have
  (rating-filtered for the profile the same way everywhere else is).
  - **Caching**: cast/crew/similar rarely change for a given movie, so
    they're cached in a `tmdb_detail_cache` table (keyed by `tmdb_id`) for
    365 days (`DETAIL_CACHE_TTL_MS` in `server.js`) instead of hitting TMDB
    on every detail-page open. Only the raw TMDB response is cached — the
    "similar" list is still re-joined against the local library and
    re-filtered for the profile on every request, since what's actually in
    your library changes far more often than a movie's cast does. Add
    `?refresh=true` to `GET /api/library/:id/details` to force a fresh
    TMDB fetch and overwrite the cached entry (e.g. after TMDB corrects a
    listing).
- **Frontend** (`public/index.html`, `public/app.js`, `public/style.css`):
  a fixed full-screen overlay (`#movieDetail`) with a hero backdrop/gradient
  header (title, rating badge, year, runtime, clickable genre pills,
  synopsis, director/writers, Play/Resume with a progress bar when
  partially watched, and Mark as Watched), a horizontal cast carousel with
  circular headshots, and a "More Like This" poster shelf reusing the same
  card component (hover zoom, progress bars, the 3-dot action menu) as
  everywhere else. A genre pill on the detail page closes it and jumps
  straight to that genre's shelf on Home. Because the overlay is a
  position-fixed layer on top of the page rather than a re-render, closing
  it (the pinned "← Back to Movies" button) leaves the grid/shelf
  underneath exactly as it was — same scroll position, same search query,
  same tab and genre filter — with no extra state-tracking needed.

## Hamburger nav menu — fixed a stacking bug that could hide its items

Opening the hamburger menu (Home/Movies/TV Shows, Search, Settings, Scan
Library) while another full-page overlay was showing underneath it (most
noticeably the Movie/Show detail page) could leave part of the menu mixed
in with or hidden behind that page's own content instead of cleanly on
top of it.

The cause was a CSS stacking-context trap, the same *family* of bug as
the Movie Detail "..." menu clipping fixed earlier (see below), but a
different mechanism: `#navMenu` was `position: absolute` nested inside
`.topbar`, which sits inside `.app-nav` — and `.app-nav` is
`position: sticky` with its own `z-index: 20`. That combination makes
`.app-nav` a *stacking context*, and nothing nested inside a stacking
context can ever visually out-rank an element outside it beyond that
context's own z-index, no matter how high a z-index the nested element
sets on itself. So `#navMenu`'s own `z-index: 201` only ever mattered
*inside* `.app-nav` — against the Movie Detail overlay (`z-index: 200`,
a sibling of `.app-nav`, not nested inside it), `.app-nav`'s entire
subtree was still capped at `z-index: 20` and lost.

Fixed the same way the Movie Detail menu was: `#navMenu` is now
reparented to a direct child of `<body>` in `app.js`
(`document.body.appendChild(navMenuEl)`) and switched to
`position: fixed`, with its on-screen coordinates computed fresh every
time it opens (`positionNavMenu()`, mirroring `positionDetailMenu()`) —
this escapes `.app-nav`'s stacking context entirely, so its
`z-index: 500` is compared directly against everything else in the page
and reliably wins. Its backdrop scrim was bumped to `z-index: 499` to
match. A `max-height` + `overflow-y: auto` on the menu is also a safety
net so a tall menu scrolls internally instead of ever being cut off
silently by the viewport edge.

## tvOS-style UI (Top Shelf, Control Center, App Switcher, player)

The frontend borrows several Apple TV (tvOS) interaction patterns:

- **Top Shelf hover preview**: on the idle Home tab, hovering or
  keyboard-focusing any poster/show card in a shelf briefly re-populates the
  hero banner at the top of the page with that title's backdrop, rating,
  year, runtime, and synopsis — a lightweight preview before committing to
  a click-through. It only fires on the idle Home view (`isHomeIdle()` in
  `app.js` checks the tab/query and that no overlay — Movie Detail, Show
  Detail, Settings, the player — is open), so hovering cards inside, say,
  the Movie Detail page's "More Like This" shelf never hijacks the Home
  hero sitting hidden underneath it. Moving off a card reverts to the
  default hero after a short delay.
- **Control Center**: a right-side slide-out glass panel (heavy
  `backdrop-filter: blur(30px)`), opened from the profile button in the
  header, the "C" keyboard shortcut, or closed with Escape/clicking the
  scrim. It has an instant profile switcher (switches `state.profile` and
  reloads the library in place — no page reload, no bounce through the
  profile picker) and Quick Actions: Rescan Library, System Info, and an
  Audio/Stream preferred-language setting (persisted to `localStorage`,
  used to auto-pick a matching audio track when a title has more than one
  language — see the player section below). "All Profiles / Sign Out" is
  the old full profile-gate reset, still available at the bottom of the
  panel.
- **App Switcher**: an overlay (opened via the header's active-streams
  icon) listing every currently-running transcode as a floating poster
  tile — the tvOS multitasking-view analog for "what's streaming on this
  server right now." Each tile can be closed (stops that transcode) via
  its close icon, a click, or a touch swipe-up gesture. Backed by two new
  endpoints: `GET /api/streams/active` and `POST /api/streams/:id/stop`.
- **Custom player controls**: the native `<video controls>` UI is replaced
  with a minimal, semi-transparent bottom overlay — a draggable scrub bar,
  current/remaining time, play/pause, volume, fullscreen, an audio-track
  selector, a subtitle toggle, and a **"What Did They Say?"** instant-replay
  button that rewinds 15 seconds, turns captions on for just that stretch,
  and turns them back off once playback catches back up to where it was
  before the rewind (tracked via `timeupdate`, not a fixed timer, so it
  stays correct even if you pause or seek during the replay).

### Audio tracks & subtitles (backend)

`scanner.js` now records each file's audio and subtitle streams during a
scan (`media_items.audio_tracks` / `subtitle_tracks`, JSON), using
**type-relative** stream indices — the Nth audio stream, the Nth subtitle
stream — since that's what ffmpeg's `-map 0:a:N` / `0:s:N` selectors
expect, not ffprobe's absolute stream index. Subtitle tracks are filtered
to text-based codecs only (`subrip`, `ass`, `mov_text`, etc.) — image-based
subtitles (PGS, DVD/DVB) can't be converted to WebVTT and are skipped.

Switching audio tracks starts a **new transcode job** for that
`(item, track)` combination rather than a seamless multi-rendition HLS
switch — simpler and safer to ship untested, at the cost of a brief
re-buffer when you change tracks. Only the **first** available text
subtitle track is extracted to a WebVTT sidecar per item (cached on disk
after the first request) — enough to back the instant-replay captions
without building a full multi-subtitle-track picker.

## Genre quick-filter: collapsed into a floating pill

The genre row on Home used to be its own full-width strip sitting right
underneath the topbar — a permanent bar of "All / Comedy / Drama / ..."
pills taking up a full row of vertical space at all times. It's now a
single floating pill in the topbar itself (`#genreFilterBtn`, reading
"All Genres ▾" or whichever genre is currently selected), sitting right
alongside the other topbar buttons (Active Streams, the profile/Control
Center button) instead of its own separate bar. Clicking it drops down a
small floating panel with the same pills as before (`#genrePills` — same
element, restyled and reparented to `<body>` in `app.js`, using the exact
same fixed-position/reparenting trick as the hamburger nav menu so it
isn't trapped behind a higher-z-index overlay like Movie/Show Detail);
picking a pill scrolls to that genre's shelf and closes the dropdown,
same behavior as before, just collapsed until you actually want it.
Closes on an outside click, on picking a pill, or when you leave the Home
tab (search, switching to Movies/TV Shows) — it never stays open across a
navigation the way the old always-visible bar implicitly did.

### Topbar: no more bar, just floating glass controls

The topbar itself (hamburger, logo, the genre-filter pill above, Active
Streams, the profile/Control Center button) used to sit on its own solid
frosted strip (`.topbar { background: ...; border-bottom: ...; }`) — a
visible bar across the very top of the screen, distinct from the page
behind it. That strip is gone: `.topbar` is fully transparent now, and
every control inside it carries its own frosted-glass pill/square instead
(same `rgba(var(--glass-tint), 0.55)` fill + `blur(20px)` + a
`rgba(var(--glass-tint), 0.85)` hover step on all four — hamburger, Active
Streams, profile button, and the genre-filter pill). They now read as one
consistent floating control cluster over whatever's scrolling underneath
(the hero backdrop, a shelf) rather than sitting on a bar — the same
floating-glass language the "← Back" button on Movie/Show Detail already
used, just applied consistently across the whole topbar. Two shapes: a
34×34 rounded square for icon-only buttons (hamburger, Active Streams) and
a fully-rounded pill for text buttons (profile, genre filter) — same fill
and blur either way, just a different silhouette for "opens a menu" vs
"reads as text".

Making `.topbar` transparent on its own wasn't actually enough to remove
the "bar" look, though — with `.app-nav` still `position: sticky` reserving
its own real estate at the top of the page (so grid/settings/etc. below it
are never covered), the Home hero's backdrop image only ever started
*after* that reserved space, not behind it. So above the hero, all a
transparent topbar revealed was plain page background (`--bg: #121212`) —
which, sitting right above a much brighter backdrop photo, still read as a
solid dark band across the top even though no single element was drawing
one on purpose. The actual fix: the Home hero (`.hero`) now pulls itself up
underneath the nav with a negative `margin-top: calc(-1 * var(--nav-height))`,
so its backdrop image extends all the way to the true top of the page,
directly behind the floating icons — the same "image behind floating
controls" look most streaming apps use. `--nav-height` is kept in sync with
`.app-nav`'s real rendered height by a `ResizeObserver` in `app.js` (rather
than hardcoding a pixel value, which would break the moment the scan-
progress bar appears or the topbar wraps to 2 lines on a narrow/portrait
screen) — `.hero-content` stays anchored to the bottom of the hero box the
whole time, so the title/overview never end up sitting any closer to the
buttons than before; only the backdrop image's top edge moves. Every other
tab (Movies/TV Shows grid, Settings, etc.) is untouched — they never had a
hero image to bleed upward in the first place, so `.app-nav` staying
`sticky` and reserving its usual space above them is still exactly right.

## D-pad / remote-control navigation

The frontend supports geometric spatial navigation with arrow keys, on top
of mouse/touch — the same JS app works standalone in a browser *and* is
reused as-is inside the Android TV app's WebView (`android-tv/`), rather
than building a second native TV UI from scratch. Arrow keys
move focus to the nearest focusable thing in that direction (not DOM tab
order), Enter/Space (a TV remote's "OK" button included) activates
whatever's focused, and it's scoped to whichever overlay is currently on
top — arrow keys inside Settings, say, never jump focus to a poster card
sitting behind it. See `focusInDirection()` in `app.js`.

Trade-off worth knowing: this takes over arrow keys globally (outside text
inputs/selects), which means the browser's own "arrow keys scroll the
page" behavior is gone in favor of focus movement — standard for this kind
of app (Netflix's web player does the same), but worth knowing if it feels
different from a typical page.

## Immersive playback (auto-fullscreen, auto-hiding controls)

Opening the player now behaves like a real TV/streaming app instead of an
embedded video on a page:

- **Auto-fullscreen on open** — `enterPlayerFullscreen()` in `app.js`
  requests real (OS/browser-level) fullscreen on `#videoWrap` (the video +
  its overlay controls together, so the scrubber/buttons still render
  correctly inside it) the moment a title starts playing. This has to
  happen *synchronously*, before the first `await` in `openPlayer()` —
  browsers only honor a fullscreen request while it's still inside the
  original click's call stack, and silently refuse it once that's gone
  (e.g. after an `await fetch(...)`). Not fatal if refused for any reason
  (some browsers are stricter than others) — the player still works fine
  windowed, and the manual ⛶ button is still there as a fallback. On the
  Android TV wrapper, this is exactly what feeds into the WebView's
  `onShowCustomView`/`onHideCustomView` fullscreen-video plumbing built
  for it (see `android-tv/`), so it now fires on every single video instead
  of only when someone happened to tap Fullscreen manually — which is also
  why that project's `MainActivity.kt` Back-button handling now checks for
  an active fullscreen custom view first (exiting it) before falling
  through to page-history `goBack()`.
- **Controls auto-hide during playback** — `showPlayerControls()` /
  `scheduleHideControls()` in `app.js` show the scrubber bar briefly, then
  fade it out ~2s into uninterrupted playback (`CONTROLS_HIDE_DELAY_MS`).
  Any activity brings it back and resets that countdown: mouse movement
  over the video, a tap/click, a keyboard or D-pad press (wired into the
  same global `keydown` listener the spatial-nav system uses), dragging
  the seek/volume sliders, or a control receiving keyboard/D-pad focus.
  They stay up the *entire* time playback is paused — nothing to protect
  the view of, and hiding them while paused would just make them
  frustrating to find again. Deliberately not CSS `:hover`-driven anymore
  (a stationary mouse cursor resting over the video used to pin them open
  indefinitely, which fought with "hide after a couple seconds"); it's
  now a plain JS timer with a `.force-visible` class, and hidden controls
  get `pointer-events: none` so an invisible button/slider can't steal the
  tap that's supposed to just wake things back up.
- **Tap-to-reveal, not tap-to-toggle** — the first tap/click on the video
  while controls are hidden only reveals them; it does not also toggle
  play/pause. Once visible, tapping the video again toggles playback as
  normal. Avoids the classic "I just wanted to see the scrubber and
  instead I paused it" annoyance.
- The cursor itself hides too (`.video-wrap.cursor-hidden`) whenever the
  controls fade out, matching how a fullscreen desktop video player
  behaves when idle.

## Post-playback: "Up Next" auto-play + end-of-playback recommendations

When a title is about to finish, Vyzn now does something instead of just
stopping — matching the "what should I watch next" behavior of every
mainstream streaming app:

- **TV episodes** — in the last 15 seconds of an episode (or on the video's
  `ended` event as a fallback, in case something skips past that window),
  a small card slides in over the bottom-right corner of the player: "Up
  Next: S{season}:E{episode} — {title}", with a 10-second countdown. The
  video keeps playing underneath while it counts down — it doesn't pause
  or block anything. Two actions: **▶ Play Now** jumps straight to the
  next episode, and **✕ Cancel** dismisses the card and just lets the
  current episode finish on its own. If nobody touches it, the countdown
  reaching 0 automatically starts the next episode, same as Cancel/Play
  Now doing nothing.
  - The spec this was built from described 3 buttons (Play Now, Cancel,
    Next Episode). "Next Episode" and "Play Now" would do the exact same
    thing here — there's only ever one specific next episode being
    offered, not a list to choose from — so that's collapsed into the 2
    buttons above.
- **End of series/season, or end of a movie** — when there's no next
  episode to offer (last episode of the last season) or a movie finishes,
  a full-screen recommendations grid takes over the player: up to 5 poster
  cards, using the exact same card component as the rest of the app, so
  they look and behave identically to browsing Home. Clicking a card tears
  down the current playback session first (closing the video/HLS session
  cleanly, so nothing overlaps) and then opens that title's detail page or
  starts it playing, same as clicking it anywhere else in the app. A
  Close button backs out to the previous screen instead.
- **Recommendation logic** (in `server.js` / `tmdb.js`, new
  `GET /api/playback/:mediaId/next` endpoint):
  - **Movies** — TMDB "collection" (franchise) entries first — direct
    sequels/prequels, e.g. the rest of a trilogy — followed by TMDB's
    generic "similar movies", with anything already shown in the
    collection list de-duplicated out of the similar list. Only titles
    that actually exist in your local library are shown (no dead links to
    things you don't own), filtered through the same profile
    content-rating gate as the rest of the app, capped at 5.
  - **TV shows** — no franchise/collection concept exists for TV on TMDB,
    so shows go straight to "similar shows" (falling back to TMDB's
    recommendations endpoint first, then its similar-shows endpoint),
    same local-library + profile-rating filtering, capped at 5.
  - The spec's wording ("Plex API", "Plex recommendation engines") is
    Plex-specific boilerplate — Vyzn has no Plex dependency, so this reads
    entirely from Vyzn's own SQLite library plus the existing TMDB
    integration (`tmdb_detail_cache`, already used by the movie detail
    page's "More Like This" shelf — this reuses the same cache table and
    adds a `collection_json` column to it, cached for a year like
    everything else in that table).
- **State machine** — the player tracks an explicit
  `PlayerPhase` (`PLAYING` / `COUNTDOWN` / `RECOMMENDATIONS`) in `app.js`,
  reset back to `PLAYING` every time a new title opens or the player
  closes, so a leftover countdown or recommendations grid from a previous
  title can never end up stuck on screen over a new one.
- **Accessibility** — both overlays live inside `#videoWrap`, which is
  already the root the existing D-pad/remote spatial-navigation system
  (see "D-pad / remote-control navigation" below) uses whenever the
  player is open. No changes were needed there: the countdown card's
  buttons and every recommendation card are plain focusable elements
  (`<button>` / the existing card component), so they're automatically
  reachable by keyboard tab order, D-pad arrow keys, and touch, the same
  as every other on-screen control.

## TV Show Detail page (full page, matching Movie Detail)

Tapping a TV show used to pop open a small centered dialog (season tabs +
episode list only) — a leftover from before Movie Detail got its rich
Apple-TV-style treatment. Show Detail is now the same kind of full page:

- **Hero header** — backdrop image, scrim gradient, title, a content-rating
  badge, an air-year range (e.g. "2019–2023"), season count, clickable
  genre pills (jump to that genre's shelf on Home, same as Movie Detail),
  overview, and a "Created by ..." line.
- **Primary action button** — "▶ Play S1:E1" for a show nobody's started,
  "▶ Resume S2:E4" for one already partway through a specific episode.
  Found by walking every season's episodes in order and picking the first
  one not marked completed; if somehow everything's already been watched,
  it offers to play the very first episode again rather than disappearing.
- **Season tabs** — now a horizontally-scrolling pill bar (was a wrapping
  row of square-ish buttons before) so a show with a lot of seasons doesn't
  push the episode list down the page.
- **Episode rows** — thumbnail (falling back to a plain placeholder icon
  when there's no TMDB still, instead of a blank tile), "E01 • Episode
  Title" format, runtime, a synopsis, and a progress bar or watched
  checkmark exactly like the rest of the app. Clicking one still jumps
  straight into playback, unchanged.
- **Cast carousel** and **"More Like This" shelf** — same components Movie
  Detail already uses (`castCard()`, `showCard()`), fed by a new
  `GET /api/shows/:id/details` endpoint that fetches/caches TV credits +
  creators (`tmdb.getShowCredits`) and cross-references TMDB's similar-
  shows list against your own library (reusing the recommendation logic
  from the post-playback feature above, just with a higher cap — 10 here
  instead of 5).
- **Theme music** — an optional touch: if you drop an mp3 at
  `public/theme-music/{tmdb_id}.mp3` (mounted as its own Docker volume now —
  see `docker-compose.yml` — so it survives `--build`, unlike the rest of
  `public/`), it fades in (0 → 30% volume over 1.5s) when you open that
  show's detail page and fades back out (30% → 0 over 0.5s) the moment you
  close the page, click into an episode, or open a different show. A 🔊/🔇
  button in the hero toggles it, remembered in `localStorage`
  (`vyzn_theme_muted`) across sessions. No mp3 for a show → the button's
  still there but nothing plays, silently — TMDB has no theme-song API to
  pull this from automatically (neither does any other free/reliable
  source), so this is a manual, opt-in per-show thing rather than
  something that "just works" for your whole library out of the box.
- Settings' own popup-dialog styling (`.show-detail-overlay` /
  `.show-detail-box`) is untouched and still used for the Settings page
  itself — only the *TV show* detail view moved to the full-page layout.

## Theme: Abyss-inspired look

The whole frontend now uses a dark, minimal design language modeled on the
[Abyss](https://github.com/AumGupta/abyss-jellyfin) theme for Jellyfin.
Since Abyss targets Jellyfin's own DOM/CSS classes (which don't exist
here), the change ports its *design tokens*, not its stylesheet — applied
through VYZN's existing centralized CSS variables in `public/style.css`:

- **Palette** — near-black neutral background (`--bg: #121212`,
  `--bg-elevated: #2a2a2a`) instead of the old cool/bluish dark tones.
  Every old bluish-tinted literal (borders, hover states, placeholder
  backgrounds) was swept and replaced with a neutral grey so nothing
  clashes with the new palette.
- **Monochrome accent** — `--accent` is now a near-white
  (`245, 245, 247`, mirroring Abyss's own default), used only as a
  *fill* color: active tabs/pills, the primary Play button, the replay/CC
  toggle, progress fills. Anywhere the accent is used as a solid
  background, a new `--accent-contrast` (dark, `#121212`) is paired in as
  the text/icon color on top of it — a plain white-on-near-white button
  would otherwise be unreadable. Thin bars (progress fills, focus rings)
  keep just the accent color, since there's no text sitting on them.
- **Typography** — Google Sans, imported at the top of `style.css`,
  matching Abyss's font choice.
- **Corners & motion** — buttons now share the same `--card-radius`
  rounding as cards instead of a smaller hardcoded radius, and every
  `transition`/`animation` in the stylesheet uses a new `--ease`
  cubic-bezier (`cubic-bezier(0.16, 1, 0.3, 1)`) instead of plain linear
  `ease`, for the smoother, more deliberate feel Abyss is known for.
  Scrollbars are also tinted with the accent color instead of the browser
  default.
- **Staggered shelf entrance** — Home's shelves (Continue Watching,
  Trending, genre rows, ...) fade up into place one after another on
  load, capped at a handful of staggered delays so it stays subtle no
  matter how many shelves are present. Respects
  `prefers-reduced-motion`.

A follow-up pass then went beyond the palette to match Abyss's actual
*interaction* feel, not just its colors:

- **Frosted-glass header** — the top nav bar (`.topbar`, already sticky)
  is now translucent + blurred instead of a flat opaque bar, so content
  scrolls beneath it with the same layered "glass" look Abyss gives
  Jellyfin's header. Every dropdown/menu/scrim in the app (the "..."
  menus, Control Center, the app switcher, dialogs) was also swept from
  several old bluish translucent tints down to one shared neutral
  `--glass-tint` variable, so they all read as the same frosted material.
- **Pill tab bar** — the Home/Movies/Shows tabs are now fully rounded
  pills; the active tab is a solid filled pill (as before), and hovering
  an *inactive* tab now tints its text/border toward the accent color as
  a preview, rather than nothing happening until you click — mirroring
  Abyss's own tab bar behavior.
- **Menus flip to filled accent on hover** — items in the "..." dropdown
  menus (Movie Detail, poster cards) and the hamburger nav menu used to
  just get a faint white overlay on hover. They now flip to a solid
  accent fill with bold dark text, exactly like Abyss's own list/menu
  item hover state — a much more definite "this is what you're about to
  pick" cue than a subtle highlight.
- **Snappy press feedback** — buttons and icon buttons now scale down
  slightly the instant they're pressed (a new `--ease-snappy` easing,
  Abyss's own second easing curve), independent of whatever the hover
  effect is doing, so taps feel acknowledged immediately.
- **Softer card hover** — poster cards trade their heavy drop shadow for
  a lighter one plus a subtle accent-tinted border, matching Abyss's
  "no heavy box-shadows" convention for hover states.

Everything above (palette and interaction) lives entirely in
`public/style.css` — no HTML or JS changed for any of it. Want a
different accent color instead of near-white?
Change `--accent` and `--accent-rgb` at the top of the file (they must
stay in sync — same color, one as a hex/word for `--accent`, one as bare
`R, G, B` for `--accent-rgb`) and pick a `--accent-contrast` that reads
clearly on top of it.

A third pass then matched Abyss's actual screenshots (its Home Spotlight
banner, Movies grid, detail page and player OSD) point by point, which
turned up a few real layout/feature gaps beyond styling:

- **Bigger, more cinematic Home banner** — the hero is taller (56vh, was
  40vh) and its title is larger, matching the "Spotlight" banner's
  presence in Abyss's own Home screenshot.
- **Metadata pills** — the rating/year/runtime under the hero title used
  to be plain text; each is now its own small frosted-glass pill, exactly
  how Abyss presents PG-13 / runtime / score next to a Spotlight title.
- **Circular info button** — the hero's second action is now a round "ⓘ"
  icon button next to Play, instead of a second text button — Abyss never
  pairs Play with another full text button, only an icon.
- **"Watched" checkmark badge** — movie posters now show a small filled
  checkmark badge (top-left, so it never collides with the existing "..."
  menu button's top-right corner) once a movie's been marked watched or
  finished past 90%, matching the checkmark badge on finished titles in
  Abyss's own library grid screenshot. This needed a small backend change
  too: `/api/library`, the Trending shelf, and genre shelves now join in
  the signed-in profile's watched status the same way Continue Watching
  already did, so the frontend has something to show the badge for.
- **Player controls bar** — the bottom OSD is now a proper frosted glass
  panel (solid-ish, blurred) instead of a plain dark gradient, and its
  icon buttons are flat at rest with just a hover highlight, matching the
  player screenshot. This is purely visual — the auto-hide/auto-fullscreen
  behavior from the immersive playback work above is untouched.
- **Floating sidebar corners** — the hamburger nav menu's corner radius
  now matches dialogs/toasts (`--radius-lg`, 24px) instead of a smaller
  radius, consistent with Abyss calling out its sidebar as a "floating"
  panel.

The badge is the only part of this pass that touched the backend
(`src/server.js`) — everything else is still `style.css`, plus one small
`app.js`/`index.html` change each for the badge and the info button.

## Responsive layout (portrait + landscape)

The frontend now adapts across phone/tablet portrait, phone landscape, and
wide desktop/TV windows, in `public/style.css`:

- **Sticky top nav** (`public/index.html`'s `.app-nav`, wrapping the scan
  progress bar, topbar and genre pill row): these three used to each be
  independently `position: sticky` with a hardcoded pixel offset between
  them (the genre pills assumed the topbar was always exactly 60px tall).
  On a narrow screen the topbar wraps onto a second line and that offset
  went stale, causing the genre pills to overlap it. They're now one
  sticky unit, so they always stack correctly regardless of how tall the
  topbar renders.
- **Narrow screens** (`@media (max-width: 640px)` — phones and most
  tablets in portrait): the topbar reflows onto clean rows (icons row,
  then a full-width search box, then scan button/status) instead of
  wrapping mid-control; hero and movie-detail headers shrink their
  padding/type size instead of overflowing; poster cards, cast avatars,
  and episode thumbnails all shrink so more fits without horizontal
  cropping.
- **Short landscape viewports** (`@media (orientation: landscape) and
  (max-height: 500px)` — a phone turned sideways): the hero and movie
  detail backdrops are viewport-height-based, which gets cramped with very
  little vertical space, so their height is capped and the video player
  is allowed to use most of the (scarce) vertical space instead.
- **Large screens** (`@media (min-width: 1600px)` — wide desktop windows,
  and eventually a TV): shelves, grid cards, and hero/detail type scale up
  a bit instead of staying thin and sparse on a big display.
- **Movie Detail page fixes**: two portrait-specific bugs, both stemming
  from `.movie-detail-header` sitting inside a hero that's only tall
  enough to fit typical content — on a narrow phone, a long overview or a
  couple of extra wrapped genre tags push the header's actual height past
  the hero's `min-height`, and flexbox's `align-items: flex-end` then
  places the header (and its title) right at the very top of the screen:
  - The fixed "← Back" button sitting at a hardcoded viewport position
    could land directly over the title text. `.movie-detail-header` now
    reserves top padding (64px desktop, 56px mobile) so the title always
    clears it, regardless of how tall the rest of the header gets.
  - The "..." menu (Mark as Watched / Restart / Remove / Edit Match) lived
    inside that same hero, which has `overflow: hidden` (to keep its
    scaled backdrop image from bleeding out) — so a tall header meant the
    open dropdown's bottom got silently clipped. It's now moved to a
    direct child of `<body>` on load and positioned with `position: fixed`
    from the "..." button's live coordinates (`positionDetailMenu()` in
    `app.js`), which escapes that clipping entirely and also can't run off
    the edge of the screen. It closes itself on scroll/resize rather than
    visually detach from the button.

## Live scan progress

Clicking "Scan Library" now shows a real progress bar instead of a static
"Scanning..." label, streamed over Server-Sent Events:

- `src/scanner.js` exports a shared `scanEvents` `EventEmitter` and emits a
  `progress` event at each meaningful step: once when the directory walk
  starts (`walking`), once per file during the ffprobe pass (`probing`,
  with `current`/`total`/`filename`/`percent`), once per item during TMDB
  matching (`matching`, same shape), and a final `complete` (or `error`)
  event.
- `GET /api/scan/progress` in `src/server.js` relays those events to any
  connected browser as `text/event-stream`, so multiple tabs can watch the
  same scan. It sends an immediate `idle`/`running` status on connect (in
  case a scan is already in progress from another trigger, e.g. a
  scheduled scan) and a `: heartbeat` comment every 15s to stop proxies
  from timing out the connection.
- The frontend (`public/app.js`) opens an `EventSource('/api/scan/progress')`
  when "Scan Library" is clicked (and on page load, in case one's already
  running), fills the bar under the top bar (`#scan-progress-bar` in
  `index.html`), and refreshes the library grid automatically on
  `complete`. Falls back to the old polling behavior if `EventSource` isn't
  available.

## TV shows: Show -> Season -> Episode hierarchy

TV episodes are no longer flat tiles — they're grouped into shows and
seasons, mirroring how TMDB itself organizes them:

- `src/scanner.js`'s `parseTvFilename()` extracts a show title, season
  number and episode number from the filename (`Show.Name.S01E05...`,
  `Show Name - 1x05`) or, if that fails, from the folder structure
  (`.../Show Name/Season 02/05.mkv`). Files that don't match either get a
  flat show-level TMDB match instead (no season/episode grouping).
- Matched shows/seasons/episodes are stored in three new tables
  (`tv_shows`, `tv_seasons`, `tv_episodes`); each episode links back to
  its file's existing `media_items` row via `media_item_id`, so streaming,
  playback progress and content-rating filtering all keep working
  unchanged — this is a metadata layer on top, not a replacement.
- Within one scan, all episodes of the same show share a single TMDB show
  search and season lookup (cached in memory) instead of one show search
  per episode, so a 24-episode season doesn't trigger 24 redundant calls.
- New endpoints: `GET /api/shows` (optionally `?profile_id=` filtered) and
  `GET /api/shows/:id` (seasons with nested episodes, each carrying its
  `media_id` for `/api/stream/:id` and, with `?profile_id=`, that
  profile's playback progress).
- The browser UI's "TV Shows" tab now shows show posters; clicking one
  opens a season-tabbed episode list instead of jumping straight into
  playback.
- Since the schema changed, run `POST /api/library/retry-unmatched` after
  upgrading (or a full rescan) to backfill the show/season/episode tables
  for TV files that were already indexed under the old flat matching.

## Profiles, parental ratings & "Continue Watching"

- Each scanned item now stores `media_type` (`movie`/`tv`, inferred from
  which top-level folder it's under) and `content_rating` (TMDB's US
  certification — `G`/`PG`/`PG-13`/`R`/`NC-17` for movies,
  `TV-Y`...`TV-MA` for TV — fetched during TMDB matching).
- A profile has `max_content_rating` on the same combined scale
  (`src/ratings.js`); passing `?profile_id=` to `/api/library` (and the
  browser UI, once a profile is picked) filters out anything above that
  rating. Content with no known rating is allowed for adult profiles and
  blocked for `is_child` profiles, so unrated files don't slip through to
  a kids' profile by default.
- Playback position is POSTed every ~15s while playing (and once more on
  close) to `/api/profiles/:id/progress`. Between 5%-90% watched, an item
  shows up on that profile's "Continue Watching" shelf with a progress
  bar; at 90%+ it's marked completed and drops off.
- "Because you watched X" shelves are built by taking a profile's last 3
  completed items and calling TMDB's `/movie/{id}/recommendations` or
  `/tv/{id}/recommendations` for each, filtered by that profile's rating
  limit.
- The browser UI now opens on a profile picker (stored per-browser in
  `localStorage`) before showing the library, with a switch-profile
  button in the top bar.
- Each Continue Watching card has a "⋯" menu (same one every card gets)
  with two extra actions: **Restart from Beginning** (clears that item's
  progress via `DELETE /api/profiles/:id/progress/:mediaId`, then opens
  the player at 0:00) and **Remove from Continue Watching** (same delete,
  no replay — the card just disappears). Both key off the row having
  `position_seconds`/`duration_seconds` on it, which only Continue
  Watching cards carry (joined in from `playback_progress`).
- The Movie Detail page's secondary actions (Mark as Watched, Edit Match)
  are collapsed into a single "⋯" button next to Play, instead of sitting
  as separate buttons in the actions row. When the item has in-progress
  Continue Watching data, that same menu also gains **Restart from
  Beginning** and **Remove from Continue Watching** (identical behavior
  to the card-menu versions above) — both hide again once there's no
  progress left to act on (after Remove, after Mark as Watched, or on a
  title with no progress at all).
- Genre shelves and Trending no longer always lead with the same
  highest-rated/alphabetically-first item — `/api/genres/:id/media` and
  `/api/profiles/:id/trending` rotate the list by one position per day
  (`rotateForToday()` in `server.js`), so the whole catalog cycles through
  eventually instead of the same titles always being first. The order of
  the genre shelves themselves (which genre row appears first on Home)
  rotates the same way, client-side in `app.js`.

## TMDB metadata

Get free credentials at https://www.themoviedb.org/settings/api — TMDB
gives you **two different values** there, and mixing them up causes a
`401 Unauthorized` on every lookup:

| What TMDB calls it       | Looks like                          | Env var           |
|---------------------------|--------------------------------------|--------------------|
| API Key (v3 auth)         | short, ~32 hex characters            | `TMDB_API_KEY`     |
| API Read Access Token     | long, starts with `eyJ...` (a JWT)   | `TMDB_AUTH_TOKEN`  |

Set exactly one of these two env vars (not both) to match whichever
credential you copied. Sanity-check it before wiring it into Docker:

**Attribution:** TMDB's API Terms of Use require a visible notice that the
product uses the TMDB API and isn't endorsed/certified by them, referring
to them only as "TMDB" or "The Movie Database", in an About/Credits
section ([details](https://www.themoviedb.org/about/logos-attribution)).
That notice is in the app's own Settings > About section (`public/index.html`),
which covers the Android TV app too since it shows this same page in its
WebView — nothing extra to add there.

## Scan performance (large libraries)

Scanning runs in two parallel phases instead of one slow serial pass:
1. Walk the filesystem and run `ffprobe` on each file — concurrency
   controlled by `SCAN_PROBE_CONCURRENCY` (default `4`; this is CPU-bound,
   so don't set it much higher than your core count).
2. Match everything without a `tmdb_id` against TMDB — concurrency
   controlled by `SCAN_TMDB_CONCURRENCY` (default `8`; this is
   network-bound, so a higher number is generally safe and much faster
   than the old one-at-a-time-with-a-250ms-delay approach).

For a library in the thousands of files, raising `SCAN_TMDB_CONCURRENCY`
to `15`–`20` is reasonable and speeds up matching substantially; TMDB's
actual rate limit is generous enough that this is safe unless you have
several other apps hammering it with the same key simultaneously.

```bash
# if using the short v3 key:
curl "https://api.themoviedb.org/3/authentication?api_key=YOUR_KEY"
# if using the long read access token:
curl "https://api.themoviedb.org/3/authentication" -H "Authorization: Bearer YOUR_TOKEN"
```

Either should return `{"success":true,...}`. If you get `401` here too,
the credential itself is wrong/revoked — regenerate it on TMDB's site.

During each scan, any file without a `tmdb_id` yet gets its cleaned-up
filename searched against TMDB (`/search/movie` — TV shows aren't matched
yet, see Known limitations); matched items get a real title, poster,
backdrop, overview, release year and rating. Filenames like
`The.Matrix.1999.1080p.BluRay.x264-GROUP` have the year/resolution/codec/
release-group noise stripped before searching.

**Why some obviously-real movies don't match:** TMDB's search API's `year`
param is a strict filter — if a scene-release filename's year is off by
even one from TMDB's canonical release year, the search returns zero
results even though the title is definitely in TMDB's database. `tmdb.js`
no longer passes `year` into the search request itself; instead it fetches
by title only and picks the best result afterward (exact year match first,
then closest within 2 years, then TMDB's own top result). Transient
429/5xx/network failures are also retried with backoff now instead of
permanently giving up on that file for the scan. If you still have
unmatched items after upgrading, run `POST /api/library/retry-unmatched`
to re-attempt them with the improved matching — no rescan needed.

If a match is wrong (common with sequels, remakes, or vague filenames),
fix it manually:

```bash
curl -X POST http://localhost:8080/api/library/3/rematch \
  -H "Content-Type: application/json" \
  -d '{"title": "The Matrix Reloaded 2003"}'
```

Without `TMDB_API_KEY`/`TMDB_AUTH_TOKEN` set, scanning still works — items
just keep filename-derived titles and no artwork.

## Hardware transcoding (Intel QuickSync / VAAPI)

Set `HW_TRANSCODE=true` (already on by default in `docker-compose.yml`)
and make sure `/dev/dri:/dev/dri` is passed through. The entrypoint script
matches the container's render-group GID to whatever owns `/dev/dri` on
the host automatically, so this should work out of the box on Unraid.

- `LIBVA_DRIVER_NAME=iHD` (default) is for Broadwell (2015+) and newer
  Intel iGPUs. If yours is older (Haswell or earlier), switch it to `i965`.
- The pipeline decodes on CPU and encodes on the GPU (`h264_vaapi`) — full
  hardware decode is skipped deliberately, since some MKV sources use
  profiles the iGPU can't decode, and encode is the expensive part for
  concurrent streams anyway.
- Sanity-check the GPU is visible inside the container:
  ```bash
  docker exec -it vyzn vainfo
  ```
  You should see a list of supported profiles (H264, HEVC, etc.) rather
  than an error.
- Set `HW_TRANSCODE=false` to fall back to CPU-only `libx264` if you hit
  driver issues.

## What gets scanned

**Automatic scanning.** Settings > Server Settings (admin dashboard) >
Automatic scanning: *Off*, *Once a day* (at a time you choose, on the
server's clock — set `TZ` in docker-compose to change the timezone; if the
server was off at that time it catches up on next start), or *When files
change* (watches your Movies/TV folders and scans two minutes after the last
new video file appears, so a download that's still copying finishes first).
The watcher uses inotify, so it doesn't wake sleeping Unraid disks; if a
share doesn't report changes (some network mounts), use *Once a day*, or set
`AUTO_SCAN_POLL=true` to poll instead. Defaults can be set with
`AUTO_SCAN_MODE` (`off`/`daily`/`watch`) and `AUTO_SCAN_TIME` (`03:00`).
Only one scan runs at a time. Files that were *removed* are not detected yet.

**Extras / bonus content.** Movie files that are DVD/Blu-ray extras are
skipped so they don't show up as duplicate "versions" of the movie: anything
inside a folder named `Extras`, `Featurettes`, `Behind The Scenes`, `Deleted
Scenes`, `Interviews`, `Scenes`, `Shorts`, `Trailers`, `Other`, `Bonus` or
`Special Features` (Plex/Jellyfin convention); files named like
`Movie (2010)-trailer.mkv` (also `-featurette`, `-deleted`, `-behindthescenes`,
`-interview`, `-scene`, `-short`, `-other`, `-sample`); and files sitting
next to the main movie whose name contains words like "alternate ending",
"deleted scenes", "behind the scenes", "making of", "bloopers", "bonus",
"trailer" or "featurette". TV folders are never filtered. Extras indexed by
older scans are removed on the next scan. Set `SCAN_SKIP_EXTRAS=false` to turn
this off. A disc extra with an unhelpful name (e.g. `Title 05.mkv`) can still
slip through — move it into an `Extras` folder or use Settings > Library >
Purge matching.

By default, `SCAN_ONLY_DIRS=Movies,TvShows` means only those two
top-level folders directly under `MEDIA_DIR` (i.e. `/media/Movies` and
`/media/TvShows`) are scanned at all — everything else directly under
`MEDIA_DIR` (a `Downloads` folder, `.Trash-99`, anything else) is skipped
outright, regardless of what's inside it.

- To scan different or additional top-level folders: set
  `SCAN_ONLY_DIRS=Movies,TvShows,Documentaries` (comma-separated,
  case-insensitive, matched against direct children of `MEDIA_DIR` only).
- To scan everything under `MEDIA_DIR` instead (old behavior): set
  `SCAN_ONLY_DIRS=` (empty).
- Regardless of the above, hidden folders, Unraid's Recycle Bin
  (`.Trash-99` and similar) and a few known junk folder names are always
  skipped at any depth. Add more with `SCAN_SKIP_DIRS=foo,bar`.

Separately, `SCAN_TV_DIRS=TvShows` (default) decides which of the folders
you allowed above count as **TV** rather than **movie** — this is what
decides whether a file gets searched against TMDB's TV catalog or its
movie catalog. If your TV folder isn't named `TvShows` (e.g. it's a plain
`tv`), update this too — matching the folder name you used in
`SCAN_ONLY_DIRS`, case-insensitive. If you skip this, every file under
your TV folder still gets scanned and added to the library (since
`SCAN_ONLY_DIRS` let it through), but silently misclassified as a movie
and searched against the wrong TMDB endpoint — showing up as a large pile
of permanently "unmatched" TV episodes with no obvious error anywhere.
After changing `SCAN_TV_DIRS` on a library that was already scanned
wrong, re-run a scan — or wipe the library first (Settings > Danger Zone)
for a clean rebuild — to reclassify those files; just updating the
setting doesn't retroactively fix rows already in the database.

If you already ran a scan before this existed and your library has junk
in it, clean it up without re-scanning from scratch:

```bash
# remove everything indexed from a specific folder
curl -X POST http://<unraid-ip>:18080/api/library/purge \
  -H "Content-Type: application/json" \
  -d '{"path_contains": "/.Trash-"}'

curl -X POST http://<unraid-ip>:18080/api/library/purge \
  -H "Content-Type: application/json" \
  -d '{"path_contains": "/Downloads/"}'

# or, to start completely clean:
curl -X DELETE "http://<unraid-ip>:18080/api/library?confirm=true"
curl -X POST http://<unraid-ip>:18080/api/scan
```

## Running locally (before touching Docker/Unraid)

You'll need Node 20+ and `ffmpeg`/`ffprobe` on your PATH. VAAPI won't be
available outside the container unless your local machine also has Intel
drivers set up, so test locally with `HW_TRANSCODE=false` (the default).

```bash
cd vyzn
npm install
MEDIA_DIR=/path/to/your/videos TMDB_API_KEY=your_key_here npm start
```

Then in another terminal:

```bash
curl -X POST http://localhost:8080/api/scan
curl http://localhost:8080/api/library
curl http://localhost:8080/api/stream/1
```

Open the returned `playlistUrl` in VLC or an HLS-capable player to confirm
playback works before wiring up Docker or the TV app.

## Running on Unraid

1. Clone this repo onto your Unraid box, e.g. into
   `/mnt/user/appdata/vyzn-src` (keep this separate from the
   `/config`/`/transcode` data folder referenced in `docker-compose.yml`'s
   volumes).
2. Edit `docker-compose.yml`:
   - Point `/mnt/user/Media` at your actual media share if it's named
     differently.
   - Adjust `TZ` if needed.
3. From that directory on Unraid:
   ```bash
   DOCKER_BUILDKIT=0 docker compose up -d --build
   ```
   (see "Updating" below for why `DOCKER_BUILDKIT=0` is required on this
   host, and `./update.sh` as a shortcut that bakes it in.)
4. Check it's alive: `curl http://<unraid-ip>:18080/health`
5. Trigger a scan: `curl -X POST http://<unraid-ip>:18080/api/scan`

### Installing on someone else's Unraid box (no source clone needed)

For a box you're setting up for someone else rather than developing on,
skip the git clone entirely and install the already-built image from GHCR
instead — either of these two ways:

**A) Plain docker-compose file.** Copy `docker-compose.ghcr.yml` to their
Unraid box as `docker-compose.yml`, edit the two `volumes:` paths and
`TZ`, then `docker compose up -d`. No build step, no source code on their
box at all.

**B) Unraid's Apps tab (Community Applications), private template.** This
repo isn't published to the public CA store (not meant for strangers to
install), but you can add it as your own private template source:

1. On their Unraid box: **Apps** tab > **Settings** (top right) >
   **Template Repositories**.
2. Add `https://github.com/comsoll8/vyzn` and save.
3. Back in the Apps tab, search "vyzn" — it now shows up with the real
   icon, description, and a proper settings form (same fields as the
   compose file, with hints), exactly like any other CA app.
4. Install, fill in the Media Library and App Data paths for their box,
   and go.

The template lives at `unraid-template/vyzn.xml` in this repo — keep it
in sync with `docker-compose.ghcr.yml` if either one's ports/volumes/env
vars change, since they describe the same container two different ways.

### Updating

```bash
cd /mnt/user/appdata/vyzn-src
./update.sh
```

This runs `git pull` followed by `DOCKER_BUILDKIT=0 docker compose up -d
--build`. The `DOCKER_BUILDKIT=0` part matters: Docker's default builder
(BuildKit) silently ignores `docker-compose.yml`'s `build: network: host`
setting and falls back to its own internal build network, whose DNS/IPv6
handling can be unreliable on some Unraid hosts — in testing this caused
`npm install` to hang for 30+ minutes during the build. The older "classic"
builder, selected by setting `DOCKER_BUILDKIT=0`, honors `network: host`
properly and finishes the same install in under a minute. `update.sh` sets
this for you so it's never something you need to remember by hand; running
`docker compose up -d --build` directly without it may hang on this host.

### Hardware transcoding (optional, recommended)

If your Unraid server has an Intel CPU with QuickSync, uncomment the
`devices: /dev/dri:/dev/dri` line in `docker-compose.yml` and switch
`streamer.js`'s video codec from `libx264` to `h264_vaapi` — CPU-only
transcoding of 4K content will otherwise struggle.

## Downloadable server log (Settings)

Settings' System Info section now has a "⬇ Download Server Log" link.
Previously the only way to see what the server logged was `docker logs
vyzn` on the Unraid box itself — fine for me to ask for, but a
dead end if you're troubleshooting from your phone/couch and not at a
terminal. The server now writes its log to a file as well as stdout
(`docker logs` still shows the exact same thing it always did — that's
unchanged), at `DATA_DIR/logs/server.log` (`/config/logs/server.log` on
Unraid, inside the same `/mnt/user/appdata/vyzn` volume the
database already lives in, so it survives restarts/rebuilds). The button
is a plain `<a href="/api/logs/download" download>`, not a JS-driven
fetch — it works even if something in `app.js` itself is broken, which is
exactly the situation this exists for. One rotation: if the file's
already past 20MB when the server starts, it's renamed to `server.log.old`
and a fresh one starts — this is meant for "grab a log to see what just
went wrong," not a long-term archive.

## "Because you watched X" recommendations + search, both backed by Seerr

The Home page's "Because you watched X" shelves come from TMDB's
recommendations API, which has no idea what's actually in your library —
so unlike every other shelf on Home, these can (and often do) suggest
titles you don't own. The search box has the same situation now too (see
"Search now reaches into Seerr" below). Two things about the unowned case:

**Metadata fix:** these unowned recommendations previously rendered as
blank, poster-less cards (just the title text on a dark box). The cause
was a field-naming mismatch — the recommendations endpoint was passing
TMDB's raw response straight through (`posterUrl`, `releaseYear`, camelCase)
while every card component in the app reads the same local-library shape
everything else uses (`poster_url`, `release_year`, snake_case). The
endpoint now normalizes every recommendation into that shape (and also
cross-checks each one's TMDB id against your library — if you do already
own a recommended title, its card behaves exactly like any other library
card: real poster, click-to-play/open-detail, "watched" badge, etc.).

**Adding what you don't own:** a recommendation (or search hit) you don't
own gets its own card style — poster, title, year, a "Not in library"
badge, and an **+ Add to Library** button (this used to say "+ Request" —
renamed since "request" reads as asking permission from someone, when what
actually happens is closer to a Netflix/Plex-style "add this" action).
Clicking it asks a [Jellyseerr](https://github.com/Fallenbagel/jellyseerr)
or [Overseerr](https://overseerr.dev/) instance (same API, either works)
to add that title, the same as requesting it from Seerr's own UI, without
leaving VYZN. To enable it, set two env vars in `docker-compose.yml`:

```yaml
environment:
  - SEERR_URL=http://192.168.1.50:5055   # your Jellyseerr/Overseerr URL, no trailing slash
  - SEERR_API_KEY=your_seerr_api_key      # Seerr's own Settings -> General -> API Key
```

Until both are set, the button shows as a disabled "Not in library" button
instead — the card and metadata still work either way, only the one-click
add needs Seerr configured. Control Center's System Info panel has a
"Seerr configured: Yes/No" line to confirm it picked up the env vars. TV
show requests ask Seerr for all seasons (no per-season picker) — the right
default for a one-click add off a card. A title already in Seerr's own
queue shows "Already Requested" (or "Already Available" once it's fully
there) instead of offering to add it again, whether that state came from
Seerr's own `/search` response or from VYZN's own request attempt hitting
a 409.

**Search now reaches into Seerr too:** typing in the search box no longer
only filters your own library — once Seerr is configured, it also fetches
`GET /api/seerr/search`, a thin proxy over Seerr's own `/api/v1/search`
(itself a TMDB search wrapper that also knows what Seerr has already
requested or fully has available). Results already in your library are
cross-referenced the same way recommendations are (merged into a real,
clickable library card — this can actually surface an owned title your
plain-text library search missed, e.g. via a TMDB alias); everything else
shows as a "+ Add to Library" discovery card under a "More results"
divider, beneath your normal library matches. Debounced off the same
search input, with a request-ordering guard so a slow older search can't
clobber a faster newer one's results. Search is local-only (as before)
when Seerr isn't configured, or fails/times out — a Seerr outage never
breaks searching your own library, it just quietly drops the extra
results for that keystroke.

## Faster stream startup + a real loading/buffering/error UI

Two related complaints, one root cause for the first and a UI gap for the
second: playback sometimes took a long time to appear (or seemed to not
load at all), and while it was loading there was nothing to look at but
the browser/WebView's own bare default (a plain gray box with a native
play icon) — not styled at all.

**Why it was slow:** the server can't hand back a playable stream until
the *first* HLS segment is fully encoded — `/api/stream/:id` polls for
that segment's file to appear before responding at all. Segments were 6
seconds each (`-hls_time 6`), so every stream start had to wait for 6
seconds of video to encode (longer on CPU/`libx264`, for a big/high-res
source, or under concurrent-stream load) before anything could play.
Segments are now 2 seconds (`-hls_time 2`), roughly a 3x cut to that
wait — the single biggest lever on time-to-first-frame. The fixed
`-g 48` GOP size (which only lined up with the segment boundary at some
frame rates, not others) is replaced with `-force_key_frames
expr:gte(t,n_forced*2)`, a keyframe forced every exactly 2 seconds of
PTS time regardless of source frame rate, so segment cuts land reliably
on target instead of drifting to whatever the next keyframe happened to
be.

**The loading/buffering/error overlay:** the player now covers the video
element with a proper glass-styled spinner + status text (`#playerLoading`
in index.html) any time there's nothing to show — stream startup
("Starting stream…"), a mid-playback stall via the video element's native
`waiting` event ("Buffering…"), or a failed start. A failed start
previously popped a native `alert()` over a still-open, blank player —
jarring and inconsistent with the rest of the app. It now shows the same
overlay with the error message plus **Try Again** (re-opens the same
item) and **Close**, matching every other error state in the app rather
than falling back to browser chrome.

## Fix: preferred audio language never applied to TV episodes; Up Next duration bug

Two bugs, found together while chasing "language isn't defaulting to
English":

1. **TV episodes never carried audio-track metadata to the player at
   all.** Every place that builds the object passed into `openPlayer()`
   for an episode — clicking an episode row, Show Detail's "Play next
   episode" button, and the Up Next card's own Play button — only ever
   included `id`/`title`/`overview`/`position_seconds` (plus
   `duration_sec`, added in an earlier fix). None of them included
   `audio_tracks`, and the three server queries behind them
   (`/api/shows/:id`'s episode list, `/api/playback/:mediaId/next`) never
   selected `media_items.audio_tracks` in the first place — so
   `pickPreferredAudioIndex()` always got `undefined` for a TV episode and
   silently fell through to ffmpeg's own default stream, regardless of
   what Settings said. Movies were never affected by this one (a movie's
   full `media_items` row, audio_tracks included, was already being
   passed straight through) — only TV shows.
2. **A field-name typo from the "Up Next" duration fix.** `playNextEpisodeNow()` (the episode Up Next's own Play button
   starts) read `episode.duration_sec`, but
   `/api/playback/:mediaId/next` actually names that field
   `duration_seconds` — so every episode Up Next auto-advanced into was
   silently falling back to the old, still-growing-HLS-playlist duration
   for remaining-time/Up-Next-timing purposes, undoing part of that fix
   for exactly the episodes Up Next itself plays.

Both fixed: the two server queries now select `audio_tracks` alongside
`duration_sec`, all three episode-launching call sites in app.js pass it
through, and the field-name mismatch is corrected.

## Preferred audio language, moved into Settings

The "preferred audio language" control (auto-picks a track when a title
has more than one audio language available — English, Japanese, Spanish,
French, German, Korean, Chinese, or "no preference") already existed and
already worked end-to-end (`pickPreferredAudioIndex()` in app.js, checked
every time playback starts), but it only lived in the Control Center's
"Audio/Stream" quick-actions panel, not in Settings — not where you'd go
looking for a standing default. Moved it into a new **Playback** section
in Settings (same `localStorage` key, so an existing choice carries over
automatically) and removed the Control Center copy so there's one place
it lives. You can still always override it per-title from the player's
own audio track button — this only controls the automatic pick when a
title first starts.

## Fix: D-pad detoured through the seek bar; volume control removed

Reported as: navigating the player's control row with the D-pad goes
Play/Pause → CC (Replay) → the seek bar → Audio language → ..., instead of
moving straight along the row of buttons.

Cause: the actions row used to be two visually separated groups — Play/
Pause + Replay on the left, Audio/Subtitle/Volume/Fullscreen pushed to the
far right edge via a flex-spacer — leaving a wide horizontal gap between
them. D-pad navigation is purely geometric (nearest focusable element in
the direction pressed), and the seek bar sits directly above, spanning the
row's full width — close enough that it won, D-pad Right had to detour up
through it, then back down into the far-right group.

Fixed by dropping the spacer and left-aligning every control into one
contiguous row, so neighboring buttons are always closer to each other
than the seek bar above is to any of them.

While in there: removed the on-screen volume button + slider entirely, at
your request — a TV remote's hardware volume keys (and desktop/mobile's
own OS volume control) already cover it, so it was a redundant control
that also happened to be two more stops on this same row. If you ever
want it back for browser/desktop use specifically, that's a quick add.

## Fix: D-pad can't navigate the player's Play/Pause/etc. controls

Reported as: pressing Select while a video is playing brings the
play/pause/audio/subtitle/volume/fullscreen control bar up, but the D-pad
then can't move between them.

Root cause: D-pad navigation (`focusInDirection()`) moves relative to
whatever `document.activeElement` currently is — but nothing ever
actually focuses the `<video>` element (it's deliberately not part of the
focusable set), and revealing the controls (via the Select/tap gesture)
never focused anything either. So `document.activeElement` was typically
still `<body>`, which `focusInDirection()` explicitly treats as "nothing
focused in this overlay yet" and responds to by jumping to the *first*
focusable element in the player — which turned out to be the ✕ close
button positioned just outside the video, not any control actually in the
bar. Every arrow press recomputed that exact same fallback, which is what
read as "can't navigate at all."

Fixed by explicitly focusing the Play/Pause button any time the controls
become visible (opening the player, pressing Select, tapping/clicking the
video) — but only when focus isn't already somewhere inside the controls,
so it doesn't yank focus away once you've actually navigated to, say, the
volume slider. D-pad presses now have a real, visible, on-screen anchor
inside the bar to move from every time.

Also closed a related edge case: the genre-filter dropdown (Home's filter
button) wasn't being closed when playback starts, and D-pad scoping checks
for it *before* the player — if it happened to still be open, every arrow
press while watching would have been silently scoped to that hidden
dropdown instead of the on-screen player. Playback now closes it on the
way in.

## Fix: "Up Next" (and Continue Watching %) triggering too early

`videoEl.duration` (from hls.js) is **not** a title's real length while
it's streaming — the HLS playlist ffmpeg writes keeps growing as it
transcodes (`-hls_list_size 0`, no `#EXT-X-ENDLIST` until the whole file
is done), so hls.js can only report the duration of whatever's been
transcoded and appended to the playlist *so far*. For a title whose
encode hasn't caught up to real-time yet (a big/high-bitrate source, a
slower CPU, concurrent streams), that reported duration is well short of
the actual runtime — and everything that compared against it thought the
video was much closer to ending than it really was:

- **Up Next** fired as soon as playback got within 15s of that
  partial duration, not the real one — sometimes minutes into a two-hour
  movie.
- **Continue Watching / "watched" percentage** was computed the same
  way server-side (`position / duration_seconds` from the progress
  report), so it could read as much further along than actually watched.

Fixed by using the title's real, already-known duration
(`media_items.duration_sec`, from the original ffprobe scan) everywhere
"how far through this am I" actually matters — the Up Next trigger, the
remaining-time display, and the duration sent in progress reports —
instead of asking the still-catching-up HLS player. This is carried on
the `item` object passed into `openPlayer()`, so the three places that
build a bare episode object for playback (an episode row, Show Detail's
"Play next episode" button, and the Up Next card's own Play button) now
include `duration_sec` too, alongside the fix for movies.

Deliberately **not** changed: the seek bar's max still tracks
`videoEl.duration`, not the real duration — that's the genuinely
seekable range right now (only segments that actually exist in the
playlist can be sought to), and it catches up to the real length on its
own once the encode finishes and writes `#EXT-X-ENDLIST`. Widening it to
the real duration early would let a scrub target land past a segment
that doesn't exist yet.

## Movie/Show Detail actions: Watchlist, Watch Trailer, Watched toggle, Edit

The Movie Detail action bar next to **Play** is now a row of icon buttons,
each a straight toggle where that applies:

- **🔖 Watchlist** — add/remove the title from a profile's watch-later list
  (new `watchlist` table, keyed by profile + item + `movie`/`tv` so a movie
  and a show can never collide even if they happened to share a TMDB id).
  Filled/accent when the item is on the list. Also on Show Detail.
- **🎬 Watch Trailer** — only shown when TMDB actually has a YouTube
  trailer for the title (prefers an official trailer, falls back to any
  trailer, then a teaser). Opens a glass-styled modal with a YouTube embed
  instead of leaving the app. The trailer key is fetched and cached
  alongside cast/crew (`tmdb_detail_cache.trailer_key`), so it doesn't cost
  an extra TMDB round-trip on repeat visits. Also on Show Detail.
- **✓ Mark as Watched / Not Watched** — a real toggle now instead of a
  one-way "Mark as Watched" dropdown item. Watched sets playback progress
  to the end (same mechanism as before); un-watching deletes the saved
  progress entirely, same as "Remove from Continue Watching" did. Movie
  Detail only — a show's watched state is inherently per-episode.
- **✎ Edit Match** — unchanged functionality (re-search TMDB with a
  corrected title when the filename auto-match got it wrong), just moved
  out of the "..." dropdown into its own icon so it's a single tap instead
  of two.

"Restart from Beginning" and "Remove from Continue Watching" still live
under the "..." menu, which now only appears at all while there's actual
in-progress Continue Watching progress to act on.

**Other fields replicated from the reference screenshot:**

- A **TMDB score** badge (`TMDB 74%`, TMDB's own 0-10 `vote_average`
  scaled to a percentage) next to the content-rating/year/runtime pills.
  TMDB doesn't expose the actual IMDb or Rotten Tomatoes scores through its
  API (those need a separate integration, e.g. OMDb, with its own API
  key) — this is TMDB's own community rating only, and only for movies
  (`media_items.rating`; `tv_shows` has no equivalent column yet).
- A **Video / Audio / Subtitles** info block, formatted from the file's own
  scanned metadata: resolution mapped to 4K/1080p/720p/480p/SD, the raw
  codec name mapped to a friendly label (H.264, H.265 (HEVC), AV1, ...),
  the primary audio track's language + codec/channel layout (e.g.
  "English (AAC 5.1)"), and subtitle languages or "None available". Movie
  Detail only.

What deliberately wasn't rebuilt: the reference screenshot's boxed
poster-on-the-left layout. VYZN's detail pages use a full-bleed cinematic
backdrop hero instead (Apple TV/Abyss-style) — all the functional pieces
above were added to that existing layout rather than switching to a
two-column poster layout. Say the word if you'd actually rather have the
literal boxed layout and that's a separate follow-up.

### Fix: playback sometimes took 30-50 seconds to start ("sluggish to load")

Root cause, found from a server log: `GET /api/stream/:id` waited on **two**
things before responding — starting the HLS transcode (usually ready in a
couple seconds) and extracting the item's subtitle track to a `.vtt` file
(a full, un-timed demux of the source file). Subtitle extraction is cached
to disk after the first successful run, so repeat plays of the same title
were fast (~300ms) — but a title's very first play ever could take as long
as that subtitle demux did, which for some files was 30-50+ seconds, even
though the video itself had been ready the whole time. That's exactly the
inconsistent "works fine most of the time, occasionally forever" pattern
reported.

Fixed in `src/server.js`'s `/api/stream/:id` handler: subtitle extraction
now gets a 2-second grace period. If it finishes in time (the common,
cached case), the response includes subtitles as before. If not, the video
stream starts immediately without waiting further, while the extraction
keeps running in the background and caches its `.vtt` for next time —
subtitles just won't be there for that one very-first play of a title.

### Fix: some titles stuck forever on "Starting stream…"

Root cause, found by tracing a specific title's server log (which showed
the server-side stream request succeeding instantly, with no errors at
all) and then reading the player code: `startStreamAndAttach()` in
`app.js` handed the stream off to hls.js with **no error handler attached
at all**, and the "Starting stream…" spinner was only ever hidden by the
video element's native `playing` event. If hls.js hit a fatal error —
a segment or audio track it couldn't parse or append (multichannel 5.1
AAC muxed into fMP4 is a known trigger for this in some browsers), a bad
manifest, a dropped connection — it failed silently: no `playing` event
ever fired, nothing told the UI to stop showing the spinner, and the
stream was stuck forever with no error and no way out except closing the
player. The server logs looked completely healthy the whole time because
the failure was entirely client-side.

Fixed in `public/app.js`:
- A real `Hls.Events.ERROR` handler now runs for every stream. Recoverable
  fatal errors (network drop, a media/append error) get one automatic
  recovery attempt each (hls.js's own documented pattern — `startLoad()` /
  `recoverMediaError()`), with the loading overlay updated to say so.
- Anything that isn't recoverable, or fails again after that one retry,
  now shows a real error in the player (via the existing `showPlayerError`
  overlay, with Try Again / Close) instead of hanging. A media-error
  message specifically suggests trying a different audio track, since
  multichannel audio is the most likely trigger.
- A 20-second safety-net timer also now backs up the error handler itself:
  if nothing gets the video actually playing within 20s of requesting the
  stream — including a stall hls.js never classifies as fatal — the
  spinner is replaced with an error instead of spinning indefinitely.

#### Follow-up: `mediaSourceRequiresReset` needed a second recovery tier

Confirmed live: a 5.1-audio title failed with hls.js error detail
`mediaSourceRequiresReset`. That specific detail means the browser's
MediaSource object itself needs tearing down and rebuilding — hls.js's own
`recoverMediaError()` (the one automatic retry added above) only handles
milder SourceBuffer append failures by swapping codecs in place, and does
**not** fix this class of error, so it was still reaching the "give up"
branch and showing an error after a single failed retry.

Added a second, harder recovery tier in `public/app.js` for `MEDIA_ERROR`
specifically: if the soft `recoverMediaError()` retry fails again, the
entire hls.js instance (and the browser's MediaSource with it) is
destroyed and rebuilt from scratch at the current playback position,
instead of giving up immediately. Only if that hard reset *also* fails
fatally does the player show an error. This mirrors hls.js's own
documented fallback pattern (soft recovery, then full reinit) rather than
stopping at the first, weaker option.

**Confirmed live that the hard reset hits the identical error again** —
this isn't a transient glitch either recovery tier can paper over, it's a
genuine, persistent incompatibility between multichannel (5.1) AAC audio
and the browser's MediaSource Extensions when delivered over HLS/fMP4.
No amount of client-side retrying fixes an incompatibility baked into the
stream itself, so the real fix has to be on the encode side.

Fixed in `src/streamer.js`'s `startHlsJob()`: every transcode now downmixes
audio to stereo (`.audioChannels(2)`, ffmpeg's standard 5.1/7.1→stereo
downmix — folds the surround/LFE channels into L/R rather than discarding
them) regardless of the source's channel layout. Since audio is already
being re-encoded to AAC for every HLS stream no matter what the source
codec is, downmixing at the same time is free — it just changes the
channel count of an encode that was happening anyway. This is also the
standard approach other self-hosted media servers take for their own web
players, reserving true multichannel passthrough for native apps/AVRs
that can decode it directly, which VYZN's browser-based HLS player never
did anyway (it was always transcoding, never passing the source codec
through).

Note: the Movie Detail "Audio" field still reports the source file's real
format (e.g. "5.1"), since that reads the scanned file metadata, not what
the stream actually delivers — the file itself hasn't changed, only what
gets sent to the browser during playback.

### Native (ExoPlayer) playback for the Android TV app — real 5.1, no downmix

The stereo downmix above is specifically for *browser* playback (this
server's own web frontend, including the Android TV app as it existed
until now — it was just a WebView around the same browser player). The TV
app now has a second option: a native ExoPlayer-based player that plays
the source file directly via a new endpoint, bypassing transcoding
entirely, so real multichannel audio reaches the TV/AVR intact. Added here:

- `GET /api/raw/:id` — serves the original media file byte-for-byte, with
  HTTP Range support (206 partial content) so a native player can seek
  within it. No transcoding, no downmixing — literally the same bytes on
  disk. Browsers never call this (they can't decode most of what a raw
  MKV might contain, and this is exactly the endpoint that's *not*
  browser-safe); only the TV app's native player uses it.
- `public/app.js`'s `openPlayer()` now checks for `window.VyznNativePlayer`
  (only ever defined inside the TV app's WebView — see android-tv's
  `NativePlayerBridge.kt`) and, when present, hands playback off to it
  instead of setting up the browser's own HLS/hls.js player. Everything
  else about the page (browsing, detail pages, search, settings) is
  unaffected — this only changes what happens when a stream is requested,
  and only inside that one app.

Full detail — what this fixes today (AAC 5.1, which was exactly what was
failing), what it doesn't yet (AC-3/E-AC-3/DTS/TrueHD, which need
ExoPlayer's separately-built FFmpeg extension), and what's still deferred
(in-player audio track switching; the end-of-movie "recommendations" grid
— subtitles and TV-episode Up Next auto-advance have since shipped) — is
in `android-tv/README.md`'s "Native playback (ExoPlayer)" section.

### Home screen: static hero banner + decluttered cards

Two changes to `public/style.css` and `public/app.js`:

- **The hero banner now stays completely fixed at the top of the Home
  tab** — full size, always fully visible, never covered — while the
  shelf rows scroll independently in the space below it and disappear
  off the top edge of that area as you scroll down. `.hero` is
  `position: fixed` (not `sticky`), and `.rows` is its own scroll
  container (`overflow-y: auto`) sized to exactly the leftover viewport
  under the banner, via a shared `--hero-height` CSS variable so the two
  always agree on where the hero ends. Only affects Home (the hero is
  already hidden on every other tab, which keep normal whole-page
  scrolling).
- **Removed the "⋮" action menu from movie and show cards** (the one
  with Play/More Info/View Episodes) — it's now fully redundant: clicking
  a card already opens its Detail page, which has its own Play, Watchlist,
  Trailer, Watched toggle, and Edit, and (for a movie already in progress)
  its own "..." menu for Restart/Remove-from-Continue-Watching. Kept the
  menu in exactly one place it's still needed: a TV episode card sitting
  in the Continue Watching shelf, which plays directly on click and has no
  detail page of its own to reach Restart/Remove from otherwise.

## Credits

- **[TMDB](https://www.themoviedb.org)** — all movie/TV metadata, posters,
  backdrops, and trailers. "This product uses the TMDB API but is not
  endorsed or certified by TMDB." (see "TMDB metadata" above). Also shown
  in-app at Settings > About.
- **[Abyss](https://github.com/AumGupta/abyss-jellyfin)** — a Jellyfin
  theme by Om Gupta, used under its MIT license, is the direct visual
  inspiration for VYZN's whole dark/minimal design language (palette,
  typography, motion, pill tabs, metadata chips — see "Theme:
  Abyss-inspired look" below for the full breakdown). Its own CSS/DOM
  targets Jellyfin specifically and isn't reused here — what's ported is
  the design language itself, rebuilt against VYZN's own markup and CSS
  variables. Also shown in-app at Settings > About.

## Transcode cache cleanup

Every title you play leaves its HLS segments in `/transcode/<itemId>/`, and
a fully transcoded movie is several GB. Until 0.3.4 nothing ever deleted
them — one real install reached **109GB** (found via
`du -sh /mnt/user/appdata/vyzn/* | sort -h`). A sweep now runs 15 seconds
after startup and hourly after, removing a title's whole cache folder when
it has **no running ffmpeg job** and nothing in it was written or touched
within the age window. Two settings, editable in Settings > Connections
(or as env vars of the same name), take effect on the next sweep:

| Setting | Default | Meaning |
|---|---|---|
| `TRANSCODE_MAX_AGE_HOURS` | `24` | Delete idle titles untouched this long. `0` turns the age rule off. |
| `TRANSCODE_MAX_GB` | `0` (no cap) | If the cache is still bigger than this after the age rule, delete least-recently-used idle titles until it fits. |

It's purely a cache: deleting an item's folder just means that title
transcodes again next time it's played. Active streams are never touched.
The first sweep after upgrading clears any existing backlog, so the
`rm -rf` by hand is optional.

## Accounts & sign-in

Until an account exists the server is open exactly as before. In
**Settings > Accounts**, create the first account: sign-in is then required
for every `/api/` and `/stream-files/` request, and that account is the
admin (admins add or remove others). Passwords are stored as scrypt hashes;
login tokens are stored only as SHA-256 hashes.

- **Separate profiles per account**: each login has its own "Who's
  watching?" profiles (and so its own history, watchlist and parental
  limits); one account can't see or touch another's. The media library
  itself is shared. Profiles that existed before accounts were turned on
  are claimed by the first account.
- **Admin dashboard** (Control Center > Admin Dashboard, admins only,
  Tautulli-style):
  - *Activity*: who is streaming right now (title, user › profile, device,
    progress), refreshed every 5 seconds.
  - *History*: a play log, one entry per viewing session, filterable by
    account/profile and searchable by title; entries can be deleted. The log
    keeps names and titles as they were, so it survives deleted profiles.
  - *Stats*: plays and hours over 7/30/90/365 days, plays per day, by hour of
    day and day of week, top users, top titles and platforms.
  - *Users*: every account with its profiles and signed-in devices; reset a
    password (signs them out everywhere), clear a profile's or a whole
    account's watch history and watchlist, delete profiles.
  Sessions are inferred from the player's progress pings, so history starts
  recording from the moment you update (nothing is back-filled). A play
  counts once at least 30 seconds were watched or the title was finished.
  Admins can access any profile's data; other accounts can't.
- **Server Settings** (dashboard tab, admins only): library scan/purge/wipe,
  unmatched items, system info and log download, TMDB/Seerr/transcode
  connections, Tailscale, and accounts. Once accounts exist the server
  refuses these actions (and the config endpoints) for non-admin accounts;
  regular users only see the Settings overlay with their profiles, audio
  language preference and About/credits. While sign-in is off, everything
  stays in Settings as before.
- **Profile pictures**: 25 built-in VYZN-styled avatars, chosen when
  creating a profile or later from Control Center > Change Profile Picture
  (sources are generated by `tools/gen-avatars.py`).
- **Login screen**: username + password with "Remember This Device"
  (token kept in `localStorage` as `vyzn_auth_token`, validated on start via
  `GET /api/auth/verify`). **Sign Out** is in the Control Center.
- **QR pairing**: the TV shows a QR code and a 6-digit code
  (`http://<server>/pair?code=123456`). On your phone, open it and tap
  *Approve TV Login* (or sign in once, which approves and signs the phone in
  too). The TV picks up the approval within ~2 seconds. Codes last 5 minutes.
- **Endpoints**: `POST /api/auth/login`, `GET /api/auth/verify`,
  `POST /api/auth/logout`, `GET /api/auth/status`, `POST /api/auth/register`,
  `POST /api/auth/pairing/session`, `GET /api/auth/pairing/status/:id`,
  `POST /api/auth/pairing/approve`, `GET /api/auth/pairing/qr/:id`.
- Locked out? Stop the container and delete the `users` rows from
  `library.db` (`sqlite3 library.db "DELETE FROM users;"`) to return to open mode.

## Known limitations (intentional)

- Sign-in is **off by default** (existing installs keep working). Once
  you create the first account in Settings > Accounts it is enforced by the
  server for everyone. There is no HTTPS built in, so still don't
  port-forward to the internet; use the Tailscale panel for remote access.
- TV shows now use a proper Show -> Season -> Episode hierarchy (see
  below) instead of flat per-episode tiles. Filenames that don't match a
  recognizable `S01E05`/`1x05`/`Season NN` pattern still fall back to a
  flat show-level match with no season/episode grouping.
- One ffmpeg process per actively-streamed item; fine for a household,
  not built for many concurrent transcodes. With HW_TRANSCODE on, encode
  is offloaded but decode is still CPU, so very old CPUs may still
  struggle with multiple simultaneous streams.
- Transcode cache cleanup is automatic (see "Transcode cache cleanup"
  below) — but it's a cache, so a title not played in the last day re-transcodes
  from scratch on its next play.

## Getting started, end to end

1. Get the server running and confirm you can scan + stream a file,
   with posters showing up in `/api/library` ("Running locally" /
   "Running on Unraid" above).
2. If you enabled `HW_TRANSCODE`, confirm `vainfo` inside the container
   sees the GPU and that a stream actually uses it (check CPU usage during
   playback, or `intel_gpu_top` on the host).
3. Browse and play from `http://<unraid-ip>:18080/` in any browser — no
   extra setup needed, it's served by the same container.
4. For a TV, install the Android TV app (`android-tv/README.md`) and point
   it at that same address on first launch.
