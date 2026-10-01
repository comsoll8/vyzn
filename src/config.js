// src/config.js
// Centralized runtime configuration. Each setting can come from the
// `settings` DB table (an override set from the Control Center's Settings
// panel) or fall back to the matching environment variable from
// docker-compose.yml, in that order. Every read goes through get()/getBool()
// at the moment it's needed rather than being cached into a module-load-time
// constant, so a UI edit takes effect immediately, with no container
// restart — that's the whole point of this module existing.

const db = require('./db');

const upsertStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');
const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const getAllStmt = db.prepare('SELECT key, value FROM settings');

// The placeholder the Settings UI shows for a secret that's already set.
// The PUT /api/settings/config route treats a field holding exactly this
// string as "untouched, leave it alone" — see server.js — so this value
// must never be shown anywhere else as if it were a real secret.
const SECRET_MASK = '••••••••';

// Every setting the UI can edit: its env-var fallback name, whether it's a
// secret (masked in describeAll(), never echoed back), and a human label +
// hint used by the Settings panel.
const SCHEMA = {
  TMDB_API_KEY: {
    envVar: 'TMDB_API_KEY', secret: true,
    label: 'TMDB API Key', hint: 'v3 API key from themoviedb.org/settings/api',
  },
  TMDB_AUTH_TOKEN: {
    envVar: 'TMDB_AUTH_TOKEN', secret: true,
    label: 'TMDB Auth Token (v4, optional)', hint: 'Alternative to the API key above',
  },
  SEERR_URL: {
    envVar: 'SEERR_URL', secret: false,
    label: 'Seerr URL', hint: 'e.g. http://192.168.1.50:5055',
  },
  SEERR_API_KEY: {
    envVar: 'SEERR_API_KEY', secret: true,
    label: 'Seerr API Key', hint: 'Jellyseerr/Overseerr Settings > General > API Key',
  },
  HW_TRANSCODE: {
    envVar: 'HW_TRANSCODE', secret: false,
    label: 'Hardware Transcoding', hint: 'Use the iGPU (VAAPI) to encode HLS streams', type: 'bool',
  },
  VAAPI_DEVICE: {
    envVar: 'VAAPI_DEVICE', secret: false,
    label: 'VAAPI Device', hint: 'e.g. /dev/dri/renderD128',
  },
  TAILSCALE_AUTHKEY: {
    envVar: 'TAILSCALE_AUTHKEY', secret: true,
    label: 'Tailscale Auth Key', hint: 'One-off or reusable key from the Tailscale admin console',
  },
};

/**
 * Reads a config value: a DB override wins if present, else the matching
 * env var, else null. A DB row only exists when set() put one there
 * (clearing a value deletes the row rather than storing ''), so presence
 * alone means "explicit override".
 */
function get(key) {
  const row = getStmt.get(key);
  if (row) return row.value;
  const schema = SCHEMA[key];
  if (schema && schema.envVar && process.env[schema.envVar] !== undefined) {
    return process.env[schema.envVar];
  }
  return null;
}

function getBool(key, defaultValue = false) {
  const raw = get(key);
  if (raw === null || raw === undefined) return defaultValue;
  return String(raw).toLowerCase() === 'true';
}

/**
 * Sets (or clears, with null/undefined/'') a config override. Clearing
 * deletes the row so the env var takes over again on the next get().
 */
function set(key, value) {
  if (!(key in SCHEMA)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  if (value === null || value === undefined || value === '') {
    deleteStmt.run(key);
  } else {
    upsertStmt.run(key, String(value));
  }
}

/**
 * Everything the Settings panel needs to render: per key, the effective
 * value (masked for secrets, blank if unset), whether anything is set,
 * and whether it's coming from a DB override or the env var default.
 */
function describeAll() {
  const overridden = new Set(getAllStmt.all().map((r) => r.key));
  const out = {};
  for (const [key, schema] of Object.entries(SCHEMA)) {
    const effective = get(key);
    const hasValue = Boolean(effective);
    out[key] = {
      label: schema.label,
      hint: schema.hint,
      secret: Boolean(schema.secret),
      type: schema.type || 'text',
      hasValue,
      value: schema.secret ? (hasValue ? SECRET_MASK : '') : (effective || ''),
      source: overridden.has(key) ? 'override' : (process.env[schema.envVar] ? 'env' : 'unset'),
    };
  }
  return out;
}

module.exports = { get, getBool, set, describeAll, SCHEMA, SECRET_MASK };
