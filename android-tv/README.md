# VYZN TV

An Android TV / Google TV wrapper for your VYZN media server. There is no
separate app UI to maintain — this is a thin native shell around a `WebView`
pointed at your existing VYZN web app, with the wiring a browser tab doesn't
give you for free: fullscreen chrome, HTML5 video fullscreen, a Back button
that closes overlays instead of the whole app, and a launcher entry that
shows up on the Google TV home screen.

The D-pad navigation itself (arrow keys moving focus between cards/buttons)
lives in the web app's own `app.js` (`focusInDirection()`), not in this
project — so it also works if you ever open the same server in a browser
with a keyboard. This project just makes sure the WebView's focus and Back
button feed into that system correctly.

## Status: built, side-loaded, and released (tv-v1, tv-v2)

Earlier revisions of this README said the app had never been built or run
in this environment, since this environment has no Android SDK/emulator —
that's still true of *this* environment, but no longer true of the app
itself: it's since been built in a real Android Studio, side-loaded onto
real TV hardware, and published as two GitHub Releases (`tv-v1`/vyzn1.0,
`tv-v2`/vyzn1.1 — see the main `README.md`'s "Release history" for what
shipped in each). Everything below ("built without an Android device")
still applies to *new* code changes proposed from this environment going
forward — anything just written here is reviewed carefully but genuinely
untested until your next real build — it just no longer describes the app
as a whole.

The three things most likely to need a tweak on a change you haven't
tested yet on a real TV:
1. **D-pad → arrow key mapping.** Whether your remote's D-pad reliably
   generates `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`/`Enter` key
   events inside the WebView. This is standard WebView behavior, but
   remotes vary.
2. **Fullscreen video.** The custom `WebChromeClient` in `MainActivity.kt`
   is the standard fix for HTML5 `<video>` fullscreen in a WebView, but
   it's worth confirming the player's Fullscreen button actually fills the
   TV screen and that Back correctly exits fullscreen rather than closing
   the whole app.
3. **`<select>` dropdowns** (audio/subtitle track pickers, if the web app
   uses native `<select>` elements anywhere) render as Android's native
   picker inside a WebView, which can look and behave a little differently
   with a D-pad than with a mouse.

If any of these misbehave, send me what you see (a screenshot or a
description) and I can adjust the code.

## What's in this project

A standard Android Studio / Gradle project:

```
android-tv/
  app/
    src/main/
      java/com/vyzn/tv/MainActivity.kt        <- WebView shell (browsing, detail pages, everything but video)
      java/com/vyzn/tv/NativePlayerBridge.kt   <- window.VyznNativePlayer, the JS <-> native handoff
      java/com/vyzn/tv/PlayerActivity.kt       <- native (ExoPlayer) playback screen
      res/layout/activity_main.xml             <- WebView + loading/error UI
      res/layout/activity_player.xml           <- PlayerView (native player screen)
      res/values/                              <- strings, colors, theme
      res/drawable/                            <- launcher icon + TV banner (see "Icon / branding" below)
      res/xml/network_security_config.xml      <- allows plain http:// to your LAN server
      AndroidManifest.xml
    build.gradle.kts
  build.gradle.kts
  settings.gradle.kts
  gradle.properties
```

## Building it

1. **Install Android Studio** (any recent version — this targets AGP 8.2.2 /
   Kotlin 1.9.22 / compileSdk 34, which any 2024+ release of Android Studio
   handles out of the box) and JDK 17 (Android Studio bundles its own, so
   you usually don't need to install this separately).
2. **Open the project**: `File > Open`, select the `android-tv` folder
   (this now lives as a subfolder of the main `vyzn` repo, alongside the
   server — `git clone https://github.com/comsoll8/vyzn` and open
   `vyzn/android-tv`, not a standalone `vyzn-tv` checkout).
3. Android Studio will sync Gradle automatically. Note: the Gradle wrapper
   scripts (`gradlew` / `gradlew.bat`) and wrapper JAR aren't included in
   this delivery — I had no network access to fetch the wrapper JAR from
   here. Android Studio regenerates these automatically the first time you
   open the project (it'll prompt you, or just work silently). If you'd
   rather build from the command line, run `gradle wrapper` once from the
   `android-tv` folder using any system-installed Gradle 8.x, which will
   create the missing `gradlew` files for you.
4. **Run it**: pick a target device (see below) from the device dropdown
   and hit the green Run button, or `Build > Build Bundle(s)/APK(s) >
   Build APK(s)` if you just want an installable `.apk` file.

This gives you a **debug** build — fine for side-loading onto your own TV
over adb (see below), but Google Play won't accept it. For that, see
"Signing a release build" next.

## Signing a release build (for Google Play / Internal Testing)

Play Console requires every release to be signed with a real key, and
once you've published a first version under that key, every future
update must be signed with the *same* key forever — Google can't swap it
for you later. So the one thing to actually be careful with here: **back
up the keystore file and its passwords somewhere durable** (a password
manager, not just this disk) the moment you create it. If it's lost,
there's no "update" path for that app listing ever again — only a brand
new one.

1. **Generate the keystore once**, from a terminal with a JDK on your
   `PATH` (Android Studio's own JDK works — on most installs that's
   something like `~/Library/Java/JavaVirtualMachines/...` on macOS, or
   bundled under Android Studio's install directory on Windows/Linux; any
   JDK 17 works just as well):
   ```
   cd android-tv
   keytool -genkeypair -v -keystore release-key.jks -alias vyzn-tv \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   It'll prompt for a keystore password, a key password (can be the same
   value), and some certificate info (name/org/etc. — none of it matters
   much for an app that's never going to Production/public listing, just
   fill in something sensible).
2. **Create `android-tv/keystore.properties`** (already gitignored — this
   file and the `.jks` it points at must never be committed):
   ```
   storeFile=release-key.jks
   storePassword=<the keystore password you set>
   keyAlias=vyzn-tv
   keyPassword=<the key password you set>
   ```
3. That's it — `app/build.gradle.kts` picks this up automatically. From
   here, `Build > Generate Signed Bundle / APK > Android App Bundle`
   produces a signed `.aab` (Play Console wants an **App Bundle**, not a
   plain `.apk`, for a new app) at
   `app/build/outputs/bundle/release/app-release.aab` — that's the file
   you upload to the Internal Testing track in Play Console. Running
   `Build > Build Bundle(s)/APK(s) > Build APK(s)` with the release
   variant selected also produces a signed `app-release.apk`, if you want
   one to side-load directly instead of going through Play Console.

## Installing on a real Google TV / Android TV device

If the device isn't already listed in Android Studio's device dropdown
(common — most TVs aren't plugged in by USB), side-load over the network
with `adb`:

1. On the TV: Settings > System > About > enable "Developer options" (tap
   the build number repeatedly, same as on phones), then Settings >
   Developer options > enable "USB debugging" (this also enables network
   debugging) and note the TV's IP address (Settings > Network).
2. On your computer, with the TV and computer on the same network:
   ```
   adb connect <tv-ip-address>:5555
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```
   (build the APK first via Android Studio's Run button or Build APK(s)
   menu item above — it lands in that `outputs/apk/debug/` path).
3. The app should appear on the Google TV home screen under your apps row
   (it registers a `LEANBACK_LAUNCHER` entry plus a launcher banner, so it
   shows up properly in the TV-style launcher, not just in a generic app
   list).

The same APK also installs fine on a regular Android phone/tablet for
testing (it declares `android.software.leanback` as optional, not
required), which may be the faster way to sanity-check WebView behavior
before testing D-pad specifics on the actual TV.

## Using the app

- **First launch**: you'll be prompted for your VYZN server address — enter
  it as `http://<your-unraid-ip>:<port>` (whatever you use to reach VYZN
  from a browser on the same network, e.g. `http://192.168.1.50:18080`).
  It's saved and reused on every future launch.
- **Changing the server address later**: long-press the remote's Back
  button at any time to reopen that same prompt. There's also a "Change
  Server" button shown automatically if the app fails to load.
- **Back button**: closes whatever's open on screen (movie detail, player,
  settings, the hamburger menu, etc.) one step at a time — same as the
  swipe-back behavior in a browser — and only exits the app once nothing
  is left open.
- **Cleartext HTTP**: the app explicitly allows plain `http://` traffic
  (`network_security_config.xml`), since VYZN is meant to be reached over
  your local network without needing TLS. If you do run it behind an https
  reverse proxy with a self-signed certificate, the app will also accept
  that (SSL errors are not treated as fatal) — remove that if you'd rather
  it fail closed on cert errors.

## Performance: why first launch was slow/clunky, and what changed

If you tested an earlier build of this app and it felt slow with janky
D-pad navigation, that was real — three concrete things caused it, all
fixed now (requires the matching update to the VYZN server's `app.js`/
`style.css`/`index.html`, not just this app):

1. **`backdrop-filter: blur()` everywhere.** The web app's "frosted glass"
   look (topbar, card menus, panels — 37 places) is one of the most
   GPU-expensive things a WebView can render: a full-screen blur pass
   redone on every frame anything under it moves. Desktop/phone browsers
   handle it fine; a TV box's weaker GPU and less-tuned WebView compositor
   often don't. This app now appends `" VyznTV"` to the WebView's user
   agent string (see `configureWebView()` in `MainActivity.kt`); the web
   app detects that marker and turns blur off entirely for this app only
   (desktop/browser use is unaffected) via a `--glass-blur-scale` CSS
   variable.
2. **No visible focus indicator in some WebViews.** The web app relies on
   CSS `:focus-visible` to show a ring around whatever's focused — reliable
   in desktop Chrome/Safari, not guaranteed in every WebView build,
   especially older ones on budget TV boxes. Without it, D-pad navigation
   was silently moving focus with zero visual feedback, which reads as
   broken even when it's technically working. Now unconditional (not
   `:focus-visible`-gated) specifically for this app.
3. **Spatial navigation re-measuring the whole screen on every repeat
   keystroke.** A remote's D-pad auto-repeats fast while held; the web
   app's `focusInDirection()` was re-scanning and re-measuring every
   focusable element on screen on every single one of those repeats. Now
   throttled to one step per ~120ms, and uses an instant scroll snap
   instead of an animated one (which was visibly fighting itself under
   rapid repeats).

If it's still slow after updating both sides, the next thing worth trying
is disabling `LOG_LEVEL=debug`-style verbosity or checking whether the
specific TV box's System WebView is badly out of date (Settings > Apps >
Android System WebView > check for updates via Play Store, if the box has
Play Store access).

## Native playback (ExoPlayer), for real 5.1 surround

Everything in this app except video playback is still the WebView showing
VYZN's normal web frontend — browsing, detail pages, search, settings, all
unchanged. Playback is the one exception, and only in this app: browsers
(and, until now, this app too, since it was just a WebView) can't reliably
carry multichannel audio through to a receiver/soundbar at all — that's a
platform limitation, not something fixable in the web app. See the
server's `README.md` for the full story of how that was confirmed
(`mediaSourceRequiresReset`, an hls.js/MediaSource Extensions failure that
neither a soft nor hard in-browser recovery could work around), and why
every *browser* playback (including this app's old WebView-only behavior)
now gets its audio downmixed to stereo server-side.

**How the handoff works:** `MainActivity.kt` registers a JavaScript
interface, `window.VyznNativePlayer`, on the WebView (`NativePlayerBridge.kt`).
The web app's `openPlayer()` (`app.js`) checks for that global — it's only
ever defined inside this app's WebView, never in a real browser — and when
present, calls `VyznNativePlayer.play(...)` with the item id, title, resume
position, and duration instead of setting up its own HLS/hls.js player.
That call starts `PlayerActivity`, a separate native screen built on
**ExoPlayer** (Android's own media framework, not a browser engine), which
plays the source file directly via a new server endpoint, `GET
/api/raw/:id` — the original file, byte-for-byte, no transcoding, so
whatever audio the source actually has reaches ExoPlayer untouched. Closing
the player (Back) returns to the WebView exactly where it was; playback
progress is reported straight from `PlayerActivity` to the server over
HTTP (same `/api/profiles/:id/progress` endpoint the web player uses), so
Continue Watching / resume position stay correct regardless of which
player was used.

### What this gets you today

ExoPlayer's bundled extractors (no extra setup) decode **AAC audio at any
channel count** — including plain 5.1 AAC, which is exactly the format
that was failing in-browser. For any title whose audio is AAC (5.1, 7.1,
whatever), this fixes the problem outright: real multichannel PCM out,
matching what the receiver/TV actually decodes.

### What this does NOT do yet: AC-3 / E-AC-3 / DTS / TrueHD

ExoPlayer's core library does not include decoders for these licensed
codecs — that's a licensing restriction on Google's side, the same reason
browsers can't decode them either. A title whose audio track is AC-3,
E-AC-3 (Dolby Digital Plus), DTS, or TrueHD will fail to play through
`PlayerActivity` as this stands (ExoPlayer will report a decoder
initialization error and the app will show a Toast and return you to the
WebView — no infinite spinner, at least, but not working either). Two real
paths forward, in increasing order of effort:

1. **Build and bundle ExoPlayer's FFmpeg extension.** This is Google's own
   supported path for exactly this gap — it's not merged into the core
   library only because of licensing, not because it doesn't work. It
   requires the Android NDK and a local build step (cloning
   `androidx/media`, running its `build_ffmpeg.sh`) that can't be done from
   here (no NDK/network access to fetch FFmpeg sources in this
   environment) — this is a "you build it once, following Google's
   documented steps" task, not something I can hand you as a finished
   dependency.
2. **True passthrough (bitstreaming)** — send the compressed AC-3/DTS/etc.
   track straight to the TV/AVR over HDMI without any decoding on the
   Android box at all, if the sink reports it supports that format. This
   is what a dedicated media-player box like an Nvidia Shield does for
   Plex/Jellyfin. It's a further step on top of (1) (still needs option 1
   built first for anything the box has to decode itself, like
   TrueHD-without-passthrough-support) and depends on `AudioManager`
   capability detection that's genuinely easiest to get right by testing
   against your specific TV/AVR combination.

Until one of those lands, an AC-3/DTS/TrueHD title still won't play
through the native player. Practically: check what your library's problem
titles actually use (VYZN's own Movie/Show Detail "Audio" field on
each title tells you) — if it's AAC 5.1, you're already fixed; if it's
AC-3/DTS, it needs (1) above before this feature reaches it.

### What else is deliberately deferred (v1 scope)

- **Subtitles** — not wired into `PlayerActivity` yet. A title with
  subtitles still needs them, they just won't show up when played through
  the native player. Falls back to the WebView player would require
  detecting this case; for now it's a known gap, not a fallback.
- **In-player audio track switching** — the native player plays whatever
  track ExoPlayer selects by default (typically the first/default audio
  stream). The web player's "preferred audio language" setting and the
  Audio button in player controls are both browser-player-only right now.
- **Up Next / recommendations** — closing the native player returns
  straight to the WebView with no auto-advance-to-next-episode prompt.

None of these are hard blockers to add later — they're scoped out of this
first pass specifically so the core problem (5.1 audio actually working)
shipped without also trying to reach full feature parity with the browser
player in the same change. Say the word for any of them.

### Status

Confirmed working on a real build as of `tv-v1`: `PlayerActivity.kt` and
`NativePlayerBridge.kt` compile and play AAC 5.1 audio correctly. One real
build break did surface along the way — `activity_player.xml`'s
`fastforward_increment`/`rewind_increment` attributes don't exist on this
version of `PlayerView` — fixed by moving that behavior to
`ExoPlayer.Builder`'s `setSeekBackIncrementMs()`/`setSeekForwardIncrementMs()`
in `PlayerActivity.kt` instead (see `tv-v2` / the main README's release
notes). This environment still has no Android SDK/NDK/emulator/Maven
access of its own, so any *new* change to these files is written and
reviewed carefully but stays untested until your next real build — same as
everything else in this project. If Gradle sync or compilation turns up
anything, send me the error and I'll fix it directly.

## Icon / branding

`res/drawable/ic_launcher.xml` (the launcher icon) and `tv_banner.xml`
(the Android TV home-screen row banner) now carry the real logo — the
same chevron mark and "VYZN" wordmark used on the web app
(`public/assets/vyzn-mark.svg` and `vyzn-logo.svg`), redrawn
as VectorDrawables rather than imported as PNGs: both source SVGs draw
everything as plain paths (no filters/gradients/text — well, the wordmark
SVG's "v0.2" bit *is* real SVG text, which VectorDrawable can't express,
so that one small accent is dropped from the banner; the chevron mark and
"VYZN" lettering itself are hand-drawn paths in the source SVG already,
so those came across exactly). Being vector, both stay crisp at any
launcher density with no per-dpi PNG exports to keep in sync. `colors.xml`
(`vyzn_bg`/`vyzn_bg_elevated`/`vyzn_accent`) was also brought back in
line with `public/style.css`'s actual current palette — it had drifted to
an old blue accent from an earlier iteration of the web app's theme,
which would have looked wrong next to the new monochrome logo in the
status bar/nav bar/button tinting.

If you ever want to swap either one for something else later, Android
Studio's Image Asset tool (right-click `res` > New > Image Asset) accepts
a PNG/SVG import same as always — nothing else in the project needs to
change to pick it up.

Same no-device-access caveat as everything else in this project applies
to the geometry here too: I can't render an actual VectorDrawable in this
environment, so I checked the math (the group scale/translate values that
fit the source SVGs into each resource's required viewport) by rebuilding
both as plain SVGs with the identical nested-group transforms and
rendering those — SVG and VectorDrawable use the same transform model, so
that's a solid proxy, but it's not the genuine article. Worth a glance
after your first real build, same as everything else here.
