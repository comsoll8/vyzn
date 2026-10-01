#!/bin/sh
set -e

# Unraid convention: nobody:users == 99:100
PUID=${PUID:-99}
PGID=${PGID:-100}

if [ "$(id -u node)" != "$PUID" ]; then
  usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
fi

mkdir -p /config /transcode /config/tailscale
chown -R node:node /app /config /transcode

# If the Intel GPU render node is passed through (/dev/dri:/dev/dri in
# compose), make sure the 'node' user can actually access it: match the
# container's render/video groups to whatever GID owns the device on the
# host, since that GID varies by system.
if [ -e /dev/dri/renderD128 ]; then
  RENDER_GID=$(stat -c '%g' /dev/dri/renderD128)
  if ! getent group "$RENDER_GID" > /dev/null 2>&1; then
    addgroup -g "$RENDER_GID" render_host
  fi
  RENDER_GROUP=$(getent group "$RENDER_GID" | cut -d: -f1)
  usermod -aG "$RENDER_GROUP" node
fi

if [ -e /dev/dri/card0 ]; then
  VIDEO_GID=$(stat -c '%g' /dev/dri/card0)
  if ! getent group "$VIDEO_GID" > /dev/null 2>&1; then
    addgroup -g "$VIDEO_GID" video_host
  fi
  VIDEO_GROUP=$(getent group "$VIDEO_GID" | cut -d: -f1)
  usermod -aG "$VIDEO_GROUP" node
fi

# Start Tailscale's background daemon (tailscaled) before dropping to the
# unprivileged 'node' user — it needs root + NET_ADMIN to create its
# network interface. This only actually connects the tailnet once someone
# runs `tailscale up` (via the Control Center Settings panel, which calls
# src/tailscale.js, which shells out to the CLI below) — until then it
# just sits idle. State is kept under /config (a mounted volume) so a
# rebuild/recreate doesn't force reconnecting from scratch. Not present
# at all if /dev/net/tun wasn't mapped into the container (no
# NET_ADMIN/tun in docker-compose.yml) — the Tailscale panel just reports
# "not installed" in that case rather than the app failing to start.
if [ -e /dev/net/tun ] && command -v tailscaled > /dev/null 2>&1; then
  mkdir -p /var/run/tailscale
  tailscaled \
    --state=/config/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    > /var/log/tailscaled.log 2>&1 &

  # Wait briefly for the control socket to appear, then open it up so the
  # unprivileged 'node' user (which the Node app and its `tailscale`
  # CLI calls run as) can talk to it. This is a single-user home-server
  # container, so a world-writable local socket is an acceptable trade
  # for not needing the app itself to run as root.
  for i in $(seq 1 10); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done
  [ -S /var/run/tailscale/tailscaled.sock ] && chmod 666 /var/run/tailscale/tailscaled.sock
fi

exec su-exec node "$@"
