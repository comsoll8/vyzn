package com.vyzn.tv

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONObject
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
 * v1 scope, deliberately: play/pause/seek, resume position, and progress
 * reporting. Deferred (still going through the browser player today, which
 * is unaffected by any of this): subtitles, in-player audio track
 * switching, and Up Next/recommendations chaining. See vyzn-tv/README.md.
 */
class PlayerActivity : AppCompatActivity() {

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView
    private lateinit var progressExecutor: ExecutorService
    private val mainHandler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null

    private var serverBaseUrl: String = ""
    private var itemId: Long = -1
    private var profileId: Long = -1
    private var resumeSeconds: Double = 0.0
    private var knownDurationSeconds: Double = 0.0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_player)
        hideSystemBars()

        playerView = findViewById(R.id.playerView)
        progressExecutor = Executors.newSingleThreadExecutor()

        serverBaseUrl = intent.getStringExtra(EXTRA_SERVER_BASE_URL) ?: ""
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

        setUpPlayer()
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

    private fun setUpPlayer() {
        val exoPlayer = ExoPlayer.Builder(this).build()
        player = exoPlayer
        playerView.player = exoPlayer
        // ExoPlayer/PlayerView's built-in controller is already D-pad
        // navigable out of the box (real Android focus, not the web app's
        // hand-rolled spatial-nav) — no custom controls needed here.
        playerView.controllerShowTimeoutMs = 4000

        val rawUrl = "$serverBaseUrl/api/raw/$itemId"
        val mediaItem = MediaItem.Builder().setUri(Uri.parse(rawUrl)).build()

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
            }
        })

        exoPlayer.setMediaItem(mediaItem, (resumeSeconds * 1000).toLong())
        exoPlayer.prepare()
        exoPlayer.playWhenReady = true

        startProgressReporting()
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

    override fun onDestroy() {
        stopProgressReporting()
        reportProgressOnce() // final update on close, mirroring hidePlayerInternal()'s reportProgress() in app.js
        player?.release()
        player = null
        progressExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "VyznPlayer"
        private const val PROGRESS_INTERVAL_MS = 15000L

        const val EXTRA_SERVER_BASE_URL = "server_base_url"
        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_PROFILE_ID = "profile_id"
        const val EXTRA_RESUME_SECONDS = "resume_seconds"
        const val EXTRA_DURATION_SECONDS = "duration_seconds"
        const val EXTRA_TITLE = "title"
    }
}
