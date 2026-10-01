// src/concurrency.js
// Tiny concurrency-limited map, used to run ffprobe and TMDB lookups in
// parallel instead of one-at-a-time, without pulling in a dependency.
// Safe with better-sqlite3 here because its calls are synchronous — even
// though many async tasks (ffprobe, fetch) are in flight together, each
// one's DB write happens in a single, non-interruptible tick.

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
