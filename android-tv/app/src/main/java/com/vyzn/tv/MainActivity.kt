package com.vyzn.tv

import android.annotation.SuppressLint
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.net.http.SslError
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * A single-Activity wrapper around VYZN's existing browser frontend. There
 * is deliberately no separate native UI here — every screen, shelf, and
 * control is the same HTML/CSS/JS that runs in a desktop browser. This
 * Activity's whole job is: point a WebView at the server, make it behave
 * like a TV app (fullscreen, D-pad-friendly focus, HTML5 video fullscreen,
 * a real Back-button/history integration), and get out of the way.
 *
 * Server address handling: VYZN is self-hosted on the person's own LAN, so
 * there's no fixed URL to hardcode — it's asked for once (an AlertDialog,
 * see promptForServerUrl) and remembered in SharedPreferences. Long-
 * pressing Back reopens that same prompt if the address ever changes.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var loadingSpinner: ProgressBar
    private lateinit var errorContainer: LinearLayout
    private lateinit var errorMessage: TextView
    private lateinit var retryButton: View

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    private val prefs by lazy { getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        hideSystemBars()

        webView = findViewById(R.id.webView)
        fullscreenContainer = findViewById(R.id.fullscreenContainer)
        loadingSpinner = findViewById(R.id.loadingSpinner)
        errorContainer = findViewById(R.id.errorContainer)
        errorMessage = findViewById(R.id.errorMessage)

        retryButton = findViewById(R.id.retryButton)
        retryButton.setOnClickListener { loadSavedOrPrompt() }
        findViewById<View>(R.id.changeServerButton).setOnClickListener { promptForServerUrl(prefill = true) }

        configureWebView()
        setupBackNavigation()

        loadSavedOrPrompt()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        webView.requestFocus()
        // Covers returning from PlayerActivity after native playback ends
        // (see NativePlayerBridge) — the native side already reported
        // progress straight to the server over HTTP, so this just tells
        // the page to refresh what it shows (Continue Watching) to match.
        // Also fires on every other resume (first launch, switching back
        // from another app), where it's a harmless no-op refresh — see
        // app.js's vyznNativePlaybackEnded().
        webView.evaluateJavascript(
            "if (window.vyznNativePlaybackEnded) { window.vyznNativePlaybackEnded(); }",
            null
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Full immersive mode — a TV app should never show Android's status/nav
    // bars once it's running; the topbar/hamburger menu inside the page is
    // the only chrome that should be visible.
    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    // True on a real Android TV / Google TV device (or an emulator image
    // configured as one); false on a phone, tablet, or any device without
    // the "television" UI mode. Used to decide whether this install gets
    // the TV web layout (D-pad shelf nav, landscape-only hero/cards) or the
    // site's normal mobile-responsive one.
    private fun isTelevision(): Boolean {
        val uiModeManager = getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        return uiModeManager?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }

    // --- WebView setup -----------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        // The web app leans on localStorage for the active profile id, the
        // preferred audio language, etc. — without this it silently loses
        // that state on every restart.
        settings.domStorageEnabled = true
        // openPlayer() calls video.play() immediately on load; without this
        // WebView silently blocks it until some prior "user gesture" is
        // detected, which doesn't reliably happen from a D-pad select.
        settings.mediaPlaybackRequiresUserGesture = false
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        // Lets the web app (index.html's inline UA-sniff script) tell this
        // wrapper apart from a desktop/mobile browser hitting the same
        // server, so it can turn off backdrop-filter blur and switch to the
        // D-pad-friendly shelf layout — see style.css's .tv-app rule. That
        // blur is expensive to composite and is very likely the main cause
        // of sluggishness on real TV-box hardware.
        //
        // Only added on an actual television (isTelevision() below) — this
        // same APK also installs on phones/tablets (see the manifest's
        // launcher intent-filter), and there the page should render its
        // own existing mobile-responsive layout instead of the TV one, now
        // that MainActivity is no longer landscape-locked.
        if (isTelevision()) {
            settings.userAgentString = settings.userAgentString + " VyznTV"
        }

        webView.isFocusable = true
        webView.isFocusableInTouchMode = true

        // See NativePlayerBridge's own doc comment: exposes
        // window.VyznNativePlayer to the page so app.js's openPlayer() can
        // hand playback off to PlayerActivity (ExoPlayer) instead of this
        // WebView's own HTML5 video, specifically to preserve multichannel
        // (5.1+) source audio that browser playback can't reliably carry.
        webView.addJavascriptInterface(
            NativePlayerBridge(this) { prefs.getString(PREF_SERVER_URL, null) },
            "VyznNativePlayer"
        )

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                loadingSpinner.visibility = View.VISIBLE
                errorContainer.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadingSpinner.visibility = View.GONE
                webView.requestFocus()
            }

            // Only treat a failure to load the *page itself* as an error —
            // a single failed sub-resource (a missing poster image, a
            // flaky TMDB image CDN request) shouldn't blank the whole app.
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    showLoadError(null)
                }
            }

            // Self-hosted servers commonly run behind a self-signed cert if
            // they're on https at all; VYZN's own setup guide only calls
            // for plain http on the LAN, but this keeps a same-network
            // https reverse proxy usable too instead of a hard failure.
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                handler?.proceed()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // HTML5 <video> fullscreen (the player's Fullscreen button)
            // doesn't work in a WebView by default — the page's own
            // requestFullscreen() call is silently ignored unless the host
            // app hands it a native view to take over, which is what these
            // two callbacks are for.
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                fullscreenContainer.addView(
                    view,
                    FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
                )
                fullscreenContainer.visibility = View.VISIBLE
                webView.visibility = View.GONE
                hideSystemBars()
            }

            override fun onHideCustomView() {
                fullscreenContainer.visibility = View.GONE
                fullscreenContainer.removeAllViews()
                webView.visibility = View.VISIBLE
                customViewCallback?.onCustomViewHidden()
                customView = null
                customViewCallback = null
                webView.requestFocus()
            }
        }
    }

    // --- Back button <-> the web app's own history-based overlay system ---
    // The web app pushes a browser-history entry every time an overlay
    // (Movie Detail, the player, Settings, Control Center, ...) opens, and
    // closes it on a back/swipe gesture — see app.js's enterOverlay()/
    // exitOverlay(). WebView.goBack() operates on that same HTML5 History
    // API, pushState entries included, so wiring Android's Back button
    // straight to it is exactly correct: Back closes whatever's open,
    // screen by screen, before finally exiting the app.
    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The web app now auto-enters real HTML5 fullscreen the
                // moment any video starts playing (not just when the
                // player's own Fullscreen button is tapped), so this comes
                // up on every single title, not as an edge case. Exiting
                // that fullscreen view has to take priority over page
                // history — otherwise Back would try to navigate the page
                // underneath while the screen is still visually stuck
                // showing the fullscreen video.
                if (customView != null) {
                    customViewCallback?.onCustomViewHidden()
                    return
                }
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            promptForServerUrl(prefill = true)
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    // --- Server URL prompt / persistence ------------------------------------

    private fun loadSavedOrPrompt() {
        val saved = prefs.getString(PREF_SERVER_URL, null)
        if (saved.isNullOrBlank()) {
            promptForServerUrl(prefill = false)
        } else {
            loadServer(saved)
        }
    }

    private fun promptForServerUrl(prefill: Boolean) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.server_url_hint)
            if (prefill) setText(prefs.getString(PREF_SERVER_URL, ""))
            setSingleLine(true)
        }
        val padding = (16 * resources.displayMetrics.density).toInt()
        val container = FrameLayout(this).apply {
            setPadding(padding, padding / 2, padding, 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.server_url_title)
            .setMessage(R.string.server_url_message)
            .setView(container)
            .setCancelable(!prefs.getString(PREF_SERVER_URL, "").isNullOrBlank())
            .setPositiveButton(R.string.server_url_connect) { _, _ ->
                val normalized = normalizeUrl(input.text.toString())
                if (normalized == null) {
                    android.widget.Toast.makeText(this, R.string.server_url_invalid, android.widget.Toast.LENGTH_LONG).show()
                    promptForServerUrl(prefill = true)
                } else {
                    prefs.edit().putString(PREF_SERVER_URL, normalized).apply()
                    loadServer(normalized)
                }
            }
            .show()
    }

    private fun normalizeUrl(raw: String): String? {
        var url = raw.trim()
        if (url.isEmpty()) return null
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        url = url.trimEnd('/')
        return try {
            val parsed = java.net.URL(url)
            if (parsed.host.isNullOrEmpty()) null else url
        } catch (e: Exception) {
            null
        }
    }

    private fun loadServer(url: String) {
        errorContainer.visibility = View.GONE
        webView.loadUrl(url)
    }

    private fun showLoadError(message: String?) {
        loadingSpinner.visibility = View.GONE
        errorContainer.visibility = View.VISIBLE
        if (message != null) errorMessage.text = message
        retryButton.requestFocus()
    }

    companion object {
        private const val PREFS_NAME = "vyzn_prefs"
        private const val PREF_SERVER_URL = "server_url"
    }
}
