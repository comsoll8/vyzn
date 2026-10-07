'use strict';
/**
 * Automatic library scanning.
 *   AUTO_SCAN_MODE = off | daily | watch   (Settings > Server Settings)
 *   - daily: scan once a day at AUTO_SCAN_TIME (HH:MM, the server's clock).
 *            If the server was off at that time, it catches up on next start.
 *   - watch: watch the library folders for new video files and scan a couple
 *            of minutes after the last change (so a file that is still
 *            copying in finishes first). Uses inotify, which doesn't wake
 *            sleeping disks; on network mounts that don't report changes,
 *            use daily instead (or AUTO_SCAN_POLL=true to poll).
 * Removed files are not detected yet — only new/changed ones.
 */
const path = require('path');
const config = require('./config');
const scanner = require('./scanner');
const extras = require('./extras');

const SETTLE_MS = 2 * 60 * 1000; // quiet period after the last change
const DEFAULT_TIME = '03:00';

let log = console;
let dailyTimer = null;
let watcher = null;
let settleTimer = null;
let pendingAfterScan = false;
let lastAuto = null;       // { at: ms, reason, error? }
let watchError = null;

const mode = () => {
  const m = String(config.get('AUTO_SCAN_MODE') || 'off').toLowerCase();
  return m === 'daily' || m === 'watch' ? m : 'off';
};
const timeStr = () => {
  const t = String(config.get('AUTO_SCAN_TIME') || DEFAULT_TIME);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : DEFAULT_TIME;
};
const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function trigger(reason) {
  if (scanner.isScanRunning()) { pendingAfterScan = reason === 'files changed'; return; }
  log.info(`[autoscan] Starting scan (${reason})`);
  lastAuto = { at: Date.now(), reason };
  try {
    await scanner.runScan();
  } catch (err) {
    lastAuto.error = err.message;
    log.error(err, '[autoscan] scan failed');
  }
  if (pendingAfterScan) { pendingAfterScan = false; schedule('changes during scan'); }
}

function schedule(reason) {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => trigger(reason || 'files changed'), SETTLE_MS);
}

function checkDaily() {
  if (mode() !== 'daily') return;
  const now = new Date();
  const [h, m] = timeStr().split(':').map(Number);
  const due = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  if (!due || config.get('AUTO_SCAN_LAST_DAILY') === todayStr(now)) return;
  config.set('AUTO_SCAN_LAST_DAILY', todayStr(now));
  trigger('daily schedule');
}

function stopWatching() {
  if (watcher) { watcher.close().catch(() => {}); watcher = null; }
  clearTimeout(settleTimer); settleTimer = null;
}

function startWatching() {
  const roots = scanner.scanRoots();
  watchError = null;
  if (roots.length === 0) { watchError = 'No library folders found to watch.'; return; }
  const chokidar = require('chokidar');
  const poll = String(process.env.AUTO_SCAN_POLL || 'false').toLowerCase() === 'true';
  const mediaDir = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
  watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    persistent: true,
    usePolling: poll,
    interval: 30000,
    depth: 8,
    awaitWriteFinish: { stabilityThreshold: 5000, pollInterval: 1000 },
    ignored: (p, stats) => {
      const base = path.basename(p);
      if (stats && stats.isDirectory && stats.isDirectory()) return scanner.shouldSkipDir(base);
      if (stats && stats.isFile && stats.isFile()) return !scanner.VIDEO_EXTENSIONS.has(path.extname(p).toLowerCase());
      return false;
    },
  });
  const onFile = (p) => {
    if (!scanner.VIDEO_EXTENSIONS.has(path.extname(p).toLowerCase())) return;
    log.info(`[autoscan] Change detected: ${path.relative(mediaDir, p)}`);
    schedule('files changed');
  };
  watcher.on('add', onFile).on('change', onFile);
  watcher.on('error', (e) => { watchError = e.message; log.error(e, '[autoscan] watcher error'); });
  log.info(`[autoscan] Watching ${roots.join(', ')} for new files`);
}

/** (Re)applies the current settings. Call after startup and after a settings save. */
function reconfigure() {
  stopWatching();
  if (mode() === 'watch') {
    try { startWatching(); } catch (e) { watchError = e.message; log.error(e, '[autoscan] could not start watcher'); }
  }
  checkDaily();
}

function start(logger) {
  if (logger) log = logger;
  clearInterval(dailyTimer);
  dailyTimer = setInterval(checkDaily, 60 * 1000);
  dailyTimer.unref();
  reconfigure();
}

function status() {
  const m = mode();
  let nextRun = null;
  if (m === 'daily') {
    const [h, mi] = timeStr().split(':').map(Number);
    const n = new Date();
    n.setHours(h, mi, 0, 0);
    if (config.get('AUTO_SCAN_LAST_DAILY') === todayStr() || n.getTime() <= Date.now()) n.setDate(n.getDate() + 1);
    nextRun = n.getTime();
  }
  return {
    mode: m, time: timeStr(), nextRun, watching: !!watcher, watchError,
    scanning: scanner.isScanRunning(), lastAuto,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, serverTime: Date.now(),
  };
}

module.exports = { start, reconfigure, status };
