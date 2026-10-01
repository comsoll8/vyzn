package com.vyzn.tv

import android.content.Context
import android.content.Intent
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Registered on MainActivity's WebView as `window.VyznNativePlayer` (see
 * configureWebView()). The web app's openPlayer() (app.js) checks for this
 * global and, when present, hands playback off here instead of using its
 * own browser HLS/hls.js pipeline — see that function's comment for why:
 * in short, so multichannel (5.1+) audio reaches the TV/AVR intact instead
 * of the stereo downmix every *browser* playback still gets.
 *
 * Methods here are called by the WebView on a background thread (WebView's
 * own JS-bridge thread, not the UI thread) — startActivity() is safe to
 * call from there directly, so no thread-hop is needed.
 */
class NativePlayerBridge(private val context: Context, private val serverBaseUrl: () -> String?) {

    @JavascriptInterface
    fun play(payloadJson: String) {
        try {
            val payload = JSONObject(payloadJson)
            val baseUrl = serverBaseUrl()
            if (baseUrl.isNullOrBlank()) {
                Log.e(TAG, "play() called with no known server URL")
                return
            }
            val intent = Intent(context, PlayerActivity::class.java).apply {
                putExtra(PlayerActivity.EXTRA_SERVER_BASE_URL, baseUrl)
                putExtra(PlayerActivity.EXTRA_ITEM_ID, payload.optLong("itemId", -1))
                putExtra(PlayerActivity.EXTRA_PROFILE_ID, payload.optLong("profileId", -1))
                putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, payload.optDouble("resumeSeconds", 0.0))
                putExtra(PlayerActivity.EXTRA_DURATION_SECONDS, payload.optDouble("durationSeconds", 0.0))
                putExtra(PlayerActivity.EXTRA_TITLE, payload.optString("title", ""))
                // context is always MainActivity's own Activity context in
                // practice (see how this bridge is constructed), which
                // doesn't need NEW_TASK — but this bridge takes a plain
                // Context, so guard for the generic case anyway.
                if (context !is android.app.Activity) {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start native playback from bridge payload: $payloadJson", e)
        }
    }

    companion object {
        private const val TAG = "VyznPlayerBridge"
    }
}
