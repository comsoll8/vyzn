// src/tailscale.js
// Thin wrapper around the `tailscale` CLI, which runs inside this same
// container (installed in the Dockerfile, backgrounded by entrypoint.sh
// alongside the Node app — see both for the full picture). This module
// never talks to Tailscale's network directly; it just shells out to the
// CLI and parses its output, the same way a person would at a terminal.
//
// Requires the container to have been started with NET_ADMIN and a
// /dev/net/tun device mapping (docker-compose.yml) — without those,
// `tailscaled` can't create its network interface and every call here
// will fail with a clear error from the CLI itself.

const { execFile } = require('child_process');

function run(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile('tailscale', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || '').trim() || `tailscale ${args[0]} failed`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Current connection status, for the Control Center's Tailscale panel.
 * Returns `installed: false` if the CLI itself isn't present (e.g. a
 * build of the image without it), rather than throwing.
 */
async function status() {
  let raw;
  try {
    raw = await run(['status', '--json']);
  } catch (err) {
    const notInstalled = /ENOENT|not found/i.test(err.message);
    return {
      installed: !notInstalled,
      connected: false,
      backendState: notInstalled ? 'not-installed' : 'error',
      error: notInstalled ? null : err.message,
      self: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { installed: true, connected: false, backendState: 'unknown', error: 'Could not parse tailscale status', self: null };
  }

  const backendState = parsed.BackendState || 'unknown'; // "Running" once connected
  return {
    installed: true,
    connected: backendState === 'Running',
    backendState,
    error: null,
    self: parsed.Self ? {
      hostName: parsed.Self.HostName,
      dnsName: (parsed.Self.DNSName || '').replace(/\.$/, ''),
      tailscaleIPs: parsed.Self.TailscaleIPs || [],
    } : null,
  };
}

/**
 * Brings the Tailscale interface up using the given auth key.
 * `--accept-dns=false` is deliberate: letting Tailscale take over DNS
 * resolution inside the container risks breaking the container's own
 * access to TMDB/Seerr/etc. on the regular internet, which has nothing to
 * do with the private tailnet.
 */
async function up(authKey) {
  await run(['up', `--authkey=${authKey}`, '--accept-dns=false', '--hostname=vyzn'], 30000);
  return status();
}

async function down() {
  await run(['down']);
  return status();
}

module.exports = { status, up, down };
