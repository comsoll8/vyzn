// src/streamer.js
// On-demand HLS transcoding. When a client requests a stream for a media
// item, we spin up (or reuse) an ffmpeg process that writes an HLS
// playlist + segments into a per-item scratch directory. Simple approach:
// good enough for a single-user/home LAN server; not a scalable multi-
// tenant transcoder.

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const config = require('./config');

const TRANSCODE_DIR = process.env.TRANSCODE_DIR || path.join(__dirname, '..', 'transcode');
// Read dynamically (not cached at module load) so flipping "Hardware
// Transcoding" in the Control Center Settings panel takes effect on the
// very next stream started, with no restart — see src/config.js. (Jobs
// already running keep whatever mode they started with; only a new
// startHlsJob() call picks up the change.)
function isHwTranscodeEnabled() {
  return config.getBool('HW_TRANSCODE', false);
}
function getVaapiDevice() {
  return config.get('VAAPI_DEVICE') || '/dev/dri/renderD128';
}

// Track in-flight transcode jobs, keyed by "<itemId>:<audioTrackKey>" so
// switching audio tracks starts a separate job instead of colliding with
// the default one. Each entry carries enough for the app-switcher panel
// (GET /api/streams/active) and for stopping a job on demand — `command`
// is the live fluent-ffmpeg handle, killed via stopJob().
const activeJobs = new Map();

function jobKey(itemId, audioTrackKey) {
  return `${itemId}:${audioTrackKey}`;
}

function itemDirFor(itemId) {
  return path.join(TRANSCODE_DIR, String(itemId));
}

// Kept for backward compatibility with anything still calling it with just
// an itemId (server.js's static-file root doesn't need this at all, but
// other code may still reference the old single-arg shape).
function outputDirFor(itemId, audioTrackKey) {
  return audioTrackKey === undefined ? itemDirFor(itemId) : path.join(itemDirFor(itemId), audioTrackKey);
}

function playlistPathFor(itemId, audioTrackKey) {
  return path.join(outputDirFor(itemId, audioTrackKey), 'index.m3u8');
}

function subtitlePathFor(itemId) {
  return path.join(itemDirFor(itemId), 'subs.vtt');
}

/**
 * Starts (or returns the existing) HLS transcode job for a media item and
 * audio track. Resolves once the initial playlist file exists (a few
 * segments in), so the caller can start serving it.
 *
 * `audioTrackIndex` is the type-relative audio-stream index (matching
 * scanner.js's `audio_tracks[].index`, and ffmpeg's `-map 0:a:N`
 * selector). Omit it to let ffmpeg pick its own default audio stream,
 * same as before this existed.
 */
function startHlsJob(itemId, sourcePath, { audioTrackIndex, title } = {}) {
  const audioTrackKey = audioTrackIndex === undefined || audioTrackIndex === null ? 'default' : String(audioTrackIndex);
  const key = jobKey(itemId, audioTrackKey);
  if (activeJobs.has(key)) {
    return activeJobs.get(key).promise;
  }

  const outDir = outputDirFor(itemId, audioTrackKey);
  fs.mkdirSync(outDir, { recursive: true });
  const playlistPath = playlistPathFor(itemId, audioTrackKey);

  let commandRef = null;

  const jobPromise = new Promise((resolve, reject) => {
    const command = ffmpeg(sourcePath);
    commandRef = command;

    if (isHwTranscodeEnabled()) {
      // Software decode -> upload frames to the GPU -> encode with
      // QuickSync. This is the "encode-only" VAAPI path: it avoids
      // hardware-decode codec-compatibility issues (some MKV sources use
      // codecs/profiles the iGPU can't decode) at the cost of decode
      // still happening on CPU. Encode is still fully offloaded, which
      // is the expensive part for concurrent streams.
      command
        .inputOptions(['-vaapi_device', getVaapiDevice()])
        .videoFilters('format=nv12,hwupload')
        .videoCodec('h264_vaapi');
    } else {
      command.videoCodec('libx264').outputOptions(['-preset veryfast']);
    }

    const outputOptions = [
      // A forced keyframe every exactly 2 seconds of PTS time — independent
      // of source frame rate — replaces a fixed `-g 48` frame-count GOP,
      // which only lines up with `-hls_time` at some frame rates and not
      // others. Paired with hls_time 2 below, this guarantees a segment
      // boundary lands right at each 2s mark instead of drifting to
      // whatever the next keyframe after the target happens to be.
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-sc_threshold 0',
      // 2s segments instead of 6s: the client can't start playback until
      // the *first* segment is fully encoded (see the poll loop below), so
      // this is the single biggest lever on "how long until video
      // appears" — roughly a 3x cut to that wait, at the cost of slightly
      // more (harmless) segment-file overhead for a movie-length stream.
      '-hls_time 2',
      '-hls_list_size 0',
      '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
    ];
    // Only add explicit stream mapping when a non-default audio track was
    // requested — leaving ffmpeg's own default stream selection alone
    // otherwise keeps existing behavior (and existing cached jobs/URLs)
    // unchanged for the common case of "just play it".
    if (audioTrackIndex !== undefined && audioTrackIndex !== null) {
      outputOptions.unshift('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`);
    }

    command
      .audioCodec('aac')
      // Always downmix to stereo, regardless of the source's channel
      // layout. Confirmed live: multichannel (5.1) AAC muxed into fMP4 for
      // MSE playback triggers a hls.js "mediaSourceRequiresReset" fatal
      // error in-browser that neither hls.js's soft recovery
      // (recoverMediaError()) nor a full hls.js/MediaSource
      // destroy-and-rebuild can work around — it's a genuine incompatibility
      // in how the browser's MediaSource handles multichannel AAC via HLS,
      // not a transient glitch. Since every stream already gets its audio
      // re-encoded to AAC for HLS regardless of the source codec, downmixing
      // at the same time costs nothing extra and sidesteps the whole
      // problem — ffmpeg's `-ac 2` applies its standard 5.1/7.1-to-stereo
      // downmix (folding the surround/LFE channels into L/R) rather than
      // just dropping channels.
      .audioChannels(2)
      .outputOptions(outputOptions)
      .output(playlistPath)
      .on('start', (cmd) => console.log(`[streamer] ffmpeg started for item ${itemId} (audio track ${audioTrackKey}): ${cmd}`))
      .on('error', (err) => {
        console.error(`[streamer] ffmpeg error for item ${itemId}:`, err.message);
        activeJobs.delete(key);
        reject(err);
      })
      .on('end', () => {
        console.log(`[streamer] Transcode finished for item ${itemId} (audio track ${audioTrackKey})`);
        activeJobs.delete(key);
      });

    command.run();

    // Poll for the playlist file to appear rather than waiting for the
    // whole transcode to finish — HLS clients can start once a handful
    // of segments exist.
    const start = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(playlistPath)) {
        clearInterval(poll);
        resolve(playlistPath);
      } else if (Date.now() - start > 30000) {
        clearInterval(poll);
        reject(new Error('Timed out waiting for HLS playlist to appear'));
      }
    }, 300);
  });

  activeJobs.set(key, {
    promise: jobPromise,
    itemId,
    audioTrackKey,
    title: title || null,
    startedAt: Date.now(),
    get command() { return commandRef; },
  });

  return jobPromise;
}

/**
 * Lists currently active transcode jobs, for the "active streams" app-
 * switcher panel. One entry per item+audio-track combination actually
 * running right now.
 */
function listActiveJobs() {
  return Array.from(activeJobs.values()).map((job) => ({
    itemId: job.itemId,
    audioTrackKey: job.audioTrackKey,
    title: job.title,
    startedAt: job.startedAt,
  }));
}

/**
 * Stops a running transcode job (kills the ffmpeg process and drops it
 * from the active-jobs map). Used by the app-switcher's "close" action.
 * Leaves already-written segments on disk — they're harmless scratch data
 * and get cleaned up the same way any other transcode output does.
 */
function stopJob(itemId, audioTrackKey = 'default') {
  const key = jobKey(itemId, audioTrackKey);
  const job = activeJobs.get(key);
  if (!job) return false;
  if (job.command) {
    try {
      job.command.kill('SIGKILL');
    } catch (err) {
      console.error(`[streamer] Failed to kill ffmpeg for item ${itemId}:`, err.message);
    }
  }
  activeJobs.delete(key);
  return true;
}

/**
 * Extracts the first available text-based subtitle track (if any) to a
 * WebVTT sidecar file, once per item — skipped if it already exists on
 * disk from a previous stream start, or if the item has no text subtitle
 * streams (scanner.js already filters out image-based ones like PGS,
 * which ffmpeg can't convert to text). Fast (just remuxing a text stream,
 * not a video transcode), so this is awaited before the caller responds
 * rather than run in the background.
 */
function extractSubtitlesIfNeeded(itemId, sourcePath, subtitleTracks) {
  if (!subtitleTracks || subtitleTracks.length === 0) return Promise.resolve(null);
  const outPath = subtitlePathFor(itemId);
  if (fs.existsSync(outPath)) return Promise.resolve(outPath);

  fs.mkdirSync(itemDirFor(itemId), { recursive: true });
  const track = subtitleTracks[0];

  return new Promise((resolve) => {
    ffmpeg(sourcePath)
      .outputOptions(['-map', `0:s:${track.index}`])
      .output(outPath)
      .on('end', () => resolve(outPath))
      .on('error', (err) => {
        console.error(`[streamer] Subtitle extraction failed for item ${itemId}:`, err.message);
        resolve(null);
      })
      .run();
  });
}

module.exports = {
  startHlsJob,
  outputDirFor,
  playlistPathFor,
  subtitlePathFor,
  listActiveJobs,
  stopJob,
  extractSubtitlesIfNeeded,
};
