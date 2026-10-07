package com.vyzn.tv

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.graphics.BitmapFactory
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Native (ExoPlayer-backed) playback, used only so multichannel (5.1+)
 * source audio reaches the TV/AVR intact — see MainActivity.kt's
 * VyznNativePlayer bridge for how the web app hands off to this, and
 * server.js's GET /api/raw/:id for the direct/untranscoded file route this
 * plays. Everything that ISN'T video playback — browsing, detail pages,
 * search, settings — is still the same WebView/web-app screen this
 * Activity sits on top of; closing this (Back) returns to it exactly where
 * it was.
 *
 * v1 scope, deliberately: play/pause/seek, resume position, progress
 * reporting, subtitles (on/off via PlayerView's built-in CC button — see
 * fetchSubtitleInfo()/setUpPlayer()), and "Up Next" episode auto-advance
 * (see startPostPlaybackWatcher()/showUpNext() below — mirrors app.js's
 * own Up Next card, hitting the same GET /api/playback/:mediaId/next).
 * Still deferred (going through the browser player today, which is
 * unaffected by any of this): in-player audio track switching, and the
 * end-of-movie "recommendations" grid (Up Next only covers the TV-episode
 * case — see showUpNext()'s comment for why). See android-tv/README.md.
 */
class PlayerActivity : AppCompatActivity() {

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView
    private lateinit var upNextCard: LinearLayout
    private lateinit var upNextThumb: ImageView
    private lateinit var upNextTitle: TextView
    private lateinit var upNextCountdown: TextView
    private lateinit var upNextPlayBtn: Button
    private lateinit var upNextDismissBtn: Button
    private lateinit var progressExecutor: ExecutorService
    private val mainHandler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null
    private var postPlaybackWatcherRunnable: Runnable? = null
    private var countdownRunnable: Runnable? = null

    private var serverBaseUrl: String = ""
    // Session cookie copied from the WebView (VYZN accounts, see src/auth.js).
    // Empty when sign-in is off, in which case no header is sent.
    private var authCookie: String = ""
    private var itemId: Long = -1
    private var profileId: Long = -1
    private var resumeSeconds: Double = 0.0
    private var knownDurationSeconds: Double = 0.0
    private var postPlaybackTriggered: Boolean = false
    private var pendingNextEpisode: NextEpisode? = null
    private var countdownRemaining: Int = 0

    private data class NextEpisode(
        val mediaId: Long,
        val title: String?,
        val overview: String?,
        val episodeNumber: Int,
        val seasonNumber: Int,
        val stillUrl: String?,
        val durationSeconds: Double,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_player)
        hideSystemBars()

        playerView = findViewById(R.id.playerView)
        upNextCard = findViewById(R.id.upNextCard)
        upNextThumb = findViewById(R.id.upNextThumb)
        upNextTitle = findViewById(R.id.upNextTitle)
        upNextCountdown = findViewById(R.id.upNextCountdown)
        upNextPlayBtn = findViewById(R.id.upNextPlayBtn)
        upNextDismissBtn = findViewById(R.id.upNextDismissBtn)
        upNextPlayBtn.setOnClickListener { playNextEpisodeNow() }
        upNextDismissBtn.setOnClickListener { hideUpNext() } // let the title just finish on its own, same as the web player's Cancel
        progressExecutor = Executors.newSingleThreadExecutor()

        serverBaseUrl = intent.getStringExtra(EXTRA_SERVER_BASE_URL) ?: ""
        authCookie = intent.getStringExtra(EXTRA_AUTH_COOKIE) ?: ""
        itemId = intent.getLongExtra(EXTRA_ITEM_ID, -1)
        profileId = intent.getLongExtra(EXTRA_PROFILE_ID, -1)
        resumeSeconds = intent.getDoubleExtra(EXTRA_RESUME_SECONDS, 0.0)
        knownDurationSeconds = intent.getDoubleExtra(EXTRA_DURATION_SECONDS, 0.0)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""

        if (serverBaseUrl.isEmpty() || itemId <= 0) {
            Toast.makeText(this, "Couldn't start playback (missing stream info).", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        title.takeIf { it.isNotBlank() }?.let {
            Toast.makeText(this, it, Toast.LENGTH_SHORT).show()
        }

        // Same couple-seconds-of-grace trade-off the browser player already
        // makes on every /api/stream call (see that route's comment in
        // server.js): worth a short wait so subtitles are there from the
        // first frame, rather than plumbing a mid-playback MediaItem swap
        // for what's usually a sub-second lookup anyway (the .vtt is
        // normally already cached from a previous play of this item).
        progressExecutor.execute {
            val subtitle = fetchSubtitleInfo(serverBaseUrl, itemId)
            mainHandler.post { setUpPlayer(subtitle) }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun setUpPlayer(subtitle: SubtitleInfo?) {
        // setSeekBack/ForwardIncrementMs are plain ExoPlayer.Builder
        // methods (part of the base Player API, not a UI resource
        // attribute), so unlike the PlayerView XML attributes below this
        // isn't resolved by AAPT at build time — matches the web player's
        // own 15s "Instant Replay" jump instead of ExoPlayer's 10s/15s-ish
        // defaults, and is what the stock rewind/fast-forward buttons
        // (shown via PlayerView's default controller) actually invoke.
        val httpFactory = DefaultHttpDataSource.Factory().apply {
            if (authCookie.isNotEmpty()) setDefaultRequestProperties(mapOf("Cookie" to authCookie))
        }
        val exoPlayer = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(httpFactory))
            .setSeekBackIncrementMs(15000)
            .setSeekForwardIncrementMs(15000)
            .build()
        player = exoPlayer
        playerView.player = exoPlayer
        // ExoPlayer/PlayerView's built-in controller is already D-pad
        // navigable out of the box (real Android focus, not the web app's
        // hand-rolled spatial-nav) — no custom controls needed here, same
        // as the CC button (show_subtitle_button in activity_player.xml)
        // that toggles the subtitle track below.
        playerView.controllerShowTimeoutMs = 4000
        // Without this, momentarily pausing (or any state change that
        // resets the player) flashes a blank black frame behind the
        // controls instead of leaving the last video frame showing —
        // jarring compared to the web player, which never blanks the
        // <video> element under its own controls overlay.
        playerView.setKeepContentOnPlayerReset(true)

        val rawUrl = "$serverBaseUrl/api/raw/$itemId"
        val mediaItemBuilder = MediaItem.Builder().setUri(Uri.parse(rawUrl))
        if (subtitle != null) {
            val subtitleConfig = MediaItem.SubtitleConfiguration.Builder(Uri.parse(subtitle.url))
                .setMimeType(MimeTypes.TEXT_VTT)
                .apply { subtitle.language?.let { setLanguage(it) } }
                .build()
            mediaItemBuilder.setSubtitleConfigurations(listOf(subtitleConfig))
        }
        val mediaItem = mediaItemBuilder.build()

        // Off by default, same as the browser player (subtitleUserEnabled
        // starts false there too) — the CC button is what turns it on.
        // Without this, DefaultTrackSelector can auto-select a text track
        // on its own (e.g. one flagged "forced" in the source) the moment
        // it's available, before the person asked for it.
        exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()

        exoPlayer.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "Playback error for item $itemId", error)
                Toast.makeText(
                    this@PlayerActivity,
                    "Playback failed: ${error.errorCodeName}",
                    Toast.LENGTH_LONG
                ).show()
                finish()
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY && knownDurationSeconds <= 0.0) {
                    // Fall back to ExoPlayer's own duration if the web app
                    // didn't already know it (e.g. a freshly-scanned item)
                    // — reportProgressOnce() needs a non-zero duration or
                    // the server rejects the update (see server.js's
                    // POST /api/profiles/:id/progress).
                    val exoDurationMs = exoPlayer.duration
                    if (exoDurationMs > 0) knownDurationSeconds = exoDurationMs / 1000.0
                }
                // Covers the case post-playback never fired anything (a
                // movie — recommendations aren't built natively yet, see
                // the class doc — or the lookup failed/timed out): rather
                // than sit on a frozen last frame forever, same as the web
                // player just tearing its own player down once `ended`
                // fires with nothing to show, return to the WebView.
                if (state == Player.STATE_ENDED && upNextCard.visibility != View.VISIBLE) {
                    finish()
                }
            }
        })

        exoPlayer.setMediaItem(mediaItem, (resumeSeconds * 1000).toLong())
        exoPlayer.prepare()
        exoPlayer.playWhenReady = true

        postPlaybackTriggered = false
        startProgressReporting()
        startPostPlaybackWatcher()
    }

    // --- "Up Next" episode auto-advance -------------------------------------
    // Polls playback position the same way the web player's `timeupdate`
    // handler does (see app.js's UP_NEXT_TRIGGER_SECONDS), since there's no
    // equivalent event to hook here — ExoPlayer has no built-in "N seconds
    // from the end" callback. Once within range, asks the same backend
    // endpoint app.js uses (GET /api/playback/:mediaId/next) what comes
    // next.
    private fun startPostPlaybackWatcher() {
        stopPostPlaybackWatcher()
        val runnable = object : Runnable {
            override fun run() {
                checkForPostPlayback()
                mainHandler.postDelayed(this, POST_PLAYBACK_POLL_MS)
            }
        }
        postPlaybackWatcherRunnable = runnable
        mainHandler.postDelayed(runnable, POST_PLAYBACK_POLL_MS)
    }

    private fun stopPostPlaybackWatcher() {
        postPlaybackWatcherRunnable?.let { mainHandler.removeCallbacks(it) }
        postPlaybackWatcherRunnable = null
    }

    private fun checkForPostPlayback() {
        if (postPlaybackTriggered) return
        val exoPlayer = player ?: return
        val durationMs = if (knownDurationSeconds > 0.0) (knownDurationSeconds * 1000).toLong() else exoPlayer.duration
        if (durationMs <= 0 || durationMs == C.TIME_UNSET) return
        val remainingMs = durationMs - exoPlayer.currentPosition
        if (remainingMs > UP_NEXT_TRIGGER_SECONDS * 1000L) return

        postPlaybackTriggered = true
        val base = serverBaseUrl
        val id = itemId
        val profile = profileId
        progressExecutor.execute {
            val next = fetchNextEpisode(base, id, profile)
            if (next != null) mainHandler.post { showUpNext(next) }
            // No match (a movie, end of series, lookup failure) — nothing
            // shown; the STATE_ENDED handler above covers the title just
            // finishing naturally from here.
        }
    }

    // Only the `type === "episode"` case is handled — the TV-episode
    // auto-advance this was actually asked for. `type === "recommendations"`
    // (a movie finishing, or the end of a series) is what the web player
    // shows a poster grid for; building that natively (fetching posters,
    // opening a detail page, Watchlist/Play from inside PlayerActivity) is
    // a meaningfully bigger native UI than a single advance-to-next-episode
    // card, so it's left going through the "just return to the WebView"
    // path (the STATE_ENDED handler above) rather than half-building it.
    private fun fetchNextEpisode(base: String, mediaId: Long, profile: Long): NextEpisode? {
        var connection: HttpURLConnection? = null
        try {
            val url = if (profile > 0) {
                URL("$base/api/playback/$mediaId/next?profile_id=$profile")
            } else {
                URL("$base/api/playback/$mediaId/next")
            }
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5000
                readTimeout = 5000
                applyAuth(this)
            }
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = BufferedReader(InputStreamReader(connection.inputStream)).use { it.readText() }
            val json = JSONObject(body)
            if (json.optString("type") != "episode") return null
            val ep = json.getJSONObject("episode")
            return NextEpisode(
                mediaId = ep.getLong("media_id"),
                title = if (ep.isNull("title")) null else ep.getString("title"),
                overview = if (ep.isNull("overview")) null else ep.getString("overview"),
                episodeNumber = ep.optInt("episode_number"),
                seasonNumber = ep.optInt("season_number"),
                stillUrl = if (ep.isNull("still_url")) null else ep.getString("still_url"),
                durationSeconds = if (ep.isNull("duration_seconds")) 0.0 else ep.getDouble("duration_seconds"),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Up Next lookup failed for item $mediaId", e)
            return null
        } finally {
            connection?.disconnect()
        }
    }

    private fun showUpNext(episode: NextEpisode) {
        pendingNextEpisode = episode
        val label = "S${episode.seasonNumber}:E${episode.episodeNumber}"
        upNextTitle.text = if (!episode.title.isNullOrBlank()) "$label — ${episode.title}" else label
        upNextThumb.setImageDrawable(null)
        episode.stillUrl?.let { stillUrl ->
            progressExecutor.execute {
                val bitmap = fetchBitmap(stillUrl)
                if (bitmap != null) mainHandler.post {
                    // Still the pending episode? (card may have been
                    // dismissed, or playback torn down, while this was
                    // loading in the background)
                    if (pendingNextEpisode === episode) upNextThumb.setImageBitmap(bitmap)
                }
            }
        }
        upNextCard.visibility = View.VISIBLE
        // Real Android focus (same as the rest of this screen — see
        // PlayerView's own doc comment above) so the D-pad lands somewhere
        // visible the instant the card appears, matching the web player
        // explicitly focusing its own Play/Pause when controls first show.
        upNextPlayBtn.requestFocus()
        startUpNextCountdown()
    }

    private fun startUpNextCountdown() {
        countdownRemaining = UP_NEXT_COUNTDOWN_SECONDS
        renderCountdown()
        countdownRunnable?.let { mainHandler.removeCallbacks(it) }
        val runnable = object : Runnable {
            override fun run() {
                countdownRemaining -= 1
                renderCountdown()
                if (countdownRemaining <= 0) {
                    playNextEpisodeNow()
                } else {
                    mainHandler.postDelayed(this, 1000)
                }
            }
        }
        countdownRunnable = runnable
        mainHandler.postDelayed(runnable, 1000)
    }

    private fun renderCountdown() {
        upNextCountdown.text = "Playing in ${countdownRemaining.coerceAtLeast(0)}s"
    }

    private fun hideUpNext() {
        countdownRunnable?.let { mainHandler.removeCallbacks(it) }
        countdownRunnable = null
        upNextCard.visibility = View.GONE
    }

    private fun playNextEpisodeNow() {
        val episode = pendingNextEpisode ?: return
        hideUpNext()
        pendingNextEpisode = null

        // Final progress update for the title that's ending, same as a
        // normal close (onDestroy()), before itemId moves on to the next
        // one below.
        stopProgressReporting()
        stopPostPlaybackWatcher()
        reportProgressOnce()

        itemId = episode.mediaId
        resumeSeconds = 0.0
        knownDurationSeconds = episode.durationSeconds
        val label = "S${episode.seasonNumber}:E${episode.episodeNumber}"
        Toast.makeText(this, if (!episode.title.isNullOrBlank()) "$label — ${episode.title}" else label, Toast.LENGTH_SHORT).show()

        player?.release()
        player = null

        val base = serverBaseUrl
        val id = itemId
        progressExecutor.execute {
            val subtitle = fetchSubtitleInfo(base, id)
            mainHandler.post { setUpPlayer(subtitle) }
        }
    }

    // Attach the account cookie, but only to requests going to our own
    // server (Up Next thumbnails can come from third-party hosts).
    private fun applyAuth(conn: HttpURLConnection) {
        if (authCookie.isNotEmpty() && conn.url.toString().startsWith(serverBaseUrl)) {
            conn.setRequestProperty("Cookie", authCookie)
        }
    }

    private fun fetchBitmap(url: String): Bitmap? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 5000
                applyAuth(this)
            }
            connection.inputStream.use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            Log.w(TAG, "Up Next thumbnail fetch failed", e)
            null
        } finally {
            connection?.disconnect()
        }
    }

    // Reports playback position to the server on the same ~15s cadence the
    // web player uses (see app.js's reportProgress()/progressTimer), so
    // Continue Watching / resume position stay in sync regardless of which
    // player (native or browser) was actually used.
    private fun startProgressReporting() {
        val runnable = object : Runnable {
            override fun run() {
                reportProgressOnce()
                mainHandler.postDelayed(this, PROGRESS_INTERVAL_MS)
            }
        }
        progressRunnable = runnable
        mainHandler.postDelayed(runnable, PROGRESS_INTERVAL_MS)
    }

    private fun stopProgressReporting() {
        progressRunnable?.let { mainHandler.removeCallbacks(it) }
        progressRunnable = null
    }

    private fun reportProgressOnce() {
        val exoPlayer = player ?: return
        if (profileId <= 0) return // no active profile — nothing to attribute progress to
        val positionSeconds = exoPlayer.currentPosition / 1000.0
        val durationSeconds = if (knownDurationSeconds > 0.0) knownDurationSeconds else exoPlayer.duration / 1000.0
        if (durationSeconds <= 0.0) return // matches server.js's own "!duration" rejection — nothing useful to send yet

        val base = serverBaseUrl
        val id = itemId
        val profile = profileId
        progressExecutor.execute {
            postProgress(base, profile, id, positionSeconds, durationSeconds)
        }
    }

    private fun postProgress(base: String, profile: Long, id: Long, position: Double, duration: Double) {
        var connection: HttpURLConnection? = null
        try {
            val url = URL("$base/api/profiles/$profile/progress")
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                connectTimeout = 5000
                readTimeout = 5000
                applyAuth(this)
            }
            val body = JSONObject().apply {
                put("media_id", id)
                put("position_seconds", position)
                put("duration_seconds", duration)
            }
            OutputStreamWriter(connection.outputStream).use { it.write(body.toString()) }
            connection.responseCode // triggers the request; response body unused
        } catch (e: Exception) {
            // Best-effort, same as the web player's reportProgress() (a
            // plain unawaited fetch()) — a dropped progress update isn't
            // worth surfacing to the person mid-playback.
            Log.w(TAG, "Progress report failed", e)
        } finally {
            connection?.disconnect()
        }
    }

    // See server.js's GET /api/raw/:id/subtitles — triggers the same ffmpeg
    // text-subtitle extraction /api/stream uses for browser playback (and
    // the same up-to-2s grace period: fast when the .vtt is already
    // cached, otherwise returns null rather than holding up playback).
    // Null language/url fields, a network failure, or non-200 response all
    // just mean "play without subtitles" — never worth failing playback
    // over, same as a dropped progress report elsewhere in this class.
    private fun fetchSubtitleInfo(base: String, id: Long): SubtitleInfo? {
        var connection: HttpURLConnection? = null
        try {
            val url = URL("$base/api/raw/$id/subtitles")
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5000
                readTimeout = 5000
                applyAuth(this)
            }
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = BufferedReader(InputStreamReader(connection.inputStream)).use { it.readText() }
            val json = JSONObject(body)
            if (json.isNull("subtitleUrl")) return null
            val subtitleUrl = json.getString("subtitleUrl")
            val language = if (json.isNull("language")) null else json.getString("language")
            return SubtitleInfo(url = "$base$subtitleUrl", language = language)
        } catch (e: Exception) {
            Log.w(TAG, "Subtitle lookup failed for item $id", e)
            return null
        } finally {
            connection?.disconnect()
        }
    }

    private data class SubtitleInfo(val url: String, val language: String?)

    override fun onDestroy() {
        stopProgressReporting()
        stopPostPlaybackWatcher()
        countdownRunnable?.let { mainHandler.removeCallbacks(it) }
        reportProgressOnce() // final update on close, mirroring hidePlayerInternal()'s reportProgress() in app.js
        player?.release()
        player = null
        progressExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "VyznPlayer"
        private const val PROGRESS_INTERVAL_MS = 15000L
        // Matches app.js's UP_NEXT_TRIGGER_SECONDS/UP_NEXT_COUNTDOWN_SECONDS
        // exactly, so the native and browser players feel the same.
        private const val UP_NEXT_TRIGGER_SECONDS = 15
        private const val UP_NEXT_COUNTDOWN_SECONDS = 10
        private const val POST_PLAYBACK_POLL_MS = 1000L

        const val EXTRA_SERVER_BASE_URL = "server_base_url"
        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_PROFILE_ID = "profile_id"
        const val EXTRA_RESUME_SECONDS = "resume_seconds"
        const val EXTRA_DURATION_SECONDS = "duration_seconds"
        const val EXTRA_TITLE = "title"
        const val EXTRA_AUTH_COOKIE = "auth_cookie"
    }
}
