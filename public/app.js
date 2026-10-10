// Frontend: profile picker -> Apple-TV-style home (hero + shelves) with a
// Movies/TV flat-grid fallback tab, HLS playback via hls.js, and periodic
// playback-progress reporting so "Continue Watching" works.

const state = {
  items: [],
  shows: [],
  genres: [], // [{ id, name, itemCount }], loaded alongside the library
  tab: 'home',
  query: '',
  profile: null, // { id, name, avatar, is_child, max_content_rating }
  currentItem: null,
  seerrConfigured: false, // whether the server has SEERR_URL/SEERR_API_KEY set
};

// How many genre shelves to build on the Home view, picked by highest
// item count first — enough for a rich home screen without firing off a
// huge fan-out of /api/genres/:id/media requests on every load.
const GENRE_SHELF_LIMIT = 8;

const PROFILE_KEY = 'media-server:profileId';

// Keeps the --nav-height CSS variable (see style.css's .hero) in sync with
// .app-nav's real rendered height, so the Home hero can pull itself up
// underneath the now-transparent floating topbar by exactly the right
// amount. A ResizeObserver (rather than hooking every individual thing
// that can change that height — the topbar wrapping to 2 lines on a
// narrow/portrait screen, the window
// resizing) reacts to all of them uniformly, including the very first
// layout once the profile gate hides and .app-nav goes from 0 height to
// its real size.
const appNavEl = document.querySelector('.app-nav');
if (appNavEl) {
  const syncNavHeight = () => {
    document.documentElement.style.setProperty('--nav-height', `${appNavEl.offsetHeight}px`);
  };
  syncNavHeight();
  new ResizeObserver(syncNavHeight).observe(appNavEl);
}

// Fisher-Yates, returning a new array — used for the *order of rows
// themselves* on Home (which genre shelf leads, which "Because you
// watched X" shelf leads), so Home doesn't always open on the same
// highest-item-count genre or the same recommendation every time. A fresh
// shuffle on every renderHome() call (not just once a day), unlike
// server.js's own rotateForToday (still used there for item order *within*
// a shelf, and for which shelves/trending rows appear at all) — that one's
// deliberately stable across a whole day so a shelf's contents don't
// visibly reshuffle under someone mid-browse; row order isn't something
// anyone tracks the same way, so there's no reason to hold it stable.
function shuffle(arr) {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// --- DOM refs --------------------------------------------------------

const profileGateEl = document.getElementById('profileGate');
const profileListEl = document.getElementById('profileList');
const newProfileForm = document.getElementById('newProfileForm');
const newProfileNameEl = document.getElementById('newProfileName');
const newProfileChildEl = document.getElementById('newProfileChild');

const appEl = document.getElementById('app');
const gridEl = document.getElementById('grid');
const rowsEl = document.getElementById('rows');
const searchEl = document.getElementById('search');
// Scan Library and Settings used to have their own entry points in the
// hamburger nav menu (scanBtn/scanStatusEl, settingsTabBtn) — both now live
// in Control Center only (ccRescanBtn/ccScanInfoEl below, ccSettingsBtn),
// so those old refs are gone; every place that used to touch them now
// touches the Control Center versions instead.
const topbarLogoEl = document.getElementById('topbarLogo');
const settingsScanProgressWrapEl = document.getElementById('settingsScanProgressWrap');
const settingsScanProgressFillEl = document.getElementById('settingsScanProgressFill');
const settingsScanProgressTextEl = document.getElementById('settingsScanProgressText');
const TOPBAR_LOGO_IDLE_SRC = '/assets/vyzn-mark.svg';
const TOPBAR_LOGO_SCANNING_SRC = '/assets/vyzn-mark-scanning.svg';

// Markup for the pulsing-logo loading indicator used everywhere something
// is loading — the library grid on first load, the video player's
// buffering overlay, the Unmatched/App Switcher lists, etc. — in place of
// a plain spinner ring or bare "Loading..." text, so the one animated mark
// doubles as the app's loading affordance everywhere it appears.
// opts: { size: 'sm' | '' | 'lg', compact: boolean (tighter padding, for
// use inside an already-small panel like the Unmatched list) }.
function loadingMarkup(text, opts = {}) {
  const sizeClass = opts.size ? ` loading-mark-${opts.size}` : '';
  const compactClass = opts.compact ? ' loading-state-compact' : '';
  return `<div class="loading-state${compactClass}">
    <img src="${TOPBAR_LOGO_SCANNING_SRC}" alt="" class="loading-mark${sizeClass}" />
    ${text ? `<p class="loading-state-text">${text}</p>` : ''}
  </div>`;
}
const controlCenterBtn = document.getElementById('controlCenterBtn');
const activeProfileNameEl = document.getElementById('activeProfileName');
const appSwitcherBtn = document.getElementById('appSwitcherBtn');

const genreFilterBtn = document.getElementById('genreFilterBtn');
const genreFilterLabelEl = document.getElementById('genreFilterLabel');
const genrePillsEl = document.getElementById('genrePills');

const heroEl = document.getElementById('hero');
const heroTitleEl = document.getElementById('heroTitle');
const heroOverviewEl = document.getElementById('heroOverview');
const heroRatingEl = document.getElementById('heroRating');
const heroYearEl = document.getElementById('heroYear');
const heroDurationEl = document.getElementById('heroDuration');
const heroContentEl = document.querySelector('.hero-content');

// Control Center (slide-out glass panel)
const controlCenterScrimEl = document.getElementById('controlCenterScrim');
const controlCenterEl = document.getElementById('controlCenter');
const closeControlCenterBtn = document.getElementById('closeControlCenter');
const ccProfileListEl = document.getElementById('ccProfileList');
const ccSwitchToGateBtn = document.getElementById('ccSwitchToGateBtn');
const ccRescanBtn = document.getElementById('ccRescanBtn');
const ccSystemInfoBtn = document.getElementById('ccSystemInfoBtn');
const ccSettingsBtn = document.getElementById('ccSettingsBtn');
const ccScanInfoEl = document.getElementById('ccScanInfo');
const ccSystemInfoPanelEl = document.getElementById('ccSystemInfoPanel');
const ccSystemInfoEl = document.getElementById('ccSystemInfo');

// App switcher (active streams)
const appSwitcherOverlayEl = document.getElementById('appSwitcherOverlay');
const closeAppSwitcherBtn = document.getElementById('closeAppSwitcher');
const appSwitcherTrackEl = document.getElementById('appSwitcherTrack');

const showDetailBackBtn = document.getElementById('showDetailBack');
const showDetailEl = document.getElementById('showDetail');
const showDetailBackdropEl = document.getElementById('showDetailBackdrop');
const showDetailTitleEl = document.getElementById('showDetailTitle');
const showDetailRatingEl = document.getElementById('showDetailRating');
const showDetailYearRangeEl = document.getElementById('showDetailYearRange');
const showDetailSeasonCountEl = document.getElementById('showDetailSeasonCount');
const showDetailGenresEl = document.getElementById('showDetailGenres');
const showDetailOverviewEl = document.getElementById('showDetailOverview');
const showDetailCreatorsEl = document.getElementById('showDetailCreators');
const showDetailPlayBtn = document.getElementById('showDetailPlayBtn');
const showDetailThemeToggleBtn = document.getElementById('showDetailThemeToggleBtn');
const showDetailFilesBtn = document.getElementById('showDetailFilesBtn');
const showDetailFilesPanel = document.getElementById('showDetailFilesPanel');
const movieDetailFileInfoEl = document.getElementById('movieDetailFileInfo');
const showDetailWatchlistBtn = document.getElementById('showDetailWatchlistBtn');
const showDetailTrailerBtn = document.getElementById('showDetailTrailerBtn');
const showDetailTmdbScoreEl = document.getElementById('showDetailTmdbScore');
const showDetailCastShelfEl = document.getElementById('showDetailCastShelf');
const showDetailCastTrackEl = document.getElementById('showDetailCastTrack');
const showDetailSimilarShelfEl = document.getElementById('showDetailSimilarShelf');
const showDetailSimilarTrackEl = document.getElementById('showDetailSimilarTrack');
const seasonTabsEl = document.getElementById('seasonTabs');
const episodeListEl = document.getElementById('episodeList');

const settingsOverlayEl = document.getElementById('settingsOverlay');
const closeSettingsBtn = document.getElementById('closeSettings');
const settingsScanBtn = document.getElementById('settingsScanBtn');
const settingsRetryBtn = document.getElementById('settingsRetryBtn');
const settingsBackfillGenresBtn = document.getElementById('settingsBackfillGenresBtn');
const settingsScanInfoEl = document.getElementById('settingsScanInfo');
const purgeInputEl = document.getElementById('purgeInput');
const purgeBtn = document.getElementById('purgeBtn');
const wipeLibraryBtn = document.getElementById('wipeLibraryBtn');
const settingsAudioPrefSelectEl = document.getElementById('settingsAudioPrefSelect');
const settingsProfileListEl = document.getElementById('settingsProfileList');
const settingsAddProfileForm = document.getElementById('settingsAddProfileForm');
const settingsNewProfileNameEl = document.getElementById('settingsNewProfileName');
const settingsNewProfileChildEl = document.getElementById('settingsNewProfileChild');
const settingsSystemInfoEl = document.getElementById('settingsSystemInfo');
const unmatchedListEl = document.getElementById('unmatchedList');
const unmatchedCountEl = document.getElementById('unmatchedCount');
const unmatchedOverlayCountEl = document.getElementById('unmatchedOverlayCount');
// Unmatched items used to be a section inline in Settings — now its own
// page, opened from the "View Unmatched" button there (openUnmatchedBtn)
// and closed back to Settings (not all the way out) by closeUnmatched.
const unmatchedOverlayEl = document.getElementById('unmatchedOverlay');
const openUnmatchedBtn = document.getElementById('openUnmatchedBtn');
const closeUnmatchedBtn = document.getElementById('closeUnmatched');
const configFormEl = document.getElementById('configForm');
const configSaveStatusEl = document.getElementById('configSaveStatus');
const tailscaleStatusEl = document.getElementById('tailscaleStatus');
const tailscaleAuthKeyInputEl = document.getElementById('tailscaleAuthKeyInput');
const tailscaleConnectBtn = document.getElementById('tailscaleConnectBtn');
const tailscaleDisconnectBtn = document.getElementById('tailscaleDisconnectBtn');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const checkUpdateStatusEl = document.getElementById('checkUpdateStatus');

const movieDetailBackBtn = document.getElementById('movieDetailBack');
const movieDetailEl = document.getElementById('movieDetail');
const movieDetailBackdropEl = document.querySelector('#movieDetail .movie-detail-backdrop');
const movieDetailTitleEl = document.getElementById('movieDetailTitle');
const movieDetailRatingEl = document.getElementById('movieDetailRating');
const movieDetailYearEl = document.getElementById('movieDetailYear');
const movieDetailRuntimeEl = document.getElementById('movieDetailRuntime');
const movieDetailTmdbScoreEl = document.getElementById('movieDetailTmdbScore');
const movieDetailGenresEl = document.getElementById('movieDetailGenres');
const movieDetailOverviewEl = document.getElementById('movieDetailOverview');
const movieDetailCrewEl = document.getElementById('movieDetailCrew');
const movieDetailInfoGridEl = document.getElementById('movieDetailInfoGrid');
const movieDetailVideoInfoEl = document.getElementById('movieDetailVideoInfo');
const movieDetailAudioInfoEl = document.getElementById('movieDetailAudioInfo');
const movieDetailSubtitleInfoEl = document.getElementById('movieDetailSubtitleInfo');
const movieDetailPlayBtn = document.getElementById('movieDetailPlayBtn');
const movieDetailWatchlistBtn = document.getElementById('movieDetailWatchlistBtn');
const movieDetailTrailerBtn = document.getElementById('movieDetailTrailerBtn');
const movieDetailMenuBtn = document.getElementById('movieDetailMenuBtn');
const movieDetailMenuEl = document.getElementById('movieDetailMenu');
const movieDetailWatchedBtn = document.getElementById('movieDetailWatchedBtn');
const movieDetailRestartBtn = document.getElementById('movieDetailRestartBtn');
const movieDetailRemoveProgressBtn = document.getElementById('movieDetailRemoveProgressBtn');
const movieDetailEditMatchBtn = document.getElementById('movieDetailEditMatchBtn');
const movieDetailEditMatchPanel = document.getElementById('movieDetailEditMatchPanel');
const movieDetailEditMatchTitleEl = document.getElementById('movieDetailEditMatchTitle');
const movieDetailEditMatchTypeEl = document.getElementById('movieDetailEditMatchType');
const movieDetailEditMatchSubmitBtn = document.getElementById('movieDetailEditMatchSubmit');
const movieDetailEditMatchCancelBtn = document.getElementById('movieDetailEditMatchCancel');
const movieDetailEditMatchStatusEl = document.getElementById('movieDetailEditMatchStatus');
const movieDetailProgressWrapEl = document.getElementById('movieDetailProgressWrap');
const movieDetailProgressFillEl = document.getElementById('movieDetailProgressFill');
const movieDetailCastShelfEl = document.getElementById('movieDetailCastShelf');
const movieDetailCastTrackEl = document.getElementById('movieDetailCastTrack');
const movieDetailSimilarShelfEl = document.getElementById('movieDetailSimilarShelf');
const movieDetailSimilarTrackEl = document.getElementById('movieDetailSimilarTrack');

const playerEl = document.getElementById('player');
const videoEl = document.getElementById('video');
const videoWrapEl = document.getElementById('videoWrap');
const videoSubtitleTrackEl = document.getElementById('videoSubtitleTrack');
const closePlayerBtn = document.getElementById('closePlayer');
const playerTitleEl = document.getElementById('playerTitle');
const playerOverviewEl = document.getElementById('playerOverview');
const playerControlsEl = document.getElementById('playerControls');
const playerCurrentTimeEl = document.getElementById('playerCurrentTime');
const playerSeekEl = document.getElementById('playerSeek');
const playerRemainingTimeEl = document.getElementById('playerRemainingTime');
const playerPlayPauseBtn = document.getElementById('playerPlayPauseBtn');
const playerReplayBtn = document.getElementById('playerReplayBtn');
const playerAudioSelectEl = document.getElementById('playerAudioSelect');
const playerSubtitleBtn = document.getElementById('playerSubtitleBtn');
const playerFullscreenBtn = document.getElementById('playerFullscreenBtn');
const playerLoadingEl = document.getElementById('playerLoading');
const playerLoadingTextEl = document.getElementById('playerLoadingText');
const playerLoadingActionsEl = document.getElementById('playerLoadingActions');
const playerLoadingRetryBtn = document.getElementById('playerLoadingRetryBtn');
const playerLoadingCloseBtn = document.getElementById('playerLoadingCloseBtn');
const upNextOverlayEl = document.getElementById('upNextOverlay');
const upNextThumbEl = document.getElementById('upNextThumb');
const upNextTitleEl = document.getElementById('upNextTitle');
const upNextCountdownEl = document.getElementById('upNextCountdown');
const upNextPlayBtn = document.getElementById('upNextPlayBtn');
const upNextCancelBtn = document.getElementById('upNextCancelBtn');
const recsOverlayEl = document.getElementById('recsOverlay');
const recsHeadingEl = document.getElementById('recsHeading');
const recsGridEl = document.getElementById('recsGrid');
const recsCloseBtn = document.getElementById('recsCloseBtn');

const trailerModalEl = document.getElementById('trailerModal');
const trailerModalFrameEl = document.getElementById('trailerModalFrame');
const trailerModalCloseBtn = document.getElementById('trailerModalCloseBtn');
const trailerModalBackdropEl = document.querySelector('#trailerModal .trailer-modal-backdrop');

const AUDIO_PREF_KEY = 'media-server:audioLangPref';

let hls = null;
// Identifies the most recent startStreamAndAttach() call, so its 20s
// startup-timeout safety net (see there) can tell whether it's still the
// active attempt by the time it fires, and no-op instead of misfiring an
// error over a since-superseded play/retry/audio-track-switch.
let currentStartupToken = null;
let progressTimer = null;
let subtitleUserEnabled = false;
let instantReplayMark = null;
let isSeeking = false;

// --- Post-playback: "Up Next" auto-play + end-of-playback recommendations -
// Explicit small state machine for what the player is doing once a title
// is finishing, rather than a pile of booleans: PLAYING is just normal
// playback; COUNTDOWN is the "Up Next" corner card counting down to the
// next episode; RECOMMENDATIONS is the end-of-playback grid (a movie
// finished, or a show ran out of episodes). Read by the timeupdate/ended
// handlers below so they only ever fire the post-playback fetch once per
// title, and by openPlayer()/hidePlayerInternal() to reset/tear it down.
const PlayerPhase = { PLAYING: 'playing', COUNTDOWN: 'countdown', RECOMMENDATIONS: 'recommendations' };
let playerPhase = PlayerPhase.PLAYING;
let postPlaybackTriggered = false; // guards against firing more than once per title
let pendingNextEpisode = null;
let upNextCountdownTimer = null;
let upNextCountdownRemaining = 0;
const UP_NEXT_TRIGGER_SECONDS = 15; // how far from the end "up next"/recs can fire
const UP_NEXT_COUNTDOWN_SECONDS = 10;

// --- Immersive playback: auto-fullscreen + auto-hiding controls ----------
// Netflix/tvOS-style behavior: the scrubber/buttons show briefly, then fade
// out during playback so the video itself has the screen; any interaction
// (tap, mouse move, a D-pad/keyboard press) brings them right back. They
// stay up the whole time playback is paused — there's nothing to protect
// the view of, and hiding them while paused just makes them hard to find.
let controlsHideTimer = null;
const CONTROLS_HIDE_DELAY_MS = 2000;

function showPlayerControls() {
  playerControlsEl.classList.add('force-visible');
  videoWrapEl.classList.remove('cursor-hidden');
  // D-pad navigation (focusInDirection() below) moves from whatever
  // document.activeElement currently is — but nothing ever focuses the
  // <video> element itself (it's not in the D-pad focus selector), so
  // right up until this point activeElement is usually still <body> (set
  // there on load, or after the video-tap/Select gesture that revealed
  // these controls, which doesn't focus anything either). A body-focused
  // "current" is explicitly treated as "nothing focused in this overlay
  // yet", so every arrow press was recomputing the exact same fallback
  // (the first focusable element in the player, which is the ✕ close
  // button up in the corner outside the video — easy to miss and an odd
  // place to navigate on from) instead of ever landing on a control that's
  // actually part of this bar. Explicitly focusing Play/Pause here — the
  // first time controls appear, or any time focus has drifted outside the
  // bar (e.g. from the close button) — gives D-pad navigation a real,
  // visible anchor inside the controls every time they come up.
  if (!playerControlsEl.contains(document.activeElement)) {
    playerPlayPauseBtn.focus();
  }
  scheduleHideControls();
}

function scheduleHideControls() {
  clearTimeout(controlsHideTimer);
  if (videoEl.paused) return; // resumed by the 'play' handler below
  controlsHideTimer = setTimeout(() => {
    // Don't hide out from under an active scrub, or while a control
    // actually has keyboard/D-pad focus (browsing the audio-track picker
    // shouldn't vanish mid-navigation) — just check back shortly instead.
    if (isSeeking || playerControlsEl.contains(document.activeElement)) {
      controlsHideTimer = setTimeout(scheduleHideControls, CONTROLS_HIDE_DELAY_MS);
      return;
    }
    playerControlsEl.classList.remove('force-visible');
    videoWrapEl.classList.add('cursor-hidden');
  }, CONTROLS_HIDE_DELAY_MS);
}

// Requests real (OS/browser-level) fullscreen for the video + controls box.
// Must be called synchronously from within a user-gesture call stack (a
// click handler, before any `await`) — browsers silently refuse it
// otherwise. Not fatal if refused: the player still works fine windowed,
// and the manual ⛶ button (below) remains as a fallback.
function enterPlayerFullscreen() {
  if (document.fullscreenElement) return;
  const target = videoWrapEl.requestFullscreen ? videoWrapEl : videoEl;
  if (!target || !target.requestFullscreen) return;
  target.requestFullscreen().catch(() => {});
}

// --- Back button / swipe-back support for full-screen overlays -----------
// Without this, none of the app's overlays (Movie/Show Detail, the player,
// Settings, Control Center, App Switcher) exist in browser history at all,
// so a back gesture (mobile edge-swipe, trackpad two-finger swipe, the
// hardware/browser back button) skips straight past the app entirely and
// navigates to whatever page was open before it — not "back a screen"
// inside VYZN like every native app and most video-streaming sites behave.
//
// Fix: push a history entry when any of these overlays opens, and let a
// single popstate handler hide whichever overlay(s) are currently visible
// when that entry gets consumed — whether it's consumed by an actual back/
// swipe gesture, or by clicking an overlay's own close/back control (which
// triggers the same history.back() rather than hiding directly, so both
// paths always stay in sync with each other and with real browser history).
//
// Going from one overlay straight into another in the same click handler
// (e.g. Movie Detail's Play button opening the player) intentionally
// replaces the pushed entry instead of stacking a second one on top —
// otherwise leaving the player would take two back-taps just to get back
// to Home instead of one.
function enterOverlay() {
  if (history.state && history.state.vyznOverlay) {
    history.replaceState({ vyznOverlay: true }, '');
  } else {
    history.pushState({ vyznOverlay: true }, '');
  }
}

// Used by an overlay's own close control (X, "Back to...", clicking the
// scrim, etc.) — consumes the pushed history entry via a real back-
// navigation so it behaves identically to an actual back/swipe gesture.
// `hideFn` is the fallback for the rare case where there's no pushed entry
// to consume (e.g. the overlay was somehow left open across a navigation
// event) — that should hide it directly rather than doing nothing.
function exitOverlay(hideFn) {
  if (history.state && history.state.vyznOverlay) {
    history.back();
  } else {
    hideFn();
  }
}

window.addEventListener('popstate', () => {
  hideMovieDetailInternal();
  hideShowDetailInternal();
  hidePlayerInternal();
  hideSettingsInternal();
  hideUnmatchedInternal();
  hideControlCenterInternal();
  hideAppSwitcherInternal();
  if (window.hideAdminInternal) window.hideAdminInternal();
});

// --- D-pad / remote-control spatial navigation ----------------------------
// The browser only gives keyboard-tab ordering out of the box, which is
// useless on a TV remote (or an Android TV WebView wrapper) — arrow keys
// need to move focus geometrically, the way a native TV UI does: right
// goes to the visually-nearest thing to the right, down drops to the
// nearest thing below, etc. This is what makes the same web UI usable from
// a couch with a D-pad instead of a mouse, without needing a second,
// TV-only frontend.
//
// Scoped to whichever overlay is currently on top (or the main browsing
// area when none is), so arrow keys inside, say, Settings never jump focus
// to a poster card sitting behind it.

const SPATIAL_NAV_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getSpatialNavRoot() {
  const adminEl = document.getElementById('adminOverlay');
  if (adminEl && !adminEl.classList.contains('hidden')) return adminEl;
  if (!avatarPickerEl.classList.contains('hidden')) return avatarPickerEl;
  const loginEl = document.getElementById('loginOverlay');
  if (loginEl && !loginEl.classList.contains('hidden')) return loginEl;
  if (!appSwitcherOverlayEl.classList.contains('hidden')) return appSwitcherOverlayEl;
  if (!controlCenterEl.classList.contains('hidden')) return controlCenterEl;
  if (!genrePillsEl.classList.contains('hidden')) return genrePillsEl;
  if (!playerEl.classList.contains('hidden')) return playerEl;
  if (!movieDetailEl.classList.contains('hidden')) return movieDetailEl;
  if (!showDetailEl.classList.contains('hidden')) return showDetailEl;
  if (!settingsOverlayEl.classList.contains('hidden')) return settingsOverlayEl;
  if (!profileGateEl.classList.contains('hidden')) return profileGateEl;
  return appEl;
}

function isElementVisible(el) {
  return el.offsetParent !== null || el === document.activeElement;
}

// Moves focus to the nearest focusable element in `direction` ('up',
// 'down', 'left', 'right') from whatever's currently focused, using
// on-screen position rather than DOM order — a standard TV-remote spatial
// navigation heuristic. Distance along the direction of travel dominates
// the score; sideways drift is penalized (weighted 3x) so navigating
// through a row of cards, then down to the next row, lands on roughly the
// same column instead of snapping to whichever card happens to be closest
// in a straight line.
function focusInDirection(direction) {
  const root = getSpatialNavRoot();
  const candidates = Array.from(root.querySelectorAll(SPATIAL_NAV_SELECTOR)).filter(isElementVisible);
  if (candidates.length === 0) return;

  const current = document.activeElement;
  const currentInRoot = current && root.contains(current) && current !== document.body;
  if (!currentInRoot) {
    candidates[0].focus();
    return;
  }

  const currentRect = current.getBoundingClientRect();
  const cx = currentRect.left + currentRect.width / 2;
  const cy = currentRect.top + currentRect.height / 2;

  let best = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === current) continue;
    const rect = el.getBoundingClientRect();
    const dx = (rect.left + rect.width / 2) - cx;
    const dy = (rect.top + rect.height / 2) - cy;
    let primary;
    let perpendicular;
    if (direction === 'left') { if (dx >= -1) continue; primary = -dx; perpendicular = Math.abs(dy); }
    else if (direction === 'right') { if (dx <= 1) continue; primary = dx; perpendicular = Math.abs(dy); }
    else if (direction === 'up') { if (dy >= -1) continue; primary = -dy; perpendicular = Math.abs(dx); }
    else { if (dy <= 1) continue; primary = dy; perpendicular = Math.abs(dx); }
    const score = primary + perpendicular * 3;
    if (score < bestScore) { bestScore = score; best = el; }
  }

  if (best) {
    best.focus();
    // Deliberately NOT best.scrollIntoView() — on at least one real
    // Android TV box, calling scrollIntoView() on an element inside our
    // own overflow:auto containers (.rows, .shelf-track) silently did
    // nothing: focus moved but the container's scroll position never
    // changed, leaving a row visibly stuck/cut off at the edge of the
    // screen no matter how far "down" was pressed. scrollIntoView's
    // target-ancestor-and-offset math is entirely internal to the
    // browser engine, so there's nothing to fix about our CSS when it's
    // simply not implemented correctly — safer to never depend on it for
    // the TV remote's primary navigation path and compute the needed
    // scroll ourselves instead. See bringIntoViewManually() below.
    if (direction === 'up' || direction === 'down') {
      // A plain "nudge the focused CARD into view" (bringIntoViewManually,
      // used below for left/right) was still clipping shelf titles here:
      // on a .rows container shorter than one full shelf's content
      // (title + track), bringing just the card's bottom into view can
      // require scrolling past the title entirely, pushing it above the
      // visible top. Aligning the whole shelf's top to .rows' top instead
      // guarantees the title is always fully visible — the trade-off is
      // that a shelf taller than one screen has its BOTTOM trimmed
      // instead, which reads as "scroll for more", not a clipped label.
      scrollShelfToTop(best.closest('.shelf'));
      // Still need horizontal (shelf-track) positioning for whichever
      // card ended up focused — scrollShelfToTop only handles .rows.
      bringIntoViewManually(best, { vertical: false });
    } else {
      bringIntoViewManually(best);
    }
    // Focusing a control in a detail page's hero (Play, Watchlist, Trailer…)
    // only scrolls it *just* into view, which on a short TV screen leaves
    // the title, rating and genres scrolled off the top — and since nothing
    // focusable sits above the Play button, D-pad Up can never bring them
    // back. Whenever focus lands in the hero, show the top of the page.
    if (best.closest('.movie-detail-header')) {
      const overlay = best.closest('.movie-detail-overlay');
      if (overlay) overlay.scrollTop = 0;
    }
  }
}

// Manual replacement for Element.scrollIntoView({block:'nearest',
// inline:'nearest'}) — see the comment above focusInDirection()'s call
// site for why. Walks every scrollable ancestor up to <body> (there are
// exactly two in this app: the vertical .rows shelf list and, inside
// each shelf, the horizontal .shelf-track), and for each one, nudges its
// scrollTop/scrollLeft by exactly the amount needed to bring `el` fully
// inside that ancestor's visible box — never more, so a card already
// fully visible in a given ancestor leaves that ancestor untouched. Pure
// arithmetic on getBoundingClientRect(), no engine-specific scrolling
// API involved.
function bringIntoViewManually(el, { vertical = true } = {}) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    const canScrollY = vertical && (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1;
    const canScrollX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1;
    if (canScrollY || canScrollX) {
      const elRect = el.getBoundingClientRect();
      const containerRect = node.getBoundingClientRect();
      if (canScrollY) {
        if (elRect.top < containerRect.top) node.scrollTop -= (containerRect.top - elRect.top);
        else if (elRect.bottom > containerRect.bottom) node.scrollTop += (elRect.bottom - containerRect.bottom);
      }
      if (canScrollX) {
        if (elRect.left < containerRect.left) node.scrollLeft -= (containerRect.left - elRect.left);
        else if (elRect.right > containerRect.right) node.scrollLeft += (elRect.right - containerRect.right);
      }
    }
    node = node.parentElement;
  }
}

// Manual replacement for Element.scrollIntoView({block:'start'}) — same
// reasoning as bringIntoViewManually() above (native scrollIntoView not
// reliably moving our overflow:auto containers on at least one real
// Android TV box). Used for the genre-pill "jump to this shelf" action,
// which needs the shelf's top aligned with its scroll container's top
// rather than just nudged minimally into view.
function scrollShelfToTop(el) {
  if (!el) return;
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      const elRect = el.getBoundingClientRect();
      const containerRect = node.getBoundingClientRect();
      // containerRect.top is the container's OUTER (border) box edge —
      // before its own top padding. .rows specifically has extra top
      // padding reserved as blank space for the hero's fade to cross
      // (see style.css, calc(24px + var(--hero-row-overlap))), so
      // aligning straight to containerRect.top pulls real content back
      // up into that reserved band — which is exactly the clipping bug
      // this function was just introduced to fix. Aligning to the
      // padding-adjusted CONTENT edge instead is what actually avoids it.
      const paddingTop = parseFloat(cs.paddingTop) || 0;
      node.scrollTop += (elRect.top - (containerRect.top + paddingTop));
      return;
    }
    node = node.parentElement;
  }
}

// Custom clickable elements (plain divs with tabIndex, not real <button>s)
// don't get keyboard activation for free the way native buttons do — this
// fires their click handler on Enter/Space/the D-pad "OK" button. Real
// buttons/links/inputs are left alone; the browser already handles those.
const SPATIAL_NAV_ACTIVATABLE_SELECTOR = '.card, .episode-row';

// focusInDirection() re-scans every focusable element on the current
// screen and measures each one's position (getBoundingClientRect, plus an
// offsetParent check per candidate) — real work, not free. A remote's
// D-pad auto-repeats while held, which can fire keydown far faster than a
// human deliberately tapping arrow keys, so without this throttle, holding
// a direction re-runs that full scan+measure every single repeat event —
// on a page with a lot of shelves/cards, faster than the layout engine
// can keep up, which is exactly what shows up as janky/delayed navigation.
// This caps it to one navigation step per ~120ms — still feels immediate
// to a person, but gives layout time to settle between steps.
const SPATIAL_NAV_THROTTLE_MS = 120;
let lastSpatialNavAt = 0;

document.addEventListener('keydown', (e) => {
  // Any key at all — D-pad, arrows, Enter/OK, Tab — wakes the player
  // controls back up while the player is open, same as a tap or mouse
  // move. Checked before the isTyping guard below so it still fires while
  // focus is inside a control like the audio-track <select>.
  if (!playerEl.classList.contains('hidden')) showPlayerControls();

  const tag = (e.target && e.target.tagName || '').toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (isTyping) return;

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const now = performance.now();
    if (now - lastSpatialNavAt < SPATIAL_NAV_THROTTLE_MS) return;
    lastSpatialNavAt = now;
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    focusInDirection(dir);
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    const active = document.activeElement;
    if (active && active.matches && active.matches(SPATIAL_NAV_ACTIVATABLE_SELECTOR + ', .profile-card, .avatar-choice')) {
      e.preventDefault();
      active.click();
    }
  }
});

// --- Profiles ----------------------------------------------------------

async function fetchProfiles() {
  const res = await fetch('/api/profiles');
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function createProfile(name, isChild, avatar) {
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, avatar, is_child: isChild, max_content_rating: isChild ? 'PG' : null }),
  });
  return res.json();
}

// --- Profile pictures -------------------------------------------------------
// avatar is either an id from the built-in set (public/assets/avatars/<id>.svg)
// or, for profiles made before pictures existed, a single letter.
const AVATAR_IDS = ['vyzn','astro','robot','ghost','alien','cat','fox','bear','owl','popcorn','clap','phones','planet','bolt','moon','rocket','shades','crown','glasses3d','pad','eye','wave','gem','flame','ninja'];
function avatarInner(p) {
  if (p.avatar && /^[a-z0-9-]{2,32}$/.test(p.avatar)) {
    return `<img src="/assets/avatars/${p.avatar}.svg" alt="" class="avatar-img" draggable="false" />`;
  }
  return (p.avatar || p.name || '?').slice(0, 1).toUpperCase();
}
function hasAvatarImg(p) { return !!(p.avatar && /^[a-z0-9-]{2,32}$/.test(p.avatar)); }

let avatarPickCb = null;
const avatarPickerEl = document.getElementById('avatarPicker');
const avatarGridEl = document.getElementById('avatarGrid');
function openAvatarPicker(current, cb) {
  avatarPickCb = cb;
  avatarGridEl.innerHTML = '';
  for (const id of AVATAR_IDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-choice' + (id === current ? ' selected' : '');
    b.innerHTML = `<img src="/assets/avatars/${id}.svg" alt="${id}" draggable="false" />`;
    b.addEventListener('click', () => { const f = avatarPickCb; closeAvatarPicker(); if (f) f(id); });
    avatarGridEl.appendChild(b);
  }
  avatarPickerEl.classList.remove('hidden');
  const sel = avatarGridEl.querySelector('.selected') || avatarGridEl.firstChild;
  if (sel) sel.focus();
}
function closeAvatarPicker() { avatarPickerEl.classList.add('hidden'); avatarPickCb = null; }
document.getElementById('avatarPickerCancel').addEventListener('click', closeAvatarPicker);
avatarPickerEl.addEventListener('click', (e) => { if (e.target === avatarPickerEl) closeAvatarPicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !avatarPickerEl.classList.contains('hidden')) { e.stopPropagation(); closeAvatarPicker(); } }, true);

// New-profile form: pick a picture (random default so every new profile looks distinct).
let newProfileAvatar = AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
const newProfileAvatarBtn = document.getElementById('newProfileAvatarBtn');
function paintNewAvatar() { newProfileAvatarBtn.innerHTML = `<img src="/assets/avatars/${newProfileAvatar}.svg" alt="" draggable="false" />`; }
paintNewAvatar();
newProfileAvatarBtn.addEventListener('click', () => openAvatarPicker(newProfileAvatar, (id) => { newProfileAvatar = id; paintNewAvatar(); }));

function renderProfileList(profiles) {
  profileListEl.innerHTML = '';
  for (const p of profiles) {
    const card = document.createElement('button');
    card.className = 'profile-card';
    card.innerHTML = `<div class="profile-avatar${hasAvatarImg(p) ? ' has-img' : ''}">${avatarInner(p)}</div><span>${p.name}${p.is_child ? ' 🧒' : ''}</span>`;
    card.addEventListener('click', () => selectProfile(p));
    profileListEl.appendChild(card);
  }
}

function selectProfile(profile) {
  state.profile = profile;
  localStorage.setItem(PROFILE_KEY, String(profile.id));
  activeProfileNameEl.textContent = profile.name;
  profileGateEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  loadLibrary();
}

async function initProfiles() {
  const profiles = await fetchProfiles();
  renderProfileList(profiles);

  const savedId = localStorage.getItem(PROFILE_KEY);
  const saved = savedId ? profiles.find((p) => String(p.id) === savedId) : null;
  if (saved) {
    selectProfile(saved);
    return;
  }

  profileGateEl.classList.remove('hidden');
  const first = profileListEl.querySelector('.profile-card') || newProfileNameEl;
  if (first) setTimeout(() => first.focus(), 50);
}

newProfileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newProfileNameEl.value.trim();
  if (!name) return;
  const profile = await createProfile(name, newProfileChildEl.checked, newProfileAvatar);
  newProfileNameEl.value = '';
  newProfileChildEl.checked = false;
  const profiles = await fetchProfiles();
  renderProfileList(profiles);
  selectProfile(profile);
});

controlCenterBtn.addEventListener('click', () => openControlCenter());

document.getElementById('ccChangeAvatarBtn').addEventListener('click', () => {
  const p = state.profile;
  if (!p) return;
  openAvatarPicker(p.avatar, async (id) => {
    const res = await fetch('/api/profiles/' + p.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: id }),
    });
    if (res.ok) { state.profile = await res.json(); await renderCcProfiles(); }
  });
});

ccSwitchToGateBtn.addEventListener('click', () => {
  closeControlCenter();
  localStorage.removeItem(PROFILE_KEY);
  appEl.classList.add('hidden');
  initProfiles();
});

// --- Library / tabs ------------------------------------------------------

function isMovie(item) {
  return item.media_type === 'movie' || (!item.media_type && item.file_path.includes('/Movies/'));
}

function isTvShow(item) {
  return item.media_type === 'tv' || (!item.media_type && item.file_path.includes('/TvShows/'));
}

function matchesTab(item) {
  if (state.tab === 'movies') return isMovie(item);
  if (state.tab === 'tv') return isTvShow(item);
  return true;
}

function matchesQuery(item) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return item.title.toLowerCase().includes(q) ||
    (item.tmdb_matched_title || '').toLowerCase().includes(q);
}

// Closes any open card menu (the movie detail page's "..." menu, and the
// genre filter dropdown) when clicking anywhere outside of it.
document.addEventListener('click', () => {
  document.querySelectorAll('.card-menu.open').forEach((m) => m.classList.remove('open'));
  if (movieDetailMenuEl && !movieDetailMenuEl.classList.contains('hidden')) {
    movieDetailMenuEl.classList.add('hidden');
    movieDetailMenuBtn.setAttribute('aria-expanded', 'false');
  }
  if (!genrePillsEl.classList.contains('hidden')) closeGenreFilter();
});

// Apple-TV-style "3 dots" action menu, attached to a poster/show card.
// `actions` is a list of { label, onClick }. The button and its dropdown
// stop click propagation so they never trigger the card's own onclick
// (play / open detail).
function attachActionMenu(card, actions) {
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      action.onClick();
    });
    menu.appendChild(btn);
  }

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'card-menu-btn';
  menuBtn.setAttribute('aria-label', 'More actions');
  menuBtn.textContent = '⋮';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.card-menu.open').forEach((m) => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
  });

  card.appendChild(menuBtn);
  card.appendChild(menu);
}

function posterCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;
  // A movie opens the rich detail page (cast/crew/similar); anything else
  // (a TV episode surfaced in Continue Watching/Trending/a genre shelf)
  // keeps the old behavior of playing directly, since episodes have their
  // own browsing surface (Show Detail) rather than a page of their own.
  //
  // Exception: a card actually sitting in Continue Watching (it carries
  // position_seconds/duration_seconds — see attachActionMenu's comment
  // below for why that pair is exclusive to CW) always plays straight
  // through instead, movie or not. That's the whole point of picking it
  // from Continue Watching — Detail would just be a detour back to the
  // same Play button.
  const isContinueWatching = Boolean(item.position_seconds && item.duration_seconds);
  card.addEventListener('click', () => {
    if (isContinueWatching) openPlayer(item);
    else if (isMovie(item)) openMovieDetail(item);
    else openPlayer(item);
  });
  card.addEventListener('mouseenter', () => previewHero(item, 'movie'));
  card.addEventListener('focus', () => previewHero(item, 'movie'));
  card.addEventListener('mouseleave', () => scheduleHeroRevert());
  card.addEventListener('blur', () => scheduleHeroRevert());

  const posterWrap = document.createElement('div');
  posterWrap.className = 'poster-wrap';
  if (item.poster_url) {
    const img = document.createElement('img');
    img.src = item.poster_url;
    img.loading = 'lazy';
    img.alt = item.tmdb_matched_title || item.title;
    posterWrap.appendChild(img);
  } else {
    const noPoster = document.createElement('div');
    noPoster.className = 'no-poster';
    noPoster.textContent = item.title;
    posterWrap.appendChild(noPoster);
  }

  if (item.position_seconds && item.duration_seconds) {
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${Math.min(100, (item.position_seconds / item.duration_seconds) * 100)}%`;
    bar.appendChild(fill);
    posterWrap.appendChild(bar);
  } else if (item.completed) {
    // Whole-item "watched" checkmark (grid/shelf views only — Continue
    // Watching cards never have completed=1, that's what makes them
    // "continue" watching, so the progress bar and this badge never
    // overlap on the same card).
    const badge = document.createElement('div');
    badge.className = 'watched-badge';
    badge.textContent = '✓';
    posterWrap.appendChild(badge);
  }

  const info = document.createElement('div');
  info.className = 'card-info';
  const titleEl = document.createElement('p');
  titleEl.className = 'card-title';
  titleEl.textContent = item.tmdb_matched_title || item.title;
  const yearEl = document.createElement('p');
  yearEl.className = 'card-year';
  yearEl.textContent = item.release_year || '';
  info.appendChild(titleEl);
  info.appendChild(yearEl);

  // info is a child of posterWrap (not a sibling appended to card)
  // specifically so its position: absolute overlay (see .card .card-info
  // in style.css) is anchored to the poster image itself and gets
  // clipped by posterWrap's own overflow: hidden + rounded corners —
  // rather than to the bottom of the whole card, which would be wrong
  // for anything that adds more content below the poster (see the
  // discovery/search-result card further down, which also has a request
  // button after it).
  posterWrap.appendChild(info);
  card.appendChild(posterWrap);

  // The "⋮" card menu used to carry Play/More Info/Restart/Remove here,
  // but for a movie that's all fully redundant now: clicking the card
  // already opens Movie Detail (see the card's own click handler above),
  // which has its own Play/Watchlist/Trailer/Watched/Edit actions, plus
  // its own "..." menu for Restart/Remove-from-Continue-Watching whenever
  // the movie actually has progress. So a movie card gets no menu at all
  // now. A non-movie card (a TV episode, e.g. in Continue Watching or
  // Trending) is different — clicking it plays directly, with no detail
  // page of its own to reach Restart/Remove from — so it keeps a menu,
  // but only when it's actually sitting in Continue Watching (only those
  // cards carry position_seconds/duration_seconds, joined in from
  // playback_progress) and only with the two actions that still have no
  // other way to reach them.
  if (!isMovie(item) && item.position_seconds && item.duration_seconds && state.profile) {
    attachActionMenu(card, [
      {
        label: '↻ Restart from Beginning',
        onClick: async () => {
          await fetch(`/api/profiles/${state.profile.id}/progress/${item.id}`, { method: 'DELETE' });
          openPlayer({ ...item, position_seconds: 0 });
        },
      },
      {
        label: '✕ Remove from Continue Watching',
        onClick: async () => {
          await fetch(`/api/profiles/${state.profile.id}/progress/${item.id}`, { method: 'DELETE' });
          if (state.tab === 'home') renderHome();
        },
      },
    ]);
  }

  return card;
}

function renderShelf(container, title, items, cardBuilder, anchorId) {
  if (!items || items.length === 0) return;
  const build = cardBuilder || posterCard;
  const section = document.createElement('section');
  section.className = 'shelf';
  if (anchorId) section.id = anchorId;
  const heading = document.createElement('h3');
  heading.textContent = title;
  const track = document.createElement('div');
  track.className = 'shelf-track';
  for (const item of items) track.appendChild(build(item));
  section.appendChild(heading);
  section.appendChild(track);
  container.appendChild(section);
}

// `kind` is 'movie' (default) or 'show'. The hero used to carry its own
// "Play"/"View Episodes" + info-circle buttons, but that's redundant now
// that every card in the app opens the same place on a plain click — the
// hero just does the same thing: click (or Enter, it's focusable) anywhere
// on the title/overview and it opens Movie Detail (a show goes to its
// Show Detail/episode picker instead, same as a show card).
function setHero(item, kind) {
  if (!item) {
    heroEl.classList.add('hidden');
    return;
  }
  const effectiveKind = kind || item.kind || 'movie';
  heroEl.classList.remove('hidden');
  heroEl.querySelector('.hero-backdrop').style.backgroundImage = item.backdrop_url
    ? `url(${item.backdrop_url})`
    : 'none';
  heroTitleEl.textContent = item.tmdb_matched_title || item.title;
  heroOverviewEl.textContent = item.overview || '';
  heroRatingEl.textContent = item.content_rating || '';
  heroRatingEl.style.display = item.content_rating ? '' : 'none';
  heroYearEl.textContent = item.release_year || (item.first_air_date ? item.first_air_date.slice(0, 4) : '');
  if (heroDurationEl) {
    const runtime = formatRuntime(item.duration_sec || item.duration_seconds);
    heroDurationEl.textContent = runtime;
    heroDurationEl.style.display = runtime ? '' : 'none';
  }
  const openHeroTarget = effectiveKind === 'show'
    ? () => openShowDetail(item.id)
    : () => openMovieDetail(item);
  heroContentEl.onclick = openHeroTarget;
  heroContentEl.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openHeroTarget();
    }
  };
}

// --- tvOS "Top Shelf": hover/focus a card on the idle Home view and the
// hero above briefly previews that title instead, reverting back to the
// default hero shortly after the pointer/focus leaves. Guarded to the idle
// Home view only, so hovering a card inside the Movie Detail page's "More
// Like This" shelf (which reuses posterCard()) doesn't hijack the home
// hero sitting hidden underneath that overlay.
let heroDefaultItem = null;
let heroDefaultKind = 'movie';
let heroRevertTimer = null;

function isHomeIdle() {
  return state.tab === 'home' && !state.query &&
    movieDetailEl.classList.contains('hidden') &&
    showDetailEl.classList.contains('hidden') &&
    settingsOverlayEl.classList.contains('hidden') &&
    playerEl.classList.contains('hidden');
}

function previewHero(item, kind) {
  if (!isHomeIdle()) return;
  clearTimeout(heroRevertTimer);
  setHero(item, kind);
}

function scheduleHeroRevert() {
  clearTimeout(heroRevertTimer);
  heroRevertTimer = setTimeout(() => {
    if (!isHomeIdle()) return;
    if (heroDefaultItem) setHero(heroDefaultItem, heroDefaultKind);
  }, 200);
}

async function renderHome() {
  rowsEl.innerHTML = '';
  rowsEl.classList.remove('hidden');
  gridEl.classList.add('hidden');

  const profileId = state.profile ? state.profile.id : '';
  const [continueWatching, recommendations, trending, fresh] = await Promise.all([
    profileId ? fetchJson(`/api/profiles/${profileId}/continue-watching`) : [],
    profileId ? fetchJson(`/api/profiles/${profileId}/recommendations`) : [],
    profileId ? fetchJson(`/api/profiles/${profileId}/trending`) : [],
    profileId ? fetchJson(`/api/profiles/${profileId}/new`).catch(() => null) : null,
  ]);

  const heroSource = (continueWatching[0]) ||
    (trending.length ? trending[Math.floor(Math.random() * Math.min(trending.length, 10))] : null) ||
    state.items.find((i) => i.backdrop_url);
  heroDefaultItem = heroSource;
  heroDefaultKind = heroSource && heroSource.kind === 'show' ? 'show' : 'movie';
  setHero(heroSource, heroDefaultKind);

  renderShelf(rowsEl, 'Continue Watching', continueWatching);

  // Every other row — each "Because you watched X", Trending, and every
  // genre shelf — goes into one flat list of descriptors that then gets
  // shuffled as a single set, so the row order isn't "whatever Because You
  // Watched shelves happen to shuffle among themselves, then always
  // Trending, then whatever the genres shuffle among themselves" (which is
  // what two separate shuffles — one per fixed block — would still look
  // like). Only Continue Watching stays pinned at the very top.
  const rowDescriptors = [];
  // The server already caps this at 3 (one per each of the last 3 titles
  // actually finished), but capping again here too so Home never grows a
  // 4th+ "Because you watched" row even if that server-side limit ever
  // changes — these are meant to stay a light garnish, not take over Home.
  for (const shelf of recommendations.slice(0, 3)) {
    rowDescriptors.push({ title: `Because you watched ${shelf.basedOn}`, items: shelf.items, cardBuilder: recommendationCard });
  }
  // Trending now mixes movies and shows (server tags each row with
  // `kind`), so it needs the same dispatching card builder a genre shelf
  // uses rather than the movie-only default.
  rowDescriptors.push({ title: 'Trending', items: trending, cardBuilder: genreMediaCard });
  // "New on VYZN": recently added titles, movies and shows on separate
  // shelves. Part of the shuffled set like every other row; renderShelf
  // skips a shelf that has nothing in the recent window.
  if (fresh && !fresh.error) {
    rowDescriptors.push({ title: 'New on VYZN · Movies', items: Array.isArray(fresh.movies) ? fresh.movies : [], cardBuilder: posterCard });
    rowDescriptors.push({ title: 'New on VYZN · TV Shows', items: Array.isArray(fresh.shows) ? fresh.shows : [], cardBuilder: showCard });
  }
  rowDescriptors.push(...(await genreRowDescriptors(profileId)));

  for (const row of shuffle(rowDescriptors)) {
    renderShelf(rowsEl, row.title, row.items, row.cardBuilder, row.anchorId);
  }

  if (rowsEl.children.length === 0) {
    rowsEl.innerHTML = '<p class="empty-state">Nothing to show yet — try scanning your library.</p>';
  }
}

// Row descriptors (not yet rendered) for the top GENRE_SHELF_LIMIT genres
// by item count, mixing movies and shows — fetched in parallel rather than
// renderHome's old one-genre-at-a-time await loop, since nothing here
// depends on another genre's result. Each shelf's items are already
// rating-filtered server-side for the active profile; renderShelf itself
// skips building a section for a genre a profile's rating limit filtered
// down to nothing — that's the "auto-hide" behavior. Picking the *set* of
// genres by item count (rather than at random) still makes sense — the
// genres with barely anything in them are the ones worth leaving out —
// but which of those picked genres leads Home is exactly what
// renderHome's shuffle of every row together is for, so this no longer
// shuffles on its own.
async function genreRowDescriptors(profileId) {
  if (!state.genres || state.genres.length === 0) return [];
  const top = state.genres.slice().sort((a, b) => b.itemCount - a.itemCount).slice(0, GENRE_SHELF_LIMIT);
  const itemLists = await Promise.all(top.map((genre) => {
    const url = profileId
      ? `/api/genres/${genre.id}/media?profile_id=${profileId}`
      : `/api/genres/${genre.id}/media`;
    return fetchJson(url);
  }));
  return top.map((genre, i) => ({
    title: genre.name,
    items: itemLists[i],
    cardBuilder: genreMediaCard,
    anchorId: `genre-shelf-${genre.id}`,
  }));
}

// Genre filter for the Movies / TV Shows grids. genreFilterIds holds the
// ids of the movies (or shows) in the chosen genre, from
// /api/genres/:id/media — null means "no filter".
let genreFilterId = null;
let genreFilterIds = null;
async function setGenreFilter(id) {
  genreFilterId = id;
  genreFilterIds = null;
  if (id != null) await loadGenreFilterIds();
  render();
}
function resetGenreFilter() {
  genreFilterId = null;
  genreFilterIds = null;
  setActiveGenrePill(genrePillsEl.querySelector('.genre-pill'));
}
async function loadGenreFilterIds() {
  if (genreFilterId == null) { genreFilterIds = null; return; }
  const pid = state.profile ? `?profile_id=${state.profile.id}` : '';
  const rows = await fetchJson(`/api/genres/${genreFilterId}/media${pid}`);
  genreFilterIds = {
    movie: new Set(rows.filter((r) => r.kind === 'movie').map((r) => r.id)),
    show: new Set(rows.filter((r) => r.kind === 'show').map((r) => r.id)),
  };
}

function setActiveGenrePill(activeBtn) {
  genrePillsEl.querySelectorAll('.genre-pill').forEach((b) => b.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
  genreFilterLabelEl.textContent = activeBtn ? activeBtn.textContent : 'All Genres';
}

// Collapsed into a single floating "All Genres ▾" pill in the topbar (see
// #genreFilterBtn / the dropdown-positioning block below) instead of a
// full-width bar of pills underneath the topbar. "All" scrolls back to the
// top of the page, each genre pill smooth-scrolls down to that genre's
// shelf (built from genreRowDescriptors()'s output, in renderHome) —
// either way the dropdown closes right after, same as picking an item
// from any other menu here.
function renderGenrePills(genres) {
  genrePillsEl.innerHTML = '';
  genreFilterLabelEl.textContent = 'All Genres';
  if (!genres || genres.length === 0) return;

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'genre-pill active';
  allBtn.textContent = 'All';
  allBtn.addEventListener('click', () => {
    setActiveGenrePill(allBtn);
    closeGenreFilter();
    setGenreFilter(null);
  });
  genrePillsEl.appendChild(allBtn);

  // Movies/TV pages filter by any genre, so list them all (alphabetical).
  const top = genres.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const genre of top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-pill';
    btn.textContent = genre.name;
    btn.addEventListener('click', () => {
      setActiveGenrePill(btn);
      closeGenreFilter();
      setGenreFilter(genre.id);
    });
    genrePillsEl.appendChild(btn);
  }
}

// --- Genre filter dropdown: open/close/position ---------------------------
// Same floating-panel mechanics as the hamburger nav menu further down this
// file: reparented to <body> so its `position: fixed` isn't trapped inside
// .app-nav's own stacking context (`position: sticky` on an ancestor
// implicitly creates one — a descendant's z-index can otherwise get stuck
// painting behind a higher-z-index overlay like Movie/Show Detail), and
// repositioned fresh off the trigger button's on-screen location every time
// it opens, so it always hangs directly under the "All Genres ▾" pill
// wherever that pill currently sits (it can move if the topbar wraps to two
// lines on a narrow/portrait screen).
document.body.appendChild(genrePillsEl);

function positionGenrePills() {
  const rect = genreFilterBtn.getBoundingClientRect();
  const panelWidth = genrePillsEl.offsetWidth || 320;
  const left = Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8));
  const top = Math.min(rect.bottom + 8, window.innerHeight - 8);
  genrePillsEl.style.left = `${left}px`;
  genrePillsEl.style.top = `${top}px`;
}

function openGenreFilter() {
  positionGenrePills();
  genrePillsEl.classList.remove('hidden');
  genreFilterBtn.setAttribute('aria-expanded', 'true');
}

function closeGenreFilter() {
  genrePillsEl.classList.add('hidden');
  genreFilterBtn.setAttribute('aria-expanded', 'false');
}

genreFilterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (genrePillsEl.classList.contains('hidden')) openGenreFilter();
  else closeGenreFilter();
});

window.addEventListener('resize', () => {
  if (!genrePillsEl.classList.contains('hidden')) positionGenrePills();
});

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error('Failed to fetch', url, err);
    return [];
  }
}

// Extends the search box past the local library into Seerr (when
// configured) — things you don't own yet but could add. A separate token
// (rather than reusing the 150ms input debounce) guards against a slower
// earlier request resolving after a faster later one and clobbering fresher
// results; every caller checks its own token is still current before
// touching the DOM.
let seerrSearchToken = 0;
async function fetchSeerrExtras(query) {
  if (!state.seerrConfigured || !query || query.trim().length < 2) return [];
  const profileId = state.profile ? state.profile.id : '';
  const url = `/api/seerr/search?query=${encodeURIComponent(query)}${profileId ? `&profile_id=${profileId}` : ''}`;
  return fetchJson(url);
}

async function renderGrid() {
  heroEl.classList.add('hidden');
  rowsEl.classList.add('hidden');
  gridEl.classList.remove('hidden');

  const myToken = ++seerrSearchToken;
  const filtered = state.items.filter((item) => matchesTab(item) && matchesQuery(item)
    && (!genreFilterIds || !isMovie(item) || genreFilterIds.movie.has(item.id)));

  // Extra results from Seerr, deduped against whatever the local library
  // search above already found (by tmdb_id — the same title can otherwise
  // show up twice: once as a real library card, once as a Seerr hit).
  let extra = [];
  if (state.query) {
    const seerrResults = await fetchSeerrExtras(state.query);
    if (myToken !== seerrSearchToken) return; // a newer search has since started
    const localTmdbIds = new Set(filtered.map((i) => i.tmdb_id).filter(Boolean));
    extra = seerrResults.filter((r) => !localTmdbIds.has(r.tmdb_id));
  }

  if (filtered.length === 0 && extra.length === 0) {
    gridEl.innerHTML = '<p class="empty-state">No items found.</p>';
    return;
  }
  gridEl.innerHTML = '';
  for (const item of filtered) gridEl.appendChild(posterCard(item));

  if (extra.length) {
    const heading = document.createElement('h3');
    heading.className = 'grid-section-heading';
    heading.textContent = 'More results';
    gridEl.appendChild(heading);
    // A Seerr hit already in the library (owned: true, just matched via a
    // TMDB alias the plain title search above missed) opens like any other
    // card; one that isn't gets the discovery card's "Add to Library".
    for (const item of extra) gridEl.appendChild(recommendationCard(item));
  }
}

// --- TV shows: browse by show, then season, then episode -----------------

function showCard(show) {
  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;
  card.addEventListener('click', () => openShowDetail(show.id));
  card.addEventListener('mouseenter', () => previewHero(show, 'show'));
  card.addEventListener('focus', () => previewHero(show, 'show'));
  card.addEventListener('mouseleave', () => scheduleHeroRevert());
  card.addEventListener('blur', () => scheduleHeroRevert());

  const posterWrap = document.createElement('div');
  posterWrap.className = 'poster-wrap';
  if (show.poster_url) {
    const img = document.createElement('img');
    img.src = show.poster_url;
    img.loading = 'lazy';
    img.alt = show.title;
    posterWrap.appendChild(img);
  } else {
    const noPoster = document.createElement('div');
    noPoster.className = 'no-poster';
    noPoster.textContent = show.title;
    posterWrap.appendChild(noPoster);
  }

  const info = document.createElement('div');
  info.className = 'card-info';
  const titleEl = document.createElement('p');
  titleEl.className = 'card-title';
  titleEl.textContent = show.title;
  const yearEl = document.createElement('p');
  yearEl.className = 'card-year';
  yearEl.textContent = `${show.total_episodes || 0} episode${show.total_episodes === 1 ? '' : 's'}`;
  info.appendChild(titleEl);
  info.appendChild(yearEl);

  // See the movie card above for why info nests inside posterWrap rather
  // than being appended to card directly.
  posterWrap.appendChild(info);
  card.appendChild(posterWrap);

  // No "⋮" menu here anymore — both actions it used to hold are already
  // redundant with what the card does on its own: clicking it opens Show
  // Detail directly (see the click handler above, same as "View Episodes"
  // used to do), and hovering/focusing it already triggers the hero
  // preview ("More Info"'s only other job) via previewHero() above.

  return card;
}

// A genre shelf mixes movies and shows in one row (both tagged with a
// content genre); dispatch to whichever card type actually matches the
// fields /api/genres/:id/media sent back for that item.
function genreMediaCard(item) {
  return item.kind === 'show' ? showCard(item) : posterCard(item);
}

// A "Because you watched X" recommendation (or a Seerr search hit) the
// profile already owns is a real library item (id/file_path and all) and
// behaves exactly like any other card. One it doesn't own has no local id
// to play or open a detail page for — instead of that click throwing
// (posterCard's isMovie() reads item.file_path, which these don't have) or
// silently doing nothing, it gets its own lightweight card: poster, title,
// year, and — when the server has Seerr configured — an "Add to Library"
// button that asks Seerr to fetch it, so discovering something good is one
// click away from actually getting it instead of a dead end.
function recommendationCard(item) {
  return item.owned ? (item.kind === 'show' ? showCard(item) : posterCard(item)) : discoveryCard(item);
}

// Fires `onLongPress` after a press (pointer/touch, or Enter/Space on a
// focused element — covers mouse, touch, and D-pad/keyboard alike) is held
// on `el` for LONG_PRESS_MS without releasing, moving off, or being
// interrupted. Used by discoveryCard() so adding an unowned title to the
// library doesn't require landing precisely on its small "+" button —
// holding the select button down anywhere on the card does the same
// thing. Never interferes with a normal short click/Enter, which keeps
// firing exactly as it already did; this only adds behavior on top of a
// sustained press.
const LONG_PRESS_MS = 550;
function attachLongPress(el, onLongPress) {
  let timer = null;
  const start = (e) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onLongPress(e);
    }, LONG_PRESS_MS);
  };
  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) start(e);
  });
  el.addEventListener('keyup', cancel);
  el.addEventListener('blur', cancel);
}

function discoveryCard(item) {
  const card = document.createElement('div');
  card.className = 'card card-discovery';
  card.tabIndex = 0;

  const posterWrap = document.createElement('div');
  posterWrap.className = 'poster-wrap';
  if (item.poster_url) {
    const img = document.createElement('img');
    img.src = item.poster_url;
    img.loading = 'lazy';
    img.alt = item.title;
    posterWrap.appendChild(img);
  } else {
    const noPoster = document.createElement('div');
    noPoster.className = 'no-poster';
    noPoster.textContent = item.title;
    posterWrap.appendChild(noPoster);
  }
  const info = document.createElement('div');
  info.className = 'card-info';
  const titleEl = document.createElement('p');
  titleEl.className = 'card-title';
  titleEl.textContent = item.title;
  const yearEl = document.createElement('p');
  yearEl.className = 'card-year';
  yearEl.textContent = item.release_year || '';
  info.appendChild(titleEl);
  info.appendChild(yearEl);

  // A small corner "+" on the poster, not a full-width button below it —
  // that extra row used to make a discovery card taller than every other
  // card sharing its shelf and needed a separately-aimed click. A Seerr
  // *search* hit (unlike a plain recommendation) already knows whether
  // it's sitting in Seerr's own pending/processing/available queue —
  // surface that instead of offering to add it again.
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'card-add-btn';
  addBtn.setAttribute('aria-label', 'Add to Library');

  const setAddBtnIdle = () => {
    // Nothing useful to do yet (no Seerr) or nothing left to request (it's
    // already fully available) — no button at all rather than a disabled
    // one, same spirit as the rest of this card only showing controls
    // that do something.
    if (!state.seerrConfigured || item.already_available) {
      addBtn.classList.add('hidden');
      addBtn.disabled = true;
      return;
    }
    addBtn.classList.remove('hidden');
    if (item.already_requested) {
      addBtn.textContent = '✓';
      addBtn.classList.add('added');
      addBtn.disabled = true;
      addBtn.title = 'Already Requested';
    } else {
      addBtn.textContent = '+';
      addBtn.classList.remove('added');
      addBtn.disabled = false;
      addBtn.title = 'Add to Library';
    }
  };
  setAddBtnIdle();

  let addInFlight = false;
  async function triggerAdd() {
    if (addInFlight || addBtn.disabled) return;
    addInFlight = true;
    addBtn.disabled = true;
    addBtn.textContent = '…';
    try {
      const res = await fetch('/api/seerr/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId: item.tmdb_id, mediaType: item.media_type }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Add to Library failed');
      addBtn.textContent = '✓';
      addBtn.classList.add('added');
      addBtn.title = data.alreadyRequested ? 'Already Requested' : 'Added to Library';
    } catch (err) {
      addBtn.textContent = '!';
      addBtn.title = err.message || 'Add failed — try again';
      setTimeout(() => { addInFlight = false; setAddBtnIdle(); }, 2000);
      return;
    }
    addInFlight = false;
  }

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerAdd();
  });
  // Long-press anywhere on the card (poster or title) does the same thing
  // as tapping the small + button — see attachLongPress()'s own comment
  // above for why this exists.
  attachLongPress(card, (e) => {
    e.preventDefault();
    triggerAdd();
  });

  // See the movie card above for why info nests inside posterWrap rather
  // than being appended to card directly. addBtn is also a posterWrap
  // child (not a card child) so it's positioned relative to the poster
  // itself — consistent with it now being a corner badge rather than a
  // block below the poster.
  posterWrap.appendChild(addBtn);
  posterWrap.appendChild(info);
  card.appendChild(posterWrap);

  // Deliberately no hover-preview-into-hero here (unlike posterCard/
  // showCard): clicking the hero opens Movie/Show Detail for a locally
  // playable item (openMovieDetail(item) / openShowDetail(item.id)), and
  // this card has neither a file to play nor a local id to look up —
  // previewing it into the hero would just make the hero a dead end.

  return card;
}

async function renderTvGrid() {
  heroEl.classList.add('hidden');
  rowsEl.classList.add('hidden');
  gridEl.classList.remove('hidden');
  gridEl.innerHTML = loadingMarkup('Loading shows...');

  const profileId = state.profile ? state.profile.id : '';
  const url = profileId ? `/api/shows?profile_id=${profileId}` : '/api/shows';
  state.shows = await fetchJson(url);

  const myToken = ++seerrSearchToken;
  const byGenre = genreFilterIds ? state.shows.filter((s) => genreFilterIds.show.has(s.id)) : state.shows;
  const filtered = state.query
    ? byGenre.filter((s) => s.title.toLowerCase().includes(state.query.toLowerCase()))
    : byGenre;

  let extra = [];
  if (state.query) {
    const seerrResults = await fetchSeerrExtras(state.query);
    if (myToken !== seerrSearchToken) return;
    const localTmdbIds = new Set(filtered.map((s) => s.tmdb_id).filter(Boolean));
    // This grid is shows only — a Seerr hit for a movie belongs on the
    // Movies/Home search instead.
    extra = seerrResults.filter((r) => r.media_type === 'tv' && !localTmdbIds.has(r.tmdb_id));
  }

  if (filtered.length === 0 && extra.length === 0) {
    gridEl.innerHTML = '<p class="empty-state">No shows found. Scan your library to index some.</p>';
    return;
  }
  gridEl.innerHTML = '';
  for (const show of filtered) gridEl.appendChild(showCard(show));

  if (extra.length) {
    const heading = document.createElement('h3');
    heading.className = 'grid-section-heading';
    heading.textContent = 'More results';
    gridEl.appendChild(heading);
    for (const item of extra) gridEl.appendChild(recommendationCard(item));
  }
}

// Neutral placeholder for an episode with no TMDB still and no fallback
// poster (a brand-new/unmatched episode, mostly) — a plain "no image" tile
// rather than leaving a blank hole in the row, per the spec's "clean SVG
// fallbacks for episode thumbnails" requirement.
const EPISODE_THUMB_FALLBACK = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">' +
  '<rect width="160" height="90" fill="#232323"/>' +
  '<path d="M64 30l36 15-36 15z" fill="#4a4a4a"/>' +
  '</svg>'
)}`;

function episodeRow(ep) {
  const row = document.createElement('div');
  row.className = 'episode-row';
  row.tabIndex = 0;
  row.addEventListener('click', () => {
    hideShowDetailInternal();
    openPlayer({
      id: ep.media_id,
      title: ep.title,
      tmdb_matched_title: ep.title,
      overview: ep.overview,
      position_seconds: ep.position_seconds,
      duration_sec: ep.duration_sec,
      audio_tracks: ep.audio_tracks,
    });
  });

  const thumb = document.createElement('div');
  thumb.className = 'episode-thumb';
  const img = document.createElement('img');
  img.src = ep.still_url || ep.poster_url || EPISODE_THUMB_FALLBACK;
  img.loading = 'lazy';
  img.alt = '';
  thumb.appendChild(img);
  if (ep.position_seconds && ep.duration_seconds) {
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${Math.min(100, (ep.position_seconds / ep.duration_seconds) * 100)}%`;
    bar.appendChild(fill);
    thumb.appendChild(bar);
  } else if (ep.completed) {
    const badge = document.createElement('div');
    badge.className = 'watched-badge';
    badge.textContent = '✓';
    thumb.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'episode-meta';
  const titleRow = document.createElement('div');
  titleRow.className = 'episode-title-row';
  const title = document.createElement('p');
  title.className = 'episode-title';
  title.textContent = ep.title || `Episode ${ep.episode_number}`;
  const numEl = document.createElement('div');
  numEl.className = 'episode-num';
  numEl.textContent = String(ep.episode_number);
  titleRow.appendChild(title);
  const runtime = formatRuntime(ep.duration_sec);
  if (runtime) {
    const runtimeEl = document.createElement('span');
    runtimeEl.className = 'episode-runtime';
    runtimeEl.textContent = runtime;
    titleRow.appendChild(runtimeEl);
  }
  const overview = document.createElement('p');
  overview.className = 'episode-overview';
  overview.textContent = ep.overview || '';
  meta.appendChild(titleRow);
  meta.appendChild(overview);

  row.appendChild(numEl);
  row.appendChild(thumb);
  row.appendChild(meta);
  return row;
}

function renderSeasonEpisodes(season) {
  episodeListEl.innerHTML = '';
  for (const ep of season.episodes) episodeListEl.appendChild(episodeRow(ep));
}

// --- Show Detail: theme music engine --------------------------------------
// A single managed <audio> instance, faded in on open and faded out on
// close/navigate-away/play — never more than one at a time (opening a
// second show, or jumping into an episode, always tears down whatever was
// playing first). TMDB has no theme-song API, so `themeUrl` (from
// GET /api/shows/:id/details) is only ever non-null when the server found a
// matching file under public/theme-music/ — see server.js's
// getShowThemeUrl for how to add one. A null/missing url is the common
// case and is handled silently: no theme plays, nothing in the UI reacts.
const THEME_MUTED_KEY = 'vyzn_theme_muted';
let themeAudio = null;
let themeMuted = localStorage.getItem(THEME_MUTED_KEY) === 'true';
let currentShowThemeUrl = null;

function updateThemeToggleBtn() {
  showDetailThemeToggleBtn.textContent = themeMuted ? '🔇' : '🔊';
  showDetailThemeToggleBtn.setAttribute('aria-label', themeMuted ? 'Unmute theme music' : 'Mute theme music');
}
updateThemeToggleBtn();

// Ramps `audio.volume` from its current value to `toVolume` over
// `durationMs`, in 20 steps — smooth enough for a fade, cheap enough not to
// matter running as a setInterval. Re-entrant: starting a new fade on the
// same element clears whatever fade was already in progress on it (the
// fade timer id is stashed directly on the element) rather than letting two
// fades fight over the same volume property.
function fadeAudio(audio, toVolume, durationMs, onDone) {
  clearInterval(audio._vyznFadeTimer);
  const steps = 20;
  const stepMs = durationMs / steps;
  const startVolume = audio.volume;
  const delta = (toVolume - startVolume) / steps;
  let i = 0;
  audio._vyznFadeTimer = setInterval(() => {
    i += 1;
    audio.volume = Math.min(1, Math.max(0, startVolume + delta * i));
    if (i >= steps) {
      clearInterval(audio._vyznFadeTimer);
      audio.volume = Math.min(1, Math.max(0, toVolume));
      if (onDone) onDone();
    }
  }, stepMs);
}

function stopThemeMusic() {
  const audio = themeAudio;
  themeAudio = null;
  if (!audio) return;
  fadeAudio(audio, 0, 500, () => {
    audio.pause();
    audio.currentTime = 0;
  });
}

function playThemeMusic(url) {
  stopThemeMusic();
  if (!url || themeMuted) return;
  const audio = new Audio(url);
  audio.loop = true;
  audio.volume = 0;
  themeAudio = audio;
  // Autoplay can be blocked (no prior user interaction yet, or the browser
  // is just strict about it) — that's not an error worth surfacing, the
  // detail page works fine with no music, so this fails silently rather
  // than throwing something the rest of the page has to catch.
  audio.play().then(() => {
    if (themeAudio === audio) fadeAudio(audio, 0.3, 1500);
  }).catch(() => {});
}

showDetailThemeToggleBtn.addEventListener('click', () => {
  themeMuted = !themeMuted;
  localStorage.setItem(THEME_MUTED_KEY, String(themeMuted));
  updateThemeToggleBtn();
  if (themeMuted) stopThemeMusic();
  else playThemeMusic(currentShowThemeUrl);
});

// First not-yet-completed episode across all seasons, in order — what the
// hero's primary action button should offer ("Play S1:E1" for a show
// nobody's started, "Resume S2:E4" for one already in progress, partway
// through an episode or not). If every indexed episode is already marked
// watched, falls back to offering the very first episode again rather than
// hiding the button — there's always something reasonable to play.
function findNextEpisodeToPlay(show) {
  for (const season of show.seasons) {
    for (const ep of season.episodes) {
      if (!ep.completed) return { season, ep };
    }
  }
  const firstSeason = show.seasons[0];
  const firstEp = firstSeason && firstSeason.episodes[0];
  return firstSeason && firstEp ? { season: firstSeason, ep: firstEp } : null;
}

async function openShowDetail(showId) {
  stopThemeMusic();
  currentShowThemeUrl = null;

  const profileId = state.profile ? state.profile.id : '';
  const url = profileId ? `/api/shows/${showId}?profile_id=${profileId}` : `/api/shows/${showId}`;
  const show = await fetchJson(url);
  if (!show || !show.id) return;
  state.currentShowDetail = show;

  showDetailEl.scrollTop = 0;
  showDetailFilesPanel.classList.add('hidden');
  showDetailFilesBtn.setAttribute('aria-expanded', 'false');
  showDetailTitleEl.textContent = show.title;
  showDetailBackdropEl.style.backgroundImage = show.backdrop_url ? `url(${show.backdrop_url})` : 'none';
  showDetailOverviewEl.textContent = show.overview || '';
  showDetailRatingEl.textContent = show.content_rating || '';
  showDetailRatingEl.style.display = show.content_rating ? '' : 'none';
  showDetailYearRangeEl.textContent = '';
  showDetailSeasonCountEl.textContent = show.seasons.length
    ? `${show.seasons.length} Season${show.seasons.length === 1 ? '' : 's'}`
    : '';
  showDetailGenresEl.innerHTML = '';
  showDetailCreatorsEl.textContent = '';
  // tv_shows carries no numeric TMDB rating column (unlike media_items),
  // so there's nothing to show a score badge from yet — left hidden here
  // rather than guessing at a value.
  showDetailTmdbScoreEl.classList.add('hidden');
  showDetailWatchlistBtn.classList.remove('active');
  showDetailWatchlistBtn.setAttribute('aria-pressed', 'false');
  showDetailWatchlistBtn.title = 'Add to Watchlist';
  showDetailWatchlistBtn.onclick = () => {
    const isActive = showDetailWatchlistBtn.classList.contains('active');
    setWatchlist(showDetailWatchlistBtn, show, 'tv', !isActive);
  };
  showDetailTrailerBtn.classList.add('hidden');
  showDetailTrailerBtn.onclick = null;
  showDetailCastShelfEl.classList.add('hidden');
  showDetailCastTrackEl.innerHTML = '';
  showDetailSimilarShelfEl.classList.add('hidden');
  showDetailSimilarTrackEl.innerHTML = '';

  const next = findNextEpisodeToPlay(show);
  if (next) {
    const label = `S${next.season.season_number}:E${next.ep.episode_number}`;
    showDetailPlayBtn.style.display = '';
    showDetailPlayBtn.textContent = next.ep.position_seconds > 0 ? `▶ Resume ${label}` : `▶ Play ${label}`;
    showDetailPlayBtn.onclick = () => {
      hideShowDetailInternal();
      openPlayer({
        id: next.ep.media_id,
        title: next.ep.title,
        tmdb_matched_title: next.ep.title,
        overview: next.ep.overview,
        position_seconds: next.ep.position_seconds || 0,
        duration_sec: next.ep.duration_sec,
        audio_tracks: next.ep.audio_tracks,
      });
    };
  } else {
    showDetailPlayBtn.style.display = 'none';
  }

  seasonTabsEl.innerHTML = '';
  show.seasons.forEach((season, idx) => {
    const btn = document.createElement('button');
    btn.className = 'season-tab-btn' + (idx === 0 ? ' active' : '');
    btn.textContent = season.title || `Season ${season.season_number}`;
    btn.addEventListener('click', () => {
      seasonTabsEl.querySelectorAll('.season-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderSeasonEpisodes(season);
    });
    seasonTabsEl.appendChild(btn);
  });

  if (show.seasons.length > 0) renderSeasonEpisodes(show.seasons[0]);
  else episodeListEl.innerHTML = '<p class="empty-state">No episodes indexed yet.</p>';

  showDetailEl.classList.remove('hidden');
  showDetailBackBtn.classList.remove('hidden');
  document.body.classList.add('detail-open');
  enterOverlay();

  // Everything above is enough to show the page immediately; genres, year
  // range, cast, creators, theme music and "More Like This" all depend on
  // a TMDB-backed lookup (cached, but still an extra request) and fill in
  // a moment later without blocking the initial paint.
  const detailsUrl = profileId ? `/api/shows/${showId}/details?profile_id=${profileId}` : `/api/shows/${showId}/details`;
  const details = await fetchJson(detailsUrl);
  if (!state.currentShowDetail || state.currentShowDetail.id !== show.id) return;
  if (!details || details.error) return;

  showDetailYearRangeEl.textContent = details.yearRange || '';

  if (details.genres && details.genres.length) {
    for (const genre of details.genres) {
      // Plain text, not a button — see the identical comment in
      // openMovieDetail for why.
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = genre.name;
      showDetailGenresEl.appendChild(tag);
    }
  }

  if (details.creators && details.creators.length) {
    showDetailCreatorsEl.textContent = `Created by ${details.creators.join(', ')}`;
  }

  if (details.cast && details.cast.length) {
    for (const person of details.cast) showDetailCastTrackEl.appendChild(castCard(person));
    showDetailCastShelfEl.classList.remove('hidden');
  }

  if (details.similar && details.similar.length) {
    for (const similarShow of details.similar) showDetailSimilarTrackEl.appendChild(showCard(similarShow));
    showDetailSimilarShelfEl.classList.remove('hidden');
  }

  if (details.inWatchlist) {
    showDetailWatchlistBtn.classList.add('active');
    showDetailWatchlistBtn.setAttribute('aria-pressed', 'true');
    showDetailWatchlistBtn.title = 'Remove from Watchlist';
  }

  if (details.trailerKey) {
    showDetailTrailerBtn.classList.remove('hidden');
    showDetailTrailerBtn.onclick = () => openTrailer(details.trailerKey);
  }

  currentShowThemeUrl = details.themeUrl || null;
  if (currentShowThemeUrl) playThemeMusic(currentShowThemeUrl);
}

function hideShowDetailInternal() {
  showDetailEl.classList.add('hidden');
  showDetailBackBtn.classList.add('hidden');
  document.body.classList.remove('detail-open');
  state.currentShowDetail = null;
  stopThemeMusic();
  currentShowThemeUrl = null;
}

function closeShowDetail() {
  exitOverlay(hideShowDetailInternal);
}

showDetailBackBtn.addEventListener('click', closeShowDetail);

// --- Movie detail page: hero header + cast carousel + "More Like This" ---

function formatRuntime(durationSec) {
  if (!durationSec) return '';
  const totalMinutes = Math.round(durationSec / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// --- Trailer modal (shared by Movie Detail + Show Detail) -----------------
// A YouTube embed over a dimmed backdrop, matching the app's own overlay
// look, rather than sending the person out to a new tab/app.
function openTrailer(key) {
  if (!key) return;
  trailerModalFrameEl.src = `https://www.youtube.com/embed/${key}?autoplay=1&rel=0&modestbranding=1`;
  trailerModalEl.classList.remove('hidden');
}
function closeTrailer() {
  trailerModalEl.classList.add('hidden');
  // Clearing src (rather than just hiding) actually stops playback/audio —
  // an iframe left pointed at a YouTube embed keeps playing even once its
  // container is display:none.
  trailerModalFrameEl.src = '';
}
trailerModalCloseBtn.addEventListener('click', closeTrailer);
trailerModalBackdropEl.addEventListener('click', closeTrailer);

// --- Video/Audio/Subtitles info block (Movie Detail) -----------------------
// Formats the raw ffprobe-derived columns scanner.js stores
// (resolution "1920x1080", codec "h264"/"hevc"/..., audio_tracks/
// subtitle_tracks JSON) into the same kind of plain-language summary a
// streaming app's "more info" panel shows, rather than the raw technical
// values.
const VIDEO_CODEC_LABELS = { h264: 'H.264', hevc: 'H.265 (HEVC)', h265: 'H.265 (HEVC)', av1: 'AV1', mpeg4: 'MPEG-4', vp9: 'VP9' };
const LANGUAGE_LABELS = {
  eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German',
  ita: 'Italian', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', por: 'Portuguese',
  rus: 'Russian', ara: 'Arabic', hin: 'Hindi', nld: 'Dutch', dut: 'Dutch', swe: 'Swedish', tur: 'Turkish',
  und: 'Unknown',
};

function formatResolution(resolution) {
  if (!resolution) return null;
  const match = /(\d+)x(\d+)/.exec(resolution);
  if (!match) return resolution;
  const height = parseInt(match[2], 10);
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 500) return '480p';
  return 'SD';
}

function formatVideoCodec(codec) {
  if (!codec) return null;
  return VIDEO_CODEC_LABELS[codec.toLowerCase()] || codec.toUpperCase();
}

function formatLanguage(code) {
  if (!code) return 'Unknown';
  return LANGUAGE_LABELS[code.toLowerCase()] || code.toUpperCase();
}

function formatChannels(channels) {
  if (!channels) return null;
  const map = { 1: '1.0', 2: '2.0', 3: '2.1', 6: '5.1', 8: '7.1' };
  return map[channels] || `${channels}ch`;
}

function updateDetailInfoGrid(item) {
  const resLabel = formatResolution(item.resolution);
  const codecLabel = formatVideoCodec(item.codec);
  movieDetailVideoInfoEl.textContent = resLabel && codecLabel ? `${resLabel} (${codecLabel})` : (resLabel || codecLabel || 'Unknown');

  let audioTracks = [];
  try { audioTracks = item.audio_tracks ? JSON.parse(item.audio_tracks) : []; } catch { audioTracks = []; }
  if (audioTracks.length) {
    const primary = audioTracks[0];
    const bits = [formatLanguage(primary.language)];
    const codecChannel = [primary.codec ? primary.codec.toUpperCase() : null, formatChannels(primary.channels)].filter(Boolean).join(' ');
    if (codecChannel) bits.push(`(${codecChannel})`);
    movieDetailAudioInfoEl.textContent = bits.join(' ') + (audioTracks.length > 1 ? ` +${audioTracks.length - 1} more` : '');
  } else {
    movieDetailAudioInfoEl.textContent = 'Unknown';
  }

  let subtitleTracks = [];
  try { subtitleTracks = item.subtitle_tracks ? JSON.parse(item.subtitle_tracks) : []; } catch { subtitleTracks = []; }
  movieDetailSubtitleInfoEl.textContent = subtitleTracks.length
    ? subtitleTracks.map((t) => formatLanguage(t.language)).join(', ')
    : 'None available';

  movieDetailInfoGridEl.classList.remove('hidden');
}

function castCard(person) {
  const card = document.createElement('div');
  card.className = 'cast-card';

  const avatar = document.createElement('div');
  avatar.className = 'cast-avatar';
  if (person.profileUrl) {
    const img = document.createElement('img');
    img.src = person.profileUrl;
    img.loading = 'lazy';
    img.alt = person.name;
    avatar.appendChild(img);
  } else {
    avatar.textContent = (person.name || '?').slice(0, 1).toUpperCase();
  }

  const name = document.createElement('p');
  name.className = 'cast-name';
  name.textContent = person.name;
  const character = document.createElement('p');
  character.className = 'cast-character';
  character.textContent = person.character || '';

  card.appendChild(avatar);
  card.appendChild(name);
  card.appendChild(character);
  return card;
}

// The checkmark button in the action bar is a straight toggle now (not a
// dropdown item), so its own state (the 'active' class + title) is what
// tells markWatched/unmarkWatched which way to go next — see the onclick
// wiring in openMovieDetail.
function setWatchedButtonState(watched) {
  movieDetailWatchedBtn.classList.toggle('active', watched);
  movieDetailWatchedBtn.setAttribute('aria-pressed', String(watched));
  movieDetailWatchedBtn.title = watched ? 'Mark as Not Watched' : 'Mark as Watched';
}

async function markWatched(item) {
  if (!state.profile) return;
  closeMovieDetailMenu();
  movieDetailWatchedBtn.disabled = true;
  try {
    const duration = item.duration_sec || 1;
    await fetch(`/api/profiles/${state.profile.id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: item.id, position_seconds: duration, duration_seconds: duration }),
    });
    setWatchedButtonState(true);
    movieDetailProgressWrapEl.classList.add('hidden');
    movieDetailPlayBtn.textContent = '▶ Play';
    movieDetailPlayBtn.onclick = () => { hideMovieDetailInternal(); openPlayer({ ...item, position_seconds: 0 }); };
    movieDetailRestartBtn.classList.add('hidden');
    movieDetailRemoveProgressBtn.classList.add('hidden');
    movieDetailMenuBtn.classList.add('hidden');
  } catch (err) {
    console.error(err);
  } finally {
    movieDetailWatchedBtn.disabled = false;
  }
}

// The un-watch side of the toggle — there's no separate "watched" flag to
// clear, so this just drops the item's playback progress entirely (same
// mechanism "Remove from Continue Watching" already used), which is exactly
// what un-marking a fully-watched title means: no saved position at all.
async function unmarkWatched(item) {
  if (!state.profile) return;
  movieDetailWatchedBtn.disabled = true;
  try {
    await fetch(`/api/profiles/${state.profile.id}/progress/${item.id}`, { method: 'DELETE' });
    setWatchedButtonState(false);
    movieDetailProgressWrapEl.classList.add('hidden');
    movieDetailPlayBtn.textContent = '▶ Play';
    movieDetailPlayBtn.onclick = () => { hideMovieDetailInternal(); openPlayer({ ...item, position_seconds: 0 }); };
    movieDetailRestartBtn.classList.add('hidden');
    movieDetailRemoveProgressBtn.classList.add('hidden');
    movieDetailMenuBtn.classList.add('hidden');
  } catch (err) {
    console.error(err);
  } finally {
    movieDetailWatchedBtn.disabled = false;
  }
}

// Watchlist toggle — shared shape for both Movie Detail and Show Detail
// (itemType is 'movie' or 'tv'; the button is whichever detail page's own
// bookmark icon is currently wired up).
async function setWatchlist(btn, item, itemType, add) {
  if (!state.profile) return;
  btn.disabled = true;
  try {
    if (add) {
      await fetch(`/api/profiles/${state.profile.id}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: item.id, item_type: itemType }),
      });
    } else {
      await fetch(`/api/profiles/${state.profile.id}/watchlist/${itemType}/${item.id}`, { method: 'DELETE' });
    }
    btn.classList.toggle('active', add);
    btn.setAttribute('aria-pressed', String(add));
    btn.title = add ? 'Remove from Watchlist' : 'Add to Watchlist';
  } catch (err) {
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// Opens the full-page movie detail view: immediately shows what we already
// have (title/backdrop/overview/year from the passed-in item), then fills
// in genres/cast/crew/similar once GET /api/library/:id/details resolves,
// so the page never sits on a blank screen waiting on TMDB.
async function openMovieDetail(item, { forceRefresh = false } = {}) {
  state.currentDetailItem = item;

  movieDetailEl.scrollTop = 0;
  movieDetailTitleEl.textContent = item.tmdb_matched_title || item.title;
  movieDetailBackdropEl.style.backgroundImage = item.backdrop_url ? `url(${item.backdrop_url})` : 'none';
  movieDetailOverviewEl.textContent = item.overview || '';
  movieDetailRatingEl.textContent = item.content_rating || '';
  movieDetailRatingEl.style.display = item.content_rating ? '' : 'none';
  movieDetailYearEl.textContent = item.release_year || '';
  movieDetailRuntimeEl.textContent = formatRuntime(item.duration_sec);
  // TMDB's own 0-10 vote_average, shown as a rounded percentage — the
  // closest thing to a review score this server has without a separate
  // OMDb/IMDb integration (TMDB doesn't expose the actual IMDb or Rotten
  // Tomatoes scores, only its own community rating).
  if (typeof item.rating === 'number' && item.rating > 0) {
    movieDetailTmdbScoreEl.textContent = `TMDB ${Math.round(item.rating * 10)}%`;
    movieDetailTmdbScoreEl.classList.remove('hidden');
  } else {
    movieDetailTmdbScoreEl.classList.add('hidden');
  }
  movieDetailGenresEl.innerHTML = '';
  movieDetailCrewEl.textContent = '';
  movieDetailInfoGridEl.classList.add('hidden');
  updateDetailInfoGrid(item);
  movieDetailProgressWrapEl.classList.add('hidden');
  movieDetailPlayBtn.textContent = '▶ Play';
  setWatchedButtonState(false);
  movieDetailWatchedBtn.disabled = false;
  movieDetailWatchlistBtn.classList.remove('active');
  movieDetailWatchlistBtn.setAttribute('aria-pressed', 'false');
  movieDetailWatchlistBtn.title = 'Add to Watchlist';
  movieDetailTrailerBtn.classList.add('hidden');
  movieDetailTrailerBtn.onclick = null;
  movieDetailRestartBtn.classList.add('hidden');
  movieDetailRemoveProgressBtn.classList.add('hidden');
  movieDetailMenuEl.classList.add('hidden');
  movieDetailMenuBtn.classList.add('hidden');
  movieDetailMenuBtn.setAttribute('aria-expanded', 'false');
  movieDetailCastShelfEl.classList.add('hidden');
  movieDetailCastTrackEl.innerHTML = '';
  movieDetailSimilarShelfEl.classList.add('hidden');
  movieDetailSimilarTrackEl.innerHTML = '';
  movieDetailEditMatchPanel.classList.add('hidden');
  movieDetailEditMatchStatusEl.textContent = '';
  movieDetailEditMatchStatusEl.className = 'unmatched-status';
  movieDetailEditMatchTitleEl.value = item.tmdb_matched_title || item.title;
  movieDetailEditMatchTypeEl.value = item.media_type === 'tv' ? 'tv' : 'movie';
  renderFileInfo(movieDetailFileInfoEl, item);

  movieDetailPlayBtn.onclick = () => { hideMovieDetailInternal(); openPlayer(item); };
  movieDetailWatchedBtn.onclick = () => {
    if (movieDetailWatchedBtn.classList.contains('active')) unmarkWatched(item);
    else markWatched(item);
  };
  movieDetailWatchlistBtn.onclick = () => {
    const isActive = movieDetailWatchlistBtn.classList.contains('active');
    setWatchlist(movieDetailWatchlistBtn, item, 'movie', !isActive);
  };

  movieDetailRestartBtn.onclick = async () => {
    closeMovieDetailMenu();
    if (!state.profile) return;
    await fetch(`/api/profiles/${state.profile.id}/progress/${item.id}`, { method: 'DELETE' });
    hideMovieDetailInternal();
    openPlayer({ ...item, position_seconds: 0 });
  };

  movieDetailRemoveProgressBtn.onclick = async () => {
    closeMovieDetailMenu();
    if (!state.profile) return;
    await fetch(`/api/profiles/${state.profile.id}/progress/${item.id}`, { method: 'DELETE' });
    // No more progress to resume/restart/remove — drop back to a plain
    // "Play" button and hide these two menu items until a new watch
    // session gives the item progress again.
    movieDetailProgressWrapEl.classList.add('hidden');
    movieDetailPlayBtn.textContent = '▶ Play';
    movieDetailPlayBtn.onclick = () => { hideMovieDetailInternal(); openPlayer({ ...item, position_seconds: 0 }); };
    movieDetailRestartBtn.classList.add('hidden');
    movieDetailRemoveProgressBtn.classList.add('hidden');
    movieDetailMenuBtn.classList.add('hidden');
    setWatchedButtonState(false);
  };

  movieDetailEl.classList.remove('hidden');
  movieDetailBackBtn.classList.remove('hidden');
  document.body.classList.add('detail-open');
  enterOverlay();

  const profileId = state.profile ? state.profile.id : '';
  const params = new URLSearchParams();
  if (profileId) params.set('profile_id', profileId);
  if (forceRefresh) params.set('refresh', 'true');
  const query = params.toString();
  const url = `/api/library/${item.id}/details${query ? '?' + query : ''}`;
  const details = await fetchJson(url);
  // The detail overlay may have been closed (or reopened for a different
  // item) while this request was in flight — don't paint stale data over
  // whatever's showing now.
  if (!state.currentDetailItem || state.currentDetailItem.id !== item.id) return;
  if (!details || details.error) return;

  if (details.genres && details.genres.length) {
    for (const genre of details.genres) {
      // A plain <span>, not a button — these are informational tags, not
      // a control, so they take no click and (being neither a button nor
      // carrying a tabindex) are naturally invisible to the D-pad's
      // spatial-nav SPATIAL_NAV_SELECTOR too.
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = genre.name;
      movieDetailGenresEl.appendChild(tag);
    }
  }

  const crewBits = [];
  if (details.director) crewBits.push(`Director: ${details.director}`);
  if (details.writers && details.writers.length) crewBits.push(`Writers: ${details.writers.join(', ')}`);
  movieDetailCrewEl.textContent = crewBits.join('   •   ');

  if (details.progress && details.progress.duration_seconds && !details.progress.completed) {
    const pct = Math.min(100, (details.progress.position_seconds / details.progress.duration_seconds) * 100);
    if (pct > 2) {
      movieDetailProgressWrapEl.classList.remove('hidden');
      movieDetailProgressFillEl.style.width = `${pct}%`;
      movieDetailPlayBtn.textContent = '▶ Resume';
      // Re-wire Play now that we know the saved position — the base `item`
      // passed into openMovieDetail doesn't carry playback progress (that's
      // only joined in on the Continue Watching endpoint), so without this
      // "Resume" would restart from the beginning instead of seeking.
      const resumeItem = { ...item, position_seconds: details.progress.position_seconds };
      movieDetailPlayBtn.onclick = () => { hideMovieDetailInternal(); openPlayer(resumeItem); };
      movieDetailRestartBtn.classList.remove('hidden');
      movieDetailRemoveProgressBtn.classList.remove('hidden');
      movieDetailMenuBtn.classList.remove('hidden');
    }
  }
  if (details.progress && details.progress.completed) {
    setWatchedButtonState(true);
  }

  if (details.inWatchlist) {
    movieDetailWatchlistBtn.classList.add('active');
    movieDetailWatchlistBtn.setAttribute('aria-pressed', 'true');
    movieDetailWatchlistBtn.title = 'Remove from Watchlist';
  }

  if (details.trailerKey) {
    movieDetailTrailerBtn.classList.remove('hidden');
    movieDetailTrailerBtn.onclick = () => openTrailer(details.trailerKey);
  }

  if (details.cast && details.cast.length) {
    for (const person of details.cast) movieDetailCastTrackEl.appendChild(castCard(person));
    movieDetailCastShelfEl.classList.remove('hidden');
  }

  if (details.similar && details.similar.length) {
    for (const similarItem of details.similar) movieDetailSimilarTrackEl.appendChild(posterCard(similarItem));
    movieDetailSimilarShelfEl.classList.remove('hidden');
  }
}

function hideMovieDetailInternal() {
  movieDetailEl.classList.add('hidden');
  movieDetailBackBtn.classList.add('hidden');
  document.body.classList.remove('detail-open');
  state.currentDetailItem = null;
}

function closeMovieDetail() {
  exitOverlay(hideMovieDetailInternal);
}

movieDetailBackBtn.addEventListener('click', closeMovieDetail);

// --- Movie detail: "..." menu (Mark as Watched, Edit Match, etc.) --------

// Moved to a direct child of <body> so it renders with position: fixed,
// unclipped by .movie-detail-hero's overflow: hidden (needed to keep the
// backdrop image from bleeding out) — a dropdown nested inside that hero
// was getting its bottom edge cut off whenever the header grew tall (long
// overview, wrapped genre tags on a narrow phone). Its position is
// computed fresh from the "..." button's on-screen location every time it
// opens, in positionDetailMenu() below.
document.body.appendChild(movieDetailMenuEl);

function positionDetailMenu() {
  const rect = movieDetailMenuBtn.getBoundingClientRect();
  const menuWidth = movieDetailMenuEl.offsetWidth || 190;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
  const top = Math.min(rect.bottom + 8, window.innerHeight - 8);
  movieDetailMenuEl.style.left = `${left}px`;
  movieDetailMenuEl.style.top = `${top}px`;
}

movieDetailMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = movieDetailMenuEl.classList.contains('hidden');
  if (willOpen) positionDetailMenu();
  movieDetailMenuEl.classList.toggle('hidden', !willOpen);
  movieDetailMenuBtn.setAttribute('aria-expanded', String(willOpen));
});

function closeMovieDetailMenu() {
  movieDetailMenuEl.classList.add('hidden');
  movieDetailMenuBtn.setAttribute('aria-expanded', 'false');
}

// The menu is fixed-position (viewport-relative) but the button it hangs
// off scrolls with the page (.movie-detail-overlay is the scroll
// container) — close it on scroll rather than let it visually detach from
// the button, and re-close on resize/rotate for the same reason.
movieDetailEl.addEventListener('scroll', closeMovieDetailMenu);
window.addEventListener('resize', closeMovieDetailMenu);

// --- File location info (so you can tell which actual file a title is) ----
function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// Fills `el` with the item's full file path plus a one-line summary of the
// file itself (resolution, codec, size, length).
function renderFileInfo(el, item) {
  el.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'file-info-label';
  label.textContent = 'File';
  const pathEl = document.createElement('div');
  pathEl.className = 'file-info-path';
  pathEl.textContent = item.file_path || 'Unknown';
  el.appendChild(label);
  el.appendChild(pathEl);
  const bits = [item.resolution, item.codec, formatFileSize(item.file_size), formatRuntime(item.duration_sec)].filter(Boolean);
  if (bits.length) {
    const meta = document.createElement('div');
    meta.className = 'file-info-meta';
    meta.textContent = bits.join(' · ');
    el.appendChild(meta);
  }
}

// TV show: the folder the episodes share, then every episode file under it.
function renderShowFiles(show) {
  const panel = showDetailFilesPanel;
  panel.innerHTML = '';
  const eps = [];
  for (const season of show.seasons || []) {
    for (const ep of season.episodes || []) {
      if (ep.file_path) eps.push({ season, ep });
    }
  }
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
  let common = eps.length ? dirOf(eps[0].ep.file_path).split('/') : [];
  for (const { ep } of eps) {
    const parts = dirOf(ep.file_path).split('/');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  const commonDir = common.join('/');

  const head = document.createElement('div');
  head.className = 'file-info';
  const label = document.createElement('div');
  label.className = 'file-info-label';
  label.textContent = 'Location';
  const pathEl = document.createElement('div');
  pathEl.className = 'file-info-path';
  pathEl.textContent = commonDir || (eps.length ? '/' : 'No episode files indexed');
  head.appendChild(label);
  head.appendChild(pathEl);
  panel.appendChild(head);

  for (const { season, ep } of eps) {
    const row = document.createElement('div');
    row.className = 'file-list-row';
    const tag = document.createElement('span');
    tag.textContent = `S${season.season_number}E${ep.episode_number}`;
    row.appendChild(tag);
    row.appendChild(document.createTextNode(commonDir ? ep.file_path.slice(commonDir.length + 1) : ep.file_path));
    panel.appendChild(row);
  }
}

showDetailFilesBtn.addEventListener('click', () => {
  const willShow = showDetailFilesPanel.classList.contains('hidden');
  if (willShow && state.currentShowDetail) renderShowFiles(state.currentShowDetail);
  showDetailFilesPanel.classList.toggle('hidden', !willShow);
  showDetailFilesBtn.setAttribute('aria-expanded', String(willShow));
});

// --- Movie detail: "Edit Match" (fix an incorrect TMDB match in place) ---

movieDetailEditMatchBtn.addEventListener('click', () => {
  closeMovieDetailMenu();
  const willShow = movieDetailEditMatchPanel.classList.contains('hidden');
  movieDetailEditMatchPanel.classList.toggle('hidden', !willShow);
  if (willShow) movieDetailEditMatchTitleEl.focus();
});

movieDetailEditMatchCancelBtn.addEventListener('click', () => {
  movieDetailEditMatchPanel.classList.add('hidden');
});

movieDetailEditMatchSubmitBtn.addEventListener('click', async () => {
  const item = state.currentDetailItem;
  if (!item) return;
  const title = movieDetailEditMatchTitleEl.value.trim();
  if (!title) return;

  movieDetailEditMatchSubmitBtn.disabled = true;
  movieDetailEditMatchStatusEl.className = 'unmatched-status';
  movieDetailEditMatchStatusEl.textContent = 'Searching TMDB...';
  try {
    const res = await fetch(`/api/library/${item.id}/rematch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, media_type: movieDetailEditMatchTypeEl.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      movieDetailEditMatchStatusEl.textContent = data.error || 'No match found — try adjusting the title.';
      movieDetailEditMatchStatusEl.className = 'unmatched-status err';
      return;
    }
    movieDetailEditMatchStatusEl.textContent = `Matched: ${data.tmdb_matched_title || data.title}${data.release_year ? ' (' + data.release_year + ')' : ''}`;
    movieDetailEditMatchStatusEl.className = 'unmatched-status ok';

    // Refresh the item in state.items (so the poster grid/shelves pick up
    // the new title/poster too), then reopen the detail page against the
    // updated item with a forced cache refresh — the corrected match may
    // have a different (or the same, but now-fixable) tmdb_id, and either
    // way the old cached cast/similar shouldn't stick around.
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx !== -1) state.items[idx] = data;
    setTimeout(() => openMovieDetail(data, { forceRefresh: true }), 700);
  } catch (err) {
    movieDetailEditMatchStatusEl.textContent = 'Request failed: ' + err.message;
    movieDetailEditMatchStatusEl.className = 'unmatched-status err';
  } finally {
    movieDetailEditMatchSubmitBtn.disabled = false;
  }
});

function render() {
  const showGenrePills = (state.tab === 'movies' || state.tab === 'tv') && state.genres.length > 0;
  genreFilterBtn.classList.toggle('hidden', !showGenrePills);
  // The dropdown itself should never stay open across a tab switch/search —
  // only the toggle button's visibility tracks showGenrePills.
  if (!showGenrePills) closeGenreFilter();

  if (state.tab === 'home' && !state.query) {
    renderHome();
  } else if (state.tab === 'tv') {
    renderTvGrid();
  } else {
    renderGrid();
  }
}

async function loadLibrary() {
  const profileId = state.profile ? state.profile.id : '';
  const url = profileId ? `/api/library?profile_id=${profileId}` : '/api/library';
  const [items, genres, settings] = await Promise.all([
    fetch(url).then((r) => r.json()),
    fetchJson('/api/genres'),
    fetchJson('/api/settings'),
  ]);
  state.items = items;
  state.genres = genres;
  state.seerrConfigured = Boolean(settings && settings.seerrConfigured);
  genreFilterId = null;
  genreFilterIds = null;
  renderGenrePills(genres);
  render();
}

// --- Playback ------------------------------------------------------------

// The real, full duration of what's playing — NOT videoEl.duration.
//
// The HLS playlist ffmpeg writes is still growing while it transcodes
// (`-hls_list_size 0`, no `#EXT-X-ENDLIST` until the whole file is done),
// so hls.js has no way to know the true end yet and reports `duration` as
// however much has been transcoded and appended to the playlist so far —
// it only catches up to the real length once encoding finishes, which for
// a long title can be well after playback has already started. Anything
// that cares about "how far through the title am I really" (remaining-
// time, the Up Next trigger, the completed-percentage sent to the server)
// needs the actual source duration instead, which is already known from
// the scan (media_items.duration_sec, carried on the item passed into
// openPlayer) rather than derived from playback state. Falls back to
// videoEl.duration only if that wasn't provided for some reason.
function getKnownDuration() {
  const known = state.currentItem && state.currentItem.duration_sec;
  return known && known > 0 ? known : (videoEl.duration || 0);
}

function reportProgress() {
  const duration = getKnownDuration();
  if (!state.currentItem || !state.profile || !duration) return;
  fetch(`/api/profiles/${state.profile.id}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_id: state.currentItem.id,
      position_seconds: videoEl.currentTime,
      duration_seconds: duration,
    }),
  }).catch(() => {});
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Picks a track index matching the saved preferred-language setting (Task
// 2's Control Center audio preference), falling back to no explicit
// selection (ffmpeg/the file's own default) when nothing matches.
function pickPreferredAudioIndex(audioTracks) {
  const pref = localStorage.getItem(AUDIO_PREF_KEY);
  if (!pref || !audioTracks || audioTracks.length === 0) return undefined;
  const match = audioTracks.find((t) => (t.language || '').toLowerCase() === pref.toLowerCase());
  return match ? match.index : undefined;
}

function populateAudioTrackSelect(audioTracks, currentIndex) {
  playerAudioSelectEl.innerHTML = '';
  if (!audioTracks || audioTracks.length <= 1) {
    playerAudioSelectEl.classList.add('hidden');
    return;
  }
  playerAudioSelectEl.classList.remove('hidden');
  for (const track of audioTracks) {
    const opt = document.createElement('option');
    opt.value = String(track.index);
    const langLabel = track.language ? track.language.toUpperCase() : `Track ${track.index + 1}`;
    const chLabel = track.channels ? ` (${track.channels}ch)` : '';
    opt.textContent = `${langLabel}${chLabel}`;
    if (currentIndex !== undefined ? track.index === currentIndex : false) opt.selected = true;
    playerAudioSelectEl.appendChild(opt);
  }
}

// --- Player loading / buffering / error overlay -------------------------
// Covers the video element any time it has nothing to show: stream
// startup, a mid-playback buffering stall (the 'waiting' event), or a
// failed start. Without this the WebView/browser's own bare default (a
// plain gray box with a native play icon) showed through instead, which
// is what looked broken/unstyled — see .player-loading in style.css.

function showPlayerLoading(text) {
  playerLoadingEl.classList.remove('player-loading--error');
  playerLoadingActionsEl.classList.add('hidden');
  playerLoadingTextEl.textContent = text;
  playerLoadingEl.classList.remove('hidden');
}

function hidePlayerLoading() {
  playerLoadingEl.classList.add('hidden');
}

function showPlayerError(message) {
  playerLoadingEl.classList.add('player-loading--error');
  playerLoadingTextEl.textContent = message;
  playerLoadingActionsEl.classList.remove('hidden');
  playerLoadingEl.classList.remove('hidden');
}

playerLoadingCloseBtn.addEventListener('click', () => closePlayer());
playerLoadingRetryBtn.addEventListener('click', () => {
  if (state.currentItem) openPlayer(state.currentItem);
});

// While actually playing, a stall (network hiccup, seek, the transcode
// briefly falling behind real-time) fires 'waiting' — show the same
// overlay in its normal (non-error) loading state until 'playing' fires
// again. Attached once, globally, rather than per-play like the
// startStreamAndAttach() listeners below, since these apply to every
// stream the player ever loads for the life of the page.
videoEl.addEventListener('waiting', () => showPlayerLoading('Buffering…'));
videoEl.addEventListener('playing', () => hidePlayerLoading());

// Starts (or restarts, for an audio-track switch) playback of `item`.
// Shared by openPlayer() and switchAudioTrack() so both go through the
// same stream-request/hls-attach/subtitle-wiring/resume-seek logic.
async function startStreamAndAttach(item, { audioTrackIndex, resumeTime, autoplay = true } = {}) {
  showPlayerLoading('Starting stream…');
  let knownAudioTracks = item.audio_tracks_parsed;
  if (!knownAudioTracks && item.audio_tracks) {
    try { knownAudioTracks = JSON.parse(item.audio_tracks); } catch (err) { knownAudioTracks = null; }
  }
  const effectiveIndex = audioTrackIndex !== undefined ? audioTrackIndex : pickPreferredAudioIndex(knownAudioTracks);
  const query = effectiveIndex !== undefined ? `?audio_track=${effectiveIndex}` : '';
  const res = await fetch(`/api/stream/${item.id}${query}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  if (!data.playlistUrl) throw new Error('No playlist URL returned');

  item.audio_tracks_parsed = data.audioTracks || item.audio_tracks_parsed;

  if (hls) {
    hls.destroy();
    hls = null;
  }

  const url = data.playlistUrl;
  if (window.Hls && Hls.isSupported()) {
    // Without the error handler wired below, a fatal hls.js failure (a
    // segment/track it can't parse or append — multichannel 5.1 audio
    // muxed into fMP4 is a known trigger in some browsers — a bad
    // manifest, a network drop) fired silently: nothing ever calls
    // hidePlayerLoading(), because that only happens via the video's
    // native 'playing' event, which never comes. The result was an
    // infinite "Starting stream…" spinner with no error and no way out
    // but closing the player.
    //
    // MEDIA_ERROR gets two recovery tiers, not one, because hls.js's own
    // recoverMediaError() only handles milder SourceBuffer append errors
    // by swapping audio/video codecs — confirmed in practice to NOT fix a
    // "mediaSourceRequiresReset" failure, which means the browser's
    // MediaSource itself needs tearing down and recreating from scratch,
    // not just a soft in-place recovery. So: soft recovery first
    // (recoverMediaError(), hls.js's documented pattern), and only if that
    // fails again, a hard reset — destroy the whole hls.js instance and
    // MediaSource and build a fresh one at the same playback position
    // (createHlsInstance() below does both the first attach and this).
    // Only if *that* also fails fatally do we give up and show an error.
    let mediaErrorRecoverAttempted = false;
    let mediaErrorHardResetAttempted = false;

    function createHlsInstance(startPosition) {
      hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.ERROR, (event, errData) => {
        console.error('[hls.js]', errData.type, errData.details, errData);
        if (!errData.fatal) return;
        switch (errData.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            showPlayerLoading('Network hiccup, retrying…');
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (!mediaErrorRecoverAttempted) {
              mediaErrorRecoverAttempted = true;
              showPlayerLoading('Recovering playback…');
              hls.recoverMediaError();
            } else if (!mediaErrorHardResetAttempted) {
              mediaErrorHardResetAttempted = true;
              showPlayerLoading('Resetting player…');
              const resumeAt = videoEl.currentTime || startPosition || 0;
              hls.destroy();
              createHlsInstance(resumeAt);
            } else {
              showPlayerError(
                `Playback failed (${errData.details || 'media error'}). This can happen with some ` +
                'multichannel audio tracks — try Audio in the player controls to pick a different track.'
              );
            }
            break;
          default:
            showPlayerError(`Playback failed (${errData.details || errData.type}).`);
            break;
        }
      });
      if (startPosition) {
        videoEl.addEventListener('loadedmetadata', () => {
          videoEl.currentTime = startPosition;
          videoEl.play().catch(() => {});
        }, { once: true });
      }
    }

    createHlsInstance();
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url;
  } else {
    alert('This browser cannot play HLS streams.');
    return data;
  }

  // Safety net independent of hls.js's own error reporting: if nothing
  // gets the video actually playing within 20s of requesting the stream
  // (a stall hls.js never classifies as fatal, a browser that mishandles
  // the track without raising an error at all, etc.), stop showing an
  // indefinite spinner and tell the person instead of leaving them staring
  // at "Starting stream…" forever.
  const startupToken = Symbol('startup');
  currentStartupToken = startupToken;
  setTimeout(() => {
    if (currentStartupToken !== startupToken) return; // superseded by a later/retried play
    if (videoEl.readyState < 3 /* HAVE_FUTURE_DATA */ && !playerLoadingEl.classList.contains('player-loading--error')) {
      showPlayerError('Stream is taking too long to start. This can happen with certain audio formats.');
    }
  }, 20000);

  if (data.subtitleUrl) {
    videoSubtitleTrackEl.src = data.subtitleUrl;
    playerSubtitleBtn.classList.remove('hidden');
  } else {
    videoSubtitleTrackEl.removeAttribute('src');
    playerSubtitleBtn.classList.add('hidden');
  }

  populateAudioTrackSelect(data.audioTracks, effectiveIndex);

  videoEl.addEventListener('loadedmetadata', () => {
    if (resumeTime && resumeTime > 0) videoEl.currentTime = resumeTime;
    if (autoplay) videoEl.play().catch(() => {});
  }, { once: true });

  return data;
}

async function switchAudioTrack(index) {
  if (!state.currentItem) return;
  const resumeTime = videoEl.currentTime || 0;
  try {
    await startStreamAndAttach(state.currentItem, { audioTrackIndex: index, resumeTime, autoplay: true });
  } catch (err) {
    console.error('Failed to switch audio track', err);
  }
}

async function openPlayer(item) {
  // Android TV app only: hand playback off to the app's native
  // (ExoPlayer-backed) player instead of this browser's HLS/hls.js
  // pipeline, so multichannel (5.1+) audio reaches the TV/AVR intact
  // instead of being downmixed to stereo for browser compatibility (see
  // streamer.js's audioChannels(2) comment — that downmix is what every
  // *browser* playback still gets, since browsers can't reliably handle
  // multichannel audio via MSE regardless of what we send them; a native
  // player has no such limitation). `window.VyznNativePlayer` is a
  // JavaScript interface the TV app's MainActivity registers on its
  // WebView (see vyzn-tv's NativePlayerBridge.kt) — it's simply undefined
  // everywhere else (desktop/mobile browsers), so this is a no-op there
  // and the rest of this function runs as before.
  // With sign-in on, the native player needs the app build that forwards the
  // login cookie (it reports that via supportsAuth()). Older builds would
  // just get 401s ("ERROR_CODE_IO_BAD_HTTP_STATUS"), so they fall back to the
  // in-page player below until the app is updated.
  const nativeOk = window.VyznNativePlayer && typeof window.VyznNativePlayer.play === 'function'
    && (!(window.VyznAuth && window.VyznAuth.authRequired()) || typeof window.VyznNativePlayer.supportsAuth === 'function');
  if (nativeOk) {
    window.VyznNativePlayer.play(JSON.stringify({
      itemId: item.id,
      title: item.tmdb_matched_title || item.title,
      resumeSeconds: item.position_seconds || 0,
      durationSeconds: item.duration_sec || 0,
      profileId: state.profile ? state.profile.id : null,
      authToken: (window.VyznAuth && window.VyznAuth.getToken()) || '',
    }));
    return;
  }

  // Must happen synchronously, before the first `await` below — this is
  // still executing inside whatever click event called openPlayer(), and
  // that's the only window browsers honor a fullscreen request in. Doing
  // it any later (e.g. after startStreamAndAttach resolves) gets silently
  // refused as not being a "real" user gesture anymore.
  enterPlayerFullscreen();

  // getSpatialNavRoot() scopes D-pad navigation to the genre-filter dropdown
  // whenever it's open, ahead of the player — it doesn't get auto-closed by
  // anything else on the way into playback, so leaving it open here would
  // silently strand every arrow press on a hidden-behind-the-player
  // dropdown instead of the actual on-screen player controls.
  if (!genrePillsEl.classList.contains('hidden')) closeGenreFilter();

  state.currentItem = item;
  playerTitleEl.textContent = item.tmdb_matched_title || item.title;
  playerOverviewEl.textContent = item.overview || '';
  playerEl.classList.remove('hidden');
  enterOverlay();

  // Reset per-session control state for the new title.
  subtitleUserEnabled = false;
  instantReplayMark = null;
  playerReplayBtn.classList.remove('active');
  playerPlayPauseBtn.textContent = '⏸';
  playerSeekEl.value = 0;
  playerCurrentTimeEl.textContent = '0:00';
  playerRemainingTimeEl.textContent = '-0:00';
  showPlayerControls(); // visible briefly on open, then auto-hides like normal

  // Reset post-playback state for the new title — otherwise a countdown
  // or recommendations grid left over from whatever was playing before
  // could still be sitting there (or, worse, still counting down) on top
  // of the new video.
  hideUpNext();
  hideRecommendations();
  playerPhase = PlayerPhase.PLAYING;
  postPlaybackTriggered = false;
  pendingNextEpisode = null;

  try {
    await startStreamAndAttach(item, { resumeTime: item.position_seconds || 0, autoplay: true });
    clearInterval(progressTimer);
    progressTimer = setInterval(reportProgress, 15000);
  } catch (err) {
    console.error(err);
    // A blocking native alert() over a still-open (but blank) player was
    // the previous behavior — jarring, and inconsistent with the rest of
    // the app's design. This reuses the same loading overlay in its error
    // state: the message plus Try Again (re-runs openPlayer with the same
    // item) / Close (closePlayer()), both wired once, globally, above.
    showPlayerError(err.message || 'Failed to start stream.');
  }
}

// Called from the Android TV app's native code (MainActivity.kt's
// onResume(), after its native PlayerActivity finishes and control returns
// to this WebView) via webView.evaluateJavascript(). The browser player's
// equivalent cleanup (hidePlayerInternal, below) never ran for this play,
// since openPlayer() handed off to the native player and returned early —
// but the native side already reported progress straight to the server
// over HTTP, so the *data* is current; this just refreshes whatever's on
// screen (namely Continue Watching) so the UI reflects it too. Harmless
// no-op everywhere else, since nothing calls it outside the TV app.
window.vyznNativePlaybackEnded = function vyznNativePlaybackEnded() {
  if (state.tab === 'home') renderHome();
};

function hidePlayerInternal() {
  if (playerEl.classList.contains('hidden')) return; // already closed — avoid double reportProgress etc.
  reportProgress();
  clearInterval(progressTimer);
  clearTimeout(controlsHideTimer);
  hideUpNext();
  hideRecommendations();
  playerPhase = PlayerPhase.PLAYING;
  postPlaybackTriggered = false;
  pendingNextEpisode = null;
  playerControlsEl.classList.remove('force-visible');
  videoWrapEl.classList.remove('cursor-hidden');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  playerEl.classList.add('hidden');
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoSubtitleTrackEl.removeAttribute('src');
  videoEl.load();
  if (hls) {
    hls.destroy();
    hls = null;
  }
  currentStartupToken = null; // invalidate any pending 20s startup-timeout check
  state.currentItem = null;
  subtitleUserEnabled = false;
  instantReplayMark = null;
  playerReplayBtn.classList.remove('active');
  playerAudioSelectEl.classList.add('hidden');
  if (state.tab === 'home') renderHome();
}

function closePlayer() {
  exitOverlay(hidePlayerInternal);
}

closePlayerBtn.addEventListener('click', closePlayer);
playerEl.addEventListener('click', (e) => {
  if (e.target === playerEl) closePlayer();
});

// --- Custom player controls (minimalist scrubber bar) ---------------------

// Tapping/clicking the video itself: if the controls are already hidden,
// the tap's only job is to bring them back — it does NOT also toggle
// playback, which is what makes "wake the controls" feel safe to do
// instead of risking an accidental pause. Once they're visible, tapping
// the video again behaves as a normal play/pause toggle, same as before.
videoEl.addEventListener('click', () => {
  if (!playerControlsEl.classList.contains('force-visible')) {
    showPlayerControls();
    return;
  }
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
  showPlayerControls();
});

// Controls stay up the entire time playback is paused (nothing to protect
// the view of, and they'd otherwise be maddening to find again), and the
// auto-hide countdown only starts once playback actually resumes.
videoEl.addEventListener('play', () => { playerPlayPauseBtn.textContent = '⏸'; scheduleHideControls(); });
videoEl.addEventListener('pause', () => { playerPlayPauseBtn.textContent = '▶'; showPlayerControls(); });

playerPlayPauseBtn.addEventListener('click', () => {
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
});

// Any interaction anywhere in/around the video — mouse movement, a tap, a
// button click, dragging the seek/volume sliders, tabbing a control into
// focus — counts as activity and resets the hide countdown.
videoWrapEl.addEventListener('mousemove', showPlayerControls);
playerControlsEl.addEventListener('mousemove', showPlayerControls);
playerControlsEl.addEventListener('click', showPlayerControls);
playerControlsEl.addEventListener('input', showPlayerControls);
playerControlsEl.addEventListener('focusin', showPlayerControls);

// --- Post-playback: "Up Next" auto-play + end-of-playback recommendations -
// Asks the backend what should happen next for whatever's currently
// playing (GET /api/playback/:mediaId/next — see server.js) and shows
// whichever of the two screens applies. Both are dismissable and neither
// blocks normal playback controls from working underneath them (the video
// keeps playing through the "Up Next" countdown, same as every major
// streaming app).
async function triggerPostPlayback() {
  if (postPlaybackTriggered || !state.currentItem) return;
  postPlaybackTriggered = true;

  const profileId = state.profile ? state.profile.id : '';
  const url = profileId
    ? `/api/playback/${state.currentItem.id}/next?profile_id=${profileId}`
    : `/api/playback/${state.currentItem.id}/next`;

  let result;
  try {
    result = await fetchJson(url);
  } catch (err) {
    console.error(err);
    return; // nothing to show — let the title just finish normally
  }

  if (result.type === 'episode' && result.episode) {
    showUpNext(result.episode);
  } else if (result.type === 'recommendations' && result.items && result.items.length) {
    showRecommendations(result.items);
  }
  // Anything else (a movie with no matches, TMDB not configured, an empty
  // library) — no overlay, playback just ends on its own. A dead-end
  // "here's nothing" screen isn't worth showing.
}

function showUpNext(episode) {
  playerPhase = PlayerPhase.COUNTDOWN;
  pendingNextEpisode = episode;

  const epLabel = `S${episode.season_number}:E${episode.episode_number}`;
  upNextTitleEl.textContent = episode.title ? `${epLabel} — ${episode.title}` : epLabel;
  if (episode.still_url) {
    upNextThumbEl.src = episode.still_url;
    upNextThumbEl.style.display = '';
  } else {
    upNextThumbEl.removeAttribute('src');
    upNextThumbEl.style.display = 'none';
  }
  upNextOverlayEl.classList.remove('hidden');
  startUpNextCountdown();
}

function startUpNextCountdown() {
  upNextCountdownRemaining = UP_NEXT_COUNTDOWN_SECONDS;
  renderUpNextCountdown();
  clearInterval(upNextCountdownTimer);
  upNextCountdownTimer = setInterval(() => {
    upNextCountdownRemaining -= 1;
    renderUpNextCountdown();
    if (upNextCountdownRemaining <= 0) {
      clearInterval(upNextCountdownTimer);
      playNextEpisodeNow();
    }
  }, 1000);
}

function renderUpNextCountdown() {
  upNextCountdownEl.textContent = `Playing in ${Math.max(0, upNextCountdownRemaining)}s`;
}

function hideUpNext() {
  clearInterval(upNextCountdownTimer);
  upNextCountdownTimer = null;
  upNextOverlayEl.classList.add('hidden');
}

function playNextEpisodeNow() {
  const episode = pendingNextEpisode;
  hideUpNext();
  if (!episode) return;
  // openPlayer() does its own full reset (including this state machine),
  // so nothing further to clear here — it just becomes the new "current"
  // playback session, same as opening any other episode.
  openPlayer({
    id: episode.media_id,
    title: episode.title,
    tmdb_matched_title: episode.title,
    overview: episode.overview,
    position_seconds: 0,
    // /api/playback/:mediaId/next names this field duration_seconds, not
    // duration_sec like the media_items column it's copied from and like
    // every other episode-shaped object in this file — this was silently
    // reading undefined (getKnownDuration() fell back to videoEl.duration
    // for every "Up Next"-triggered episode instead of the real duration).
    duration_sec: episode.duration_seconds,
    audio_tracks: episode.audio_tracks,
  });
}

upNextPlayBtn.addEventListener('click', playNextEpisodeNow);
upNextCancelBtn.addEventListener('click', () => {
  hideUpNext();
  playerPhase = PlayerPhase.PLAYING; // let the title just finish on its own
});

function showRecommendations(items) {
  playerPhase = PlayerPhase.RECOMMENDATIONS;
  recsHeadingEl.textContent = "What's next?";
  recsGridEl.innerHTML = '';
  for (const item of items.slice(0, 5)) {
    recsGridEl.appendChild(item.kind === 'show' ? showCard(item) : posterCard(item));
  }
  recsOverlayEl.classList.remove('hidden');
}

function hideRecommendations() {
  recsOverlayEl.classList.add('hidden');
  recsGridEl.innerHTML = '';
}

recsCloseBtn.addEventListener('click', closePlayer);

// A recommendation card is the same posterCard()/showCard() component
// used everywhere else, whose own click handler opens a detail page or
// starts playback directly — neither of which first tears down whatever
// is already playing here. Closing this player before that handler runs
// (capture phase, so this fires first) avoids a leaked HLS session and a
// second title's audio briefly overlapping the first's. The "..." menu
// toggle itself is exempted so opening it doesn't kill the player out
// from under someone who hasn't actually chosen an action yet.
recsGridEl.addEventListener('click', (e) => {
  if (e.target.closest('.card-menu-btn')) return;
  hidePlayerInternal();
}, { capture: true });

videoEl.addEventListener('loadedmetadata', () => {
  playerSeekEl.max = String(videoEl.duration || 0);
});

videoEl.addEventListener('timeupdate', () => {
  // The seek bar's max is deliberately left at videoEl.duration (not
  // getKnownDuration()) — that's the actual seekable range right now
  // (what's been transcoded and appended to the HLS playlist so far), and
  // letting it grow to the real total duration would let a scrub target
  // land past the last segment that actually exists yet. It converges to
  // the real duration on its own once ffmpeg reaches #EXT-X-ENDLIST.
  if (!isSeeking && videoEl.duration) {
    playerSeekEl.max = String(videoEl.duration);
    playerSeekEl.value = String(videoEl.currentTime);
  }
  playerCurrentTimeEl.textContent = formatTime(videoEl.currentTime);
  const knownDuration = getKnownDuration();
  if (knownDuration) {
    playerRemainingTimeEl.textContent = '-' + formatTime(knownDuration - videoEl.currentTime);
  }

  // Instant Replay: once playback catches back up to the pre-rewind mark,
  // turn subtitles back off (unless the user had already enabled them
  // themselves) and clear the active state.
  if (instantReplayMark !== null && videoEl.currentTime >= instantReplayMark) {
    if (!subtitleUserEnabled) {
      const track = videoEl.textTracks && videoEl.textTracks[0];
      if (track) track.mode = 'hidden';
    }
    instantReplayMark = null;
    playerReplayBtn.classList.remove('active');
  }

  // Post-playback: fire once, in the last few seconds of the title, so
  // "Up Next" has time to count down before the video actually ends
  // (rather than waiting for the `ended` event, which would mean jumping
  // straight to a full recommendations takeover with no warning).
  if (
    !postPlaybackTriggered &&
    playerPhase === PlayerPhase.PLAYING &&
    knownDuration &&
    knownDuration - videoEl.currentTime <= UP_NEXT_TRIGGER_SECONDS
  ) {
    triggerPostPlayback();
  }
});

// Fallback for when `timeupdate`'s trailing-seconds window is missed
// entirely — a seek straight into the last second, a duration that wasn't
// known until playback nearly caught up to it, etc. `postPlaybackTriggered`
// keeps this from double-firing after the timeupdate path already has.
videoEl.addEventListener('ended', () => {
  if (!postPlaybackTriggered) triggerPostPlayback();
});

playerSeekEl.addEventListener('input', () => {
  isSeeking = true;
  playerCurrentTimeEl.textContent = formatTime(Number(playerSeekEl.value));
});
playerSeekEl.addEventListener('change', () => {
  videoEl.currentTime = Number(playerSeekEl.value);
  isSeeking = false;
});

playerFullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    enterPlayerFullscreen();
  }
});

// Keeps the ⛶ button's title accurate no matter how fullscreen was
// entered/exited — the auto-fullscreen on open, this button, or the
// browser's own Esc-to-exit/Android-back-to-exit all land here.
document.addEventListener('fullscreenchange', () => {
  const isFullscreen = Boolean(document.fullscreenElement) && videoWrapEl.contains(document.fullscreenElement);
  playerFullscreenBtn.title = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
});

playerAudioSelectEl.addEventListener('change', () => {
  switchAudioTrack(Number(playerAudioSelectEl.value));
});

playerSubtitleBtn.addEventListener('click', () => {
  const track = videoEl.textTracks && videoEl.textTracks[0];
  if (!track) return;
  const showing = track.mode === 'showing';
  track.mode = showing ? 'hidden' : 'showing';
  subtitleUserEnabled = !showing;
  playerSubtitleBtn.classList.toggle('player-subtitle-active', !showing);
});

// "What Did They Say?" — rewind 15s and auto-show captions for that
// stretch, reverting once playback catches back up to where it was before
// the rewind (handled in the timeupdate listener above), unless the user
// had already turned captions on manually, in which case we leave them be.
playerReplayBtn.addEventListener('click', () => {
  const track = videoEl.textTracks && videoEl.textTracks[0];
  const mark = videoEl.currentTime;
  videoEl.currentTime = Math.max(0, videoEl.currentTime - 15);
  if (track && !subtitleUserEnabled) {
    track.mode = 'showing';
    instantReplayMark = mark;
    playerReplayBtn.classList.add('active');
  }
});

// --- Control Center (slide-out glass panel) -------------------------------

function ccProfileRow(profile) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'cc-profile-row' + (state.profile && state.profile.id === profile.id ? ' active' : '');
  row.innerHTML = `<span class="cc-profile-avatar${hasAvatarImg(profile) ? ' has-img' : ''}">${avatarInner(profile)}</span><span>${profile.name}${profile.is_child ? ' 🧒' : ''}</span>`;
  row.addEventListener('click', () => switchProfileInstant(profile));
  return row;
}

async function renderCcProfiles() {
  const profiles = await fetchProfiles();
  ccProfileListEl.innerHTML = '';
  for (const p of profiles) ccProfileListEl.appendChild(ccProfileRow(p));
}

// Instant profile switch: updates state/localStorage and reloads the
// library data in place (no page reload, no bounce through the profile
// gate) so Continue Watching / rating limits update immediately.
async function switchProfileInstant(profile) {
  state.profile = profile;
  localStorage.setItem(PROFILE_KEY, String(profile.id));
  activeProfileNameEl.textContent = profile.name;
  await renderCcProfiles();
  await loadLibrary();
}

function openControlCenter() {
  controlCenterScrimEl.classList.remove('hidden');
  controlCenterEl.classList.remove('hidden');
  ccSystemInfoPanelEl.classList.add('hidden');
  ccScanInfoEl.textContent = '';
  renderCcProfiles();
  enterOverlay();
}

function hideControlCenterInternal() {
  controlCenterScrimEl.classList.add('hidden');
  controlCenterEl.classList.add('hidden');
}

function closeControlCenter() {
  exitOverlay(hideControlCenterInternal);
}

closeControlCenterBtn.addEventListener('click', closeControlCenter);
controlCenterScrimEl.addEventListener('click', closeControlCenter);

ccRescanBtn.addEventListener('click', async () => {
  ccRescanBtn.disabled = true;
  ccScanInfoEl.textContent = 'Starting scan...';
  connectScanProgress();
  await fetch('/api/scan', { method: 'POST' });
  ccScanInfoEl.textContent = 'Scan started — watch the logo, or open Settings for progress.';
  ccRescanBtn.disabled = false;
});

// Settings used to have its own hamburger-menu entry (settingsTabBtn) —
// now it's a Control Center quick action instead. Same same-tick-transition
// trick the old button used: hide Control Center directly rather than via
// history.back(), so Settings' own history push replaces this entry
// instead of stacking a second one on top of it.
ccSettingsBtn.addEventListener('click', () => {
  hideControlCenterInternal();
  openSettings();
});

ccSystemInfoBtn.addEventListener('click', async () => {
  const willShow = ccSystemInfoPanelEl.classList.contains('hidden');
  ccSystemInfoPanelEl.classList.toggle('hidden', !willShow);
  if (!willShow) return;
  const info = await fetchJson('/api/settings');
  if (!info || !info.counts) {
    ccSystemInfoEl.innerHTML = '<dt>Error</dt><dd>Could not load server info.</dd>';
    return;
  }
  const rows = [
    ['Version', info.version],
    ['TMDB configured', info.tmdbConfigured ? 'Yes' : 'No'],
    ['Seerr configured', info.seerrConfigured ? 'Yes' : 'No'],
    ['Hardware transcoding', info.hwTranscode ? 'Enabled (VAAPI)' : 'Disabled (CPU)'],
    ['Movies indexed', info.counts.movieCount],
    ['TV episodes indexed', info.counts.episodeCount],
    ['TV shows indexed', info.counts.showCount],
  ];
  ccSystemInfoEl.innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
});

// --- App switcher (active transcode sessions, tvOS-multitasking-style) ---

function appSwitcherTile(job) {
  const tile = document.createElement('div');
  tile.className = 'app-switcher-tile';
  if (job.posterUrl) tile.style.backgroundImage = `url(${job.posterUrl})`;

  const scrim = document.createElement('div');
  scrim.className = 'app-switcher-tile-scrim';
  const title = document.createElement('p');
  title.className = 'app-switcher-tile-title';
  title.textContent = job.title;
  scrim.appendChild(title);
  tile.appendChild(scrim);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'app-switcher-tile-close';
  closeBtn.setAttribute('aria-label', 'Stop stream');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await stopActiveStream(job);
    tile.remove();
    if (appSwitcherTrackEl.children.length === 0) renderAppSwitcherEmpty();
  });
  tile.appendChild(closeBtn);

  // Touch "swipe up to close" gesture, mirroring the close-icon action.
  let touchStartY = null;
  tile.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  tile.addEventListener('touchend', async (e) => {
    if (touchStartY === null) return;
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    touchStartY = null;
    if (deltaY < -60) {
      await stopActiveStream(job);
      tile.remove();
      if (appSwitcherTrackEl.children.length === 0) renderAppSwitcherEmpty();
    }
  });

  return tile;
}

async function stopActiveStream(job) {
  try {
    await fetch(`/api/streams/${job.itemId}/stop?audio_track=${encodeURIComponent(job.audioTrackKey || 'default')}`, {
      method: 'POST',
    });
  } catch (err) {
    console.error('Failed to stop stream', err);
  }
}

function renderAppSwitcherEmpty() {
  appSwitcherTrackEl.innerHTML = '<p class="app-switcher-empty">No active streams right now.</p>';
}

async function openAppSwitcher() {
  appSwitcherOverlayEl.classList.remove('hidden');
  enterOverlay();
  appSwitcherTrackEl.innerHTML = loadingMarkup('', { size: 'sm', compact: true });
  const jobs = await fetchJson('/api/streams/active');
  if (!jobs || jobs.length === 0) {
    renderAppSwitcherEmpty();
    return;
  }
  appSwitcherTrackEl.innerHTML = '';
  for (const job of jobs) appSwitcherTrackEl.appendChild(appSwitcherTile(job));
}

function hideAppSwitcherInternal() {
  appSwitcherOverlayEl.classList.add('hidden');
}

function closeAppSwitcher() {
  exitOverlay(hideAppSwitcherInternal);
}

appSwitcherBtn.addEventListener('click', openAppSwitcher);
closeAppSwitcherBtn.addEventListener('click', closeAppSwitcher);
appSwitcherOverlayEl.addEventListener('click', (e) => {
  if (e.target === appSwitcherOverlayEl) closeAppSwitcher();
});

// Keyboard shortcuts: "C" toggles Control Center, Escape closes whichever
// overlay is open. Guarded against firing while typing in a text field.
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';

  if (e.key === 'Escape') {
    if (!trailerModalEl.classList.contains('hidden')) closeTrailer();
    else if (!appSwitcherOverlayEl.classList.contains('hidden')) closeAppSwitcher();
    else if (!controlCenterEl.classList.contains('hidden')) closeControlCenter();
    else if (!playerEl.classList.contains('hidden')) closePlayer();
    else if (!movieDetailEl.classList.contains('hidden')) closeMovieDetail();
    else if (!showDetailEl.classList.contains('hidden')) closeShowDetail();
    else if (!settingsOverlayEl.classList.contains('hidden')) closeSettings();
    return;
  }

  if (!isTyping && (e.key === 'c' || e.key === 'C')) {
    if (controlCenterEl.classList.contains('hidden')) openControlCenter();
    else closeControlCenter();
  }
});

// --- Tabs / search / scan --------------------------------------------------

document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    resetGenreFilter();
    render();
  });
});

// --- Search: collapsed to a magnifier, opens on click / OK -----------------
const searchWrapEl = document.getElementById('searchWrap');
const searchBtnEl = document.getElementById('searchBtn');
function openSearch() {
  searchWrapEl.classList.add('open');
  searchBtnEl.setAttribute('aria-expanded', 'true');
  searchEl.focus();
}
function closeSearch() {
  searchWrapEl.classList.remove('open');
  searchBtnEl.setAttribute('aria-expanded', 'false');
}
function clearSearch() {
  if (!searchEl.value && !state.query) return;
  searchEl.value = '';
  state.query = '';
  render();
}
searchBtnEl.addEventListener('click', () => {
  if (searchWrapEl.classList.contains('open') && !searchEl.value) closeSearch();
  else openSearch();
});
// Collapse again once focus leaves an empty field (a typed query keeps it open).
searchEl.addEventListener('blur', (e) => {
  if (!searchEl.value && e.relatedTarget !== searchBtnEl) closeSearch();
});
// The global D-pad handler ignores arrows while typing, so give the field its
// own way out: Up/Down always leave it, Left/Right only at the text's edges.
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
    closeSearch();
    searchBtnEl.focus();
  } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    focusInDirection('down');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusInDirection('up');
  } else if (e.key === 'ArrowLeft' && searchEl.selectionStart === 0 && searchEl.selectionEnd === 0) {
    e.preventDefault();
    focusInDirection('left');
  } else if (e.key === 'ArrowRight' && searchEl.selectionStart === searchEl.value.length) {
    e.preventDefault();
    focusInDirection('right');
  }
});

let searchDebounce;
searchEl.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.query = searchEl.value.trim();
    render();
  }, 150);
});

// Fallback for browsers without EventSource (unlikely, but cheap to keep):
// polls /api/scan/status the old way instead of streaming live progress.
async function pollScanStatus() {
  const res = await fetch('/api/scan/status');
  const data = await res.json();
  if (data.status === 'running') {
    ccScanInfoEl.textContent = 'Scanning...';
    setTimeout(pollScanStatus, 2000);
  } else {
    ccRescanBtn.disabled = false;
    ccScanInfoEl.textContent = data.finished_at
      ? `Last scan: ${data.files_added ?? data.filesAdded ?? 0} items`
      : '';
    loadLibrary();
  }
}

let scanEventSource = null;

// No more bar across the top of every page — a scan in progress is shown
// by swapping the topbar logo to its pulsing variant (visible everywhere,
// unobtrusive) plus the actual percent/stage text inside Settings > Library
// (settingsScanProgressWrap), where it's only in the way of someone who
// already went looking for it.
function showScanProgress(percent, text) {
  topbarLogoEl.src = TOPBAR_LOGO_SCANNING_SRC;
  settingsScanProgressWrapEl.classList.remove('hidden');
  settingsScanProgressFillEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  settingsScanProgressTextEl.textContent = text;
}

function hideScanProgress() {
  topbarLogoEl.src = TOPBAR_LOGO_IDLE_SRC;
  settingsScanProgressWrapEl.classList.add('hidden');
  settingsScanProgressFillEl.style.width = '0%';
}

function stageLabel(stage) {
  if (stage === 'walking') return 'Scanning folders';
  if (stage === 'probing') return 'Reading file info';
  if (stage === 'matching') return 'Matching TMDB metadata';
  return stage;
}

function connectScanProgress() {
  if (!window.EventSource) {
    pollScanStatus();
    return;
  }
  if (scanEventSource) scanEventSource.close();

  scanEventSource = new EventSource('/api/scan/progress');
  scanEventSource.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch (err) {
      return;
    }

    if (event.stage === 'idle') {
      hideScanProgress();
      return;
    }

    if (event.stage === 'walking') {
      ccRescanBtn.disabled = true;
      showScanProgress(2, event.message || 'Scanning folders...');
      return;
    }

    if (event.stage === 'probing' || event.stage === 'matching') {
      ccRescanBtn.disabled = true;
      const label = `${stageLabel(event.stage)} (${event.current}/${event.total})${event.filename ? ' — ' + event.filename : ''}`;
      showScanProgress(event.percent ?? 0, label);
      return;
    }

    if (event.stage === 'complete') {
      showScanProgress(100, `Scan complete — ${event.filesAdded ?? 0} items indexed`);
      ccRescanBtn.disabled = false;
      ccScanInfoEl.textContent = `Last scan: ${event.filesAdded ?? 0} items`;
      loadLibrary();
      if (!settingsOverlayEl.classList.contains('hidden')) {
        loadSettingsSystemInfo();
        loadUnmatchedList();
      }
      setTimeout(hideScanProgress, 2500);
      scanEventSource.close();
      scanEventSource = null;
      return;
    }

    if (event.stage === 'error') {
      showScanProgress(0, `Scan failed: ${event.message || 'unknown error'}`);
      ccRescanBtn.disabled = false;
      setTimeout(hideScanProgress, 4000);
      scanEventSource.close();
      scanEventSource = null;
      return;
    }

    if (event.stage === 'running') {
      ccRescanBtn.disabled = true;
      showScanProgress(0, 'Scan already in progress...');
    }
  };
  scanEventSource.onerror = () => {
    // Connection dropped (e.g. server restarted mid-scan) — fall back to
    // polling so the UI doesn't get stuck disabled forever.
    if (scanEventSource) {
      scanEventSource.close();
      scanEventSource = null;
    }
    pollScanStatus();
  };
}

// --- Settings --------------------------------------------------------

const RATING_OPTIONS = ['', 'G', 'PG', 'PG-13', 'R', 'NC-17'];

async function loadSettingsSystemInfo() {
  const info = await fetchJson('/api/settings');
  if (!info || !info.counts) {
    settingsSystemInfoEl.innerHTML = '<dt>Error</dt><dd>Could not load server info.</dd>';
    return;
  }
  const rows = [
    ['Version', info.version],
    ['TMDB configured', info.tmdbConfigured ? 'Yes' : 'No — set TMDB_API_KEY or TMDB_AUTH_TOKEN'],
    ['Seerr configured', info.seerrConfigured ? 'Yes' : 'No — set SEERR_URL and SEERR_API_KEY to enable "Add to Library" on recommendations and search'],
    ['Hardware transcoding', info.hwTranscode ? 'Enabled (VAAPI)' : 'Disabled (CPU/libx264)'],
    ['Media folder', info.mediaDir],
    ['Scanned top-level folders', info.scanOnlyDirs || '(all)'],
    ['Movies indexed', info.counts.movieCount],
    ['TV episodes indexed', info.counts.episodeCount],
    ['TV shows indexed', info.counts.showCount],
    ['Unmatched items', info.counts.unmatchedCount],
    ['Profiles', info.counts.profileCount],
  ];
  if (info.lastScan && info.lastScan.status) {
    const finished = info.lastScan.finished_at ? new Date(info.lastScan.finished_at + 'Z').toLocaleString() : '—';
    rows.push(['Last scan', `${info.lastScan.status} · ${info.lastScan.files_added ?? 0} items · ${finished}`]);
  }
  settingsSystemInfoEl.innerHTML = rows
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('');
}

// Builds the Connections form fresh from whatever src/config.js reports —
// so adding a new editable setting server-side (e.g. a future one) only
// needs a SCHEMA entry there, not a matching hand-written field here.
// Secret fields render as password inputs pre-filled with the server's
// mask placeholder when a value is already set; leaving one untouched on
// save tells the server "don't change this" (see PUT /api/settings/config).
async function loadConfigForm() {
  const config = await fetchJson('/api/settings/config');
  if (!config) {
    configFormEl.innerHTML = '<p class="settings-hint">Could not load connection settings.</p>';
    return;
  }
  configFormEl.innerHTML = '';
  for (const [key, field] of Object.entries(config)) {
    const wrapper = document.createElement('label');
    wrapper.className = 'config-field';
    const sourceNote = field.source === 'env' ? ' (from docker-compose.yml)' : '';
    wrapper.innerHTML = `
      <span class="config-field-label">${field.label}${sourceNote}</span>
      ${field.type === 'bool'
        ? `<input type="checkbox" data-config-key="${key}" ${field.value === 'true' || field.hasValue ? 'checked' : ''} />`
        : `<input type="${field.secret ? 'password' : 'text'}" data-config-key="${key}" value="${field.value ? field.value.replace(/"/g, '&quot;') : ''}" placeholder="${field.hint || ''}" autocomplete="off" />`
      }
      <span class="config-field-hint">${field.hint || ''}</span>
    `;
    configFormEl.appendChild(wrapper);
  }
}

configFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  configFormEl.querySelectorAll('[data-config-key]').forEach((input) => {
    const key = input.dataset.configKey;
    body[key] = input.type === 'checkbox' ? String(input.checked) : input.value.trim();
  });
  configSaveStatusEl.textContent = 'Saving…';
  try {
    const res = await fetch('/api/settings/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    configSaveStatusEl.textContent = 'Saved — takes effect immediately, no restart needed.';
    await loadConfigForm();
    loadSettingsSystemInfo();
  } catch (err) {
    configSaveStatusEl.textContent = `Save failed: ${err.message}`;
  }
});

function renderTailscaleStatus(status) {
  if (!status || !status.installed) {
    tailscaleStatusEl.textContent = 'Tailscale is not installed in this container image.';
    tailscaleConnectBtn.disabled = true;
    tailscaleDisconnectBtn.classList.add('hidden');
    return;
  }
  if (status.connected) {
    const ip = status.self && status.self.tailscaleIPs && status.self.tailscaleIPs[0];
    tailscaleStatusEl.textContent = ip
      ? `Connected — reachable at ${ip}${status.self.dnsName ? ` (${status.self.dnsName})` : ''}`
      : 'Connected.';
    tailscaleDisconnectBtn.classList.remove('hidden');
  } else {
    tailscaleStatusEl.textContent = status.error
      ? `Not connected (${status.error})`
      : 'Not connected — paste an auth key below and hit Connect.';
    tailscaleDisconnectBtn.classList.add('hidden');
  }
  tailscaleConnectBtn.disabled = false;
}

async function loadTailscaleStatus() {
  const status = await fetchJson('/api/tailscale/status');
  renderTailscaleStatus(status);
}

tailscaleConnectBtn.addEventListener('click', async () => {
  const authKey = tailscaleAuthKeyInputEl.value.trim();
  if (!authKey) {
    tailscaleStatusEl.textContent = 'Paste an auth key first.';
    return;
  }
  tailscaleConnectBtn.disabled = true;
  tailscaleStatusEl.textContent = 'Connecting…';
  try {
    const res = await fetch('/api/tailscale/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Connect failed');
    tailscaleAuthKeyInputEl.value = '';
    renderTailscaleStatus(data);
  } catch (err) {
    tailscaleStatusEl.textContent = `Connect failed: ${err.message}`;
    tailscaleConnectBtn.disabled = false;
  }
});

tailscaleDisconnectBtn.addEventListener('click', async () => {
  tailscaleDisconnectBtn.disabled = true;
  try {
    const res = await fetch('/api/tailscale/disconnect', { method: 'POST' });
    const data = await res.json();
    renderTailscaleStatus(data);
  } catch (err) {
    tailscaleStatusEl.textContent = `Disconnect failed: ${err.message}`;
  } finally {
    tailscaleDisconnectBtn.disabled = false;
  }
});

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true;
  checkUpdateStatusEl.textContent = 'Checking…';
  try {
    const data = await fetchJson('/api/version');
    if (!data) throw new Error('No response');
    if (data.error) {
      checkUpdateStatusEl.textContent = `Could not check: ${data.error}`;
    } else if (data.updateAvailable) {
      checkUpdateStatusEl.innerHTML = `Update available: v${data.current} → v${data.latest}. Run <code>docker compose pull &amp;&amp; docker compose up -d</code> on the server to install it${data.releaseUrl ? ` (<a href="${data.releaseUrl}" target="_blank" rel="noopener">release notes</a>)` : ''}.`;
    } else {
      checkUpdateStatusEl.textContent = `You're up to date (v${data.current}).`;
    }
  } catch (err) {
    checkUpdateStatusEl.textContent = `Could not check: ${err.message}`;
  } finally {
    checkUpdateBtn.disabled = false;
  }
});

function settingsProfileRow(profile) {
  const row = document.createElement('div');
  row.className = 'settings-profile-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = profile.name;

  const childLabel = document.createElement('label');
  childLabel.className = 'child-check';
  const childCheck = document.createElement('input');
  childCheck.type = 'checkbox';
  childCheck.checked = Boolean(profile.is_child);
  childLabel.appendChild(childCheck);
  childLabel.append(' Kids');

  const ratingSelect = document.createElement('select');
  for (const r of RATING_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r || 'No limit';
    if ((profile.max_content_rating || '') === r) opt.selected = true;
    ratingSelect.appendChild(opt);
  }

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-secondary';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await fetch(`/api/profiles/${profile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nameInput.value.trim() || profile.name,
          is_child: childCheck.checked,
          max_content_rating: ratingSelect.value || null,
        }),
      });
      saveBtn.textContent = 'Saved';
      setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 1200);
      // If this is the active profile, refresh its cached name/rating.
      if (state.profile && state.profile.id === profile.id) {
        state.profile.name = nameInput.value.trim() || profile.name;
        state.profile.is_child = childCheck.checked;
        state.profile.max_content_rating = ratingSelect.value || null;
        activeProfileNameEl.textContent = state.profile.name;
      }
    } catch (err) {
      saveBtn.textContent = 'Failed';
      saveBtn.disabled = false;
    }
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete profile "${profile.name}"? This also removes its watch history.`)) return;
    deleteBtn.disabled = true;
    await fetch(`/api/profiles/${profile.id}`, { method: 'DELETE' });
    row.remove();
    if (state.profile && state.profile.id === profile.id) {
      // Deleted the profile currently in use — bounce back to the picker.
      localStorage.removeItem(PROFILE_KEY);
      state.profile = null;
      closeSettings();
      appEl.classList.add('hidden');
      initProfiles();
    }
  });

  row.appendChild(nameInput);
  row.appendChild(childLabel);
  row.appendChild(ratingSelect);
  row.appendChild(spacer);
  row.appendChild(saveBtn);
  row.appendChild(deleteBtn);
  return row;
}

async function loadSettingsProfiles() {
  const profiles = await fetchProfiles();
  settingsProfileListEl.innerHTML = '';
  for (const p of profiles) settingsProfileListEl.appendChild(settingsProfileRow(p));
}

// --- Unmatched items -------------------------------------------------

function unmatchedRow(item) {
  const row = document.createElement('div');
  row.className = 'unmatched-row';

  const filename = document.createElement('p');
  filename.className = 'unmatched-filename';
  filename.textContent = item.file_path;
  filename.title = item.file_path;

  const controls = document.createElement('div');
  controls.className = 'unmatched-controls';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = item.title;

  const typeSelect = document.createElement('select');
  for (const [value, label] of [['movie', 'Movie'], ['tv', 'TV Show']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if ((item.media_type || 'movie') === value) opt.selected = true;
    typeSelect.appendChild(opt);
  }

  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn-secondary';
  retryBtn.textContent = 'Rematch';

  const purgeItemBtn = document.createElement('button');
  purgeItemBtn.className = 'btn-danger';
  purgeItemBtn.textContent = 'Remove';
  purgeItemBtn.title = 'Remove this item from the library (does not touch the file on disk)';

  const status = document.createElement('p');
  status.className = 'unmatched-status';

  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    status.textContent = 'Searching TMDB...';
    status.className = 'unmatched-status';
    try {
      const res = await fetch(`/api/library/${item.id}/rematch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titleInput.value.trim(), media_type: typeSelect.value }),
      });
      const data = await res.json();
      if (res.ok) {
        status.textContent = `Matched: ${data.tmdb_matched_title || data.title}${data.release_year ? ' (' + data.release_year + ')' : ''}`;
        status.classList.add('ok');
        setTimeout(() => { row.remove(); updateUnmatchedCount(-1); }, 900);
      } else {
        status.textContent = data.error || 'No match found — try adjusting the title.';
        status.classList.add('err');
      }
    } catch (err) {
      status.textContent = 'Request failed: ' + err.message;
      status.classList.add('err');
    } finally {
      retryBtn.disabled = false;
    }
  });

  purgeItemBtn.addEventListener('click', async () => {
    if (!confirm(`Remove "${item.title}" from the library? The file on disk is not touched.`)) return;
    purgeItemBtn.disabled = true;
    await fetch('/api/library/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path_contains: item.file_path }),
    });
    row.remove();
    updateUnmatchedCount(-1);
  });

  controls.appendChild(titleInput);
  controls.appendChild(typeSelect);
  controls.appendChild(retryBtn);
  controls.appendChild(purgeItemBtn);

  row.appendChild(filename);
  row.appendChild(controls);
  row.appendChild(status);
  return row;
}

// Keeps both badges in sync: the one on Settings' "View Unmatched" button
// and the one in the Unmatched page's own heading.
function setUnmatchedCount(n) {
  unmatchedCountEl.textContent = String(n);
  unmatchedOverlayCountEl.textContent = String(n);
}

function updateUnmatchedCount(delta) {
  const current = parseInt(unmatchedCountEl.textContent || '0', 10) || 0;
  setUnmatchedCount(Math.max(0, current + delta));
}

async function loadUnmatchedList() {
  unmatchedListEl.innerHTML = loadingMarkup('', { size: 'sm', compact: true });
  const items = await fetchJson('/api/library/unmatched');
  setUnmatchedCount(items.length);
  if (items.length === 0) {
    unmatchedListEl.innerHTML = '<p class="settings-hint">Everything is matched.</p>';
    return;
  }
  unmatchedListEl.innerHTML = '';
  for (const item of items) unmatchedListEl.appendChild(unmatchedRow(item));
}

settingsAddProfileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = settingsNewProfileNameEl.value.trim();
  if (!name) return;
  await createProfile(name, settingsNewProfileChildEl.checked);
  settingsNewProfileNameEl.value = '';
  settingsNewProfileChildEl.checked = false;
  loadSettingsProfiles();
});

settingsScanBtn.addEventListener('click', async () => {
  settingsScanInfoEl.textContent = 'Starting scan...';
  ccRescanBtn.disabled = true;
  connectScanProgress();
  await fetch('/api/scan', { method: 'POST' });
  settingsScanInfoEl.textContent = 'Scan started — see progress below.';
});

settingsRetryBtn.addEventListener('click', async () => {
  settingsRetryBtn.disabled = true;
  settingsScanInfoEl.textContent = 'Retrying unmatched items...';
  connectScanProgress();
  try {
    const res = await fetch('/api/library/retry-unmatched', { method: 'POST' });
    const data = await res.json();
    settingsScanInfoEl.textContent = data.candidates !== undefined
      ? `Retrying ${data.candidates} unmatched item(s) — see progress below.`
      : (data.error || 'Started.');
  } finally {
    settingsRetryBtn.disabled = false;
  }
});

settingsBackfillGenresBtn.addEventListener('click', async () => {
  settingsBackfillGenresBtn.disabled = true;
  settingsScanInfoEl.textContent = 'Backfilling genres for already-matched items...';
  connectScanProgress();
  try {
    const res = await fetch('/api/library/backfill-genres', { method: 'POST' });
    const data = await res.json();
    settingsScanInfoEl.textContent = data.candidates !== undefined
      ? `Backfilling genres for ${data.candidates} item(s) — see progress below.`
      : (data.error || 'Started.');
  } finally {
    settingsBackfillGenresBtn.disabled = false;
  }
});

purgeBtn.addEventListener('click', async () => {
  const pathContains = purgeInputEl.value.trim();
  if (!pathContains) return;
  purgeBtn.disabled = true;
  try {
    const res = await fetch('/api/library/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path_contains: pathContains }),
    });
    const data = await res.json();
    settingsScanInfoEl.textContent = data.deleted !== undefined
      ? `Removed ${data.deleted} item(s) matching "${pathContains}".`
      : (data.error || 'Failed.');
    loadLibrary();
    loadSettingsSystemInfo();
    loadUnmatchedList();
  } finally {
    purgeBtn.disabled = false;
  }
});

wipeLibraryBtn.addEventListener('click', async () => {
  if (!confirm('Wipe the ENTIRE library? This clears all indexed metadata (files on disk are untouched). This cannot be undone.')) return;
  wipeLibraryBtn.disabled = true;
  try {
    const res = await fetch('/api/library?confirm=true', { method: 'DELETE' });
    const data = await res.json();
    settingsScanInfoEl.textContent = data.deleted !== undefined
      ? `Wiped ${data.deleted} item(s) from the library.`
      : (data.error || 'Failed.');
    loadLibrary();
    loadSettingsSystemInfo();
    loadUnmatchedList();
  } finally {
    wipeLibraryBtn.disabled = false;
  }
});

function openSettings() {
  settingsOverlayEl.classList.remove('hidden');
  if (window.VyznAuth) window.VyznAuth.refreshAccounts();
  settingsScanInfoEl.textContent = '';
  configSaveStatusEl.textContent = '';
  settingsAudioPrefSelectEl.value = localStorage.getItem(AUDIO_PREF_KEY) || '';
  loadSettingsProfiles();
  loadAdminSettingsData();
  enterOverlay();
}

// Server-level sections (library, unmatched, system info, connections,
// Tailscale, accounts) — they live in the admin dashboard's Server Settings
// tab for admins (see admin.js), or in the Settings overlay while sign-in
// is off. Either way these loaders fill them.
const autoScanModeEl = document.getElementById('autoScanMode');
const autoScanTimeEl = document.getElementById('autoScanTime');
const autoScanTimeWrapEl = document.getElementById('autoScanTimeWrap');
const autoScanStatusEl = document.getElementById('autoScanStatus');
autoScanModeEl.addEventListener('change', () => {
  autoScanTimeWrapEl.classList.toggle('hidden', autoScanModeEl.value !== 'daily');
});
async function loadAutoScan() {
  const r = await fetch('/api/autoscan');
  if (!r.ok) return;
  const s = await r.json();
  autoScanModeEl.value = s.mode;
  autoScanTimeEl.value = s.time;
  autoScanTimeWrapEl.classList.toggle('hidden', s.mode !== 'daily');
  const parts = [];
  if (s.mode === 'daily') parts.push(`Next scan ${new Date(s.nextRun).toLocaleString()} (server clock: ${s.timezone}).`);
  if (s.mode === 'watch') parts.push(s.watching ? 'Watching your library folders for new files.' : `Not watching: ${s.watchError || 'starting…'}`);
  if (s.lastAuto) parts.push(`Last automatic scan ${new Date(s.lastAuto.at).toLocaleString()} (${s.lastAuto.reason})${s.lastAuto.error ? ' — failed: ' + s.lastAuto.error : ''}.`);
  if (s.scanning) parts.push('A scan is running now.');
  autoScanStatusEl.textContent = parts.join(' ') || 'Automatic scanning is off.';
}
document.getElementById('autoScanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  autoScanStatusEl.textContent = 'Saving…';
  const res = await fetch('/api/settings/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ AUTO_SCAN_MODE: autoScanModeEl.value, AUTO_SCAN_TIME: autoScanTimeEl.value || '03:00' }),
  });
  if (!res.ok) { autoScanStatusEl.textContent = 'Could not save.'; return; }
  await loadAutoScan();
});

function loadAdminSettingsData() {
  loadAutoScan();
  settingsScanInfoEl.textContent = '';
  configSaveStatusEl.textContent = '';
  loadSettingsSystemInfo();
  loadUnmatchedList();
  loadConfigForm();
  loadTailscaleStatus();
  if (window.VyznAuth) window.VyznAuth.refreshAccounts();
}
window.loadAdminSettingsData = loadAdminSettingsData;

settingsAudioPrefSelectEl.addEventListener('change', () => {
  localStorage.setItem(AUDIO_PREF_KEY, settingsAudioPrefSelectEl.value);
});

function hideSettingsInternal() {
  settingsOverlayEl.classList.add('hidden');
}

function closeSettings() {
  exitOverlay(hideSettingsInternal);
}

closeSettingsBtn.addEventListener('click', closeSettings);
settingsOverlayEl.addEventListener('click', (e) => {
  if (e.target === settingsOverlayEl) closeSettings();
});

// Unmatched items: its own page over Settings rather than a pushed history
// entry of its own — it shares Settings' entry, so a hardware/browser back
// press exits both at once (same as it already did for Settings alone),
// while the X button here specifically returns to Settings rather than
// exiting all the way out.
function hideUnmatchedInternal() {
  unmatchedOverlayEl.classList.add('hidden');
}

let unmatchedFromAdmin = false;
function openUnmatched() {
  const adminEl = document.getElementById('adminOverlay');
  unmatchedFromAdmin = !!(adminEl && !adminEl.classList.contains('hidden'));
  settingsOverlayEl.classList.add('hidden');
  unmatchedOverlayEl.classList.remove('hidden');
}

function closeUnmatched() {
  hideUnmatchedInternal();
  if (!unmatchedFromAdmin) settingsOverlayEl.classList.remove('hidden');
  unmatchedFromAdmin = false;
  if (window.VyznAuth) window.VyznAuth.refreshAccounts();
}

openUnmatchedBtn.addEventListener('click', openUnmatched);
closeUnmatchedBtn.addEventListener('click', closeUnmatched);
unmatchedOverlayEl.addEventListener('click', (e) => {
  if (e.target === unmatchedOverlayEl) closeUnmatched();
});

// Watch for progress from a scan already running (e.g. triggered from
// another tab, or a scheduled scan) as soon as the page loads.
// Wait for auth (auth.js): the scan EventSource and profile fetch would
// 401 before sign-in once accounts are enabled.
window.VyznAuth.ready.then(() => {
  connectScanProgress();
  initProfiles();
});
