'use strict';
/**
 * Detects DVD/Blu-ray "extras" (bonus content, featurettes, deleted scenes,
 * trailers, alternate endings...) so they aren't indexed as extra "versions"
 * of the movie they came with. Follows Plex/Jellyfin naming conventions.
 *
 * Movies only — TV libraries are left alone (a show can legitimately be
 * called "Extras"). Disable with SCAN_SKIP_EXTRAS=false.
 */
const fs = require('fs');
const path = require('path');

const ENABLED = String(process.env.SCAN_SKIP_EXTRAS || 'true').toLowerCase() !== 'false';

// Folder names (Plex/Jellyfin/Emby convention) whose contents are extras.
const EXTRA_DIRS = new Set([
  'extras', 'extra', 'featurettes', 'behind the scenes', 'behindthescenes', 'deleted scenes',
  'interviews', 'scenes', 'shorts', 'trailers', 'other', 'bonus', 'bonus features', 'bonus content',
  'special features', 'specialfeatures', 'sample', 'samples', 'bonus disc',
]);

// "Movie (2010)-trailer.mkv" style suffixes.
const SUFFIX_RE = /[-_.](trailer|featurette|behindthescenes|deleted|interview|scene|short|other|sample)$/i;

// Phrases anywhere in the file name, bounded by non-alphanumerics.
const PHRASES = [
  'deleted scenes?', 'behind the scenes', 'making of', 'the making of', 'gag reel', 'bloopers?', 'outtakes?',
  'featurettes?', 'bonus (?:features?|content|disc|material|footage)', 'bonus', 'alternat(?:e|ive) endings?',
  'special features?', 'extras?', 'interviews?', 'trailers?', 'teasers?', 'sample',
];
const PHRASE_RE = new RegExp(`(?:^|[^a-z0-9])(?:${PHRASES.join('|')})(?:[^a-z0-9]|$)`, 'i');

const dirVideoCount = new Map();
function videoSiblings(dir, videoExts) {
  if (dirVideoCount.has(dir)) return dirVideoCount.get(dir);
  let n = 0;
  try {
    n = fs.readdirSync(dir).filter((f) => videoExts.has(path.extname(f).toLowerCase())).length;
  } catch { n = 0; }
  dirVideoCount.set(dir, n);
  return n;
}
function resetCache() { dirVideoCount.clear(); }

/**
 * @param {string} filePath absolute path
 * @param {string} mediaDir library root
 * @param {Set<string>} videoExts lowercase extensions
 * @param {boolean} isTv true for files under a TV folder (never treated as extras)
 */
function isExtraFile(filePath, mediaDir, videoExts, isTv) {
  if (!ENABLED || isTv) return false;
  const rel = path.relative(mediaDir, filePath).split(path.sep);
  // Directories between the top-level library folder and the file.
  const dirs = rel.slice(1, -1).map((d) => d.toLowerCase());
  if (dirs.some((d) => EXTRA_DIRS.has(d))) return true;

  const base = path.basename(filePath, path.extname(filePath));
  if (SUFFIX_RE.test(base)) return true;
  // Name-keyword rule only when the file sits next to other videos (i.e. it's
  // an extra beside a main feature) — a lone file that merely has such a word
  // in its title is probably the movie itself.
  if (PHRASE_RE.test(base) && videoSiblings(path.dirname(filePath), videoExts) > 1) return true;
  return false;
}

module.exports = { isExtraFile, resetCache, ENABLED };
