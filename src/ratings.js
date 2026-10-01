// src/ratings.js
// Shared content-rating ordinal so we can gate both movies (G/PG/PG-13/R/
// NC-17) and TV shows (TV-Y/TV-Y7/TV-G/TV-PG/TV-14/TV-MA) against a single
// profile.max_content_rating value on the same scale.

const RATING_ORDER = {
  'TV-Y': 0,
  G: 0,
  'TV-Y7': 1,
  'TV-G': 1,
  PG: 2,
  'TV-PG': 2,
  'PG-13': 3,
  'TV-14': 3,
  R: 4,
  'TV-MA': 4,
  'NC-17': 5,
};

function ordinal(rating) {
  if (!rating) return null;
  const key = String(rating).toUpperCase();
  return Object.prototype.hasOwnProperty.call(RATING_ORDER, key) ? RATING_ORDER[key] : null;
}

// Returns true if `rating` is allowed under `maxRating`. Unknown/missing
// content_rating is allowed unless the profile is a child profile (safer
// default: don't silently let unrated content through to a kid).
function isAllowed(rating, maxRating, isChild) {
  if (!maxRating) return true;
  const max = ordinal(maxRating);
  if (max === null) return true;
  const val = ordinal(rating);
  if (val === null) return !isChild;
  return val <= max;
}

module.exports = { RATING_ORDER, ordinal, isAllowed };
