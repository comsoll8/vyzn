# Lightweight Node.js base
FROM node:20-alpine

# Install ffmpeg (transcoding), Intel VAAPI drivers for hardware
# transcoding via QuickSync, tools needed to remap PUID/PGID at runtime,
# and Tailscale (mesh VPN client, for remote access — see the "Tailscale"
# panel in Control Center / Settings and entrypoint.sh for how it's
# started). iptables/ip6tables are Tailscale's own runtime dependency for
# setting up its network interface.
RUN apk add --no-cache \
    ffmpeg \
    intel-media-driver \
    libva-intel-driver \
    libva-utils \
    mesa-va-gallium \
    shadow \
    su-exec \
    tzdata \
    iptables \
    ip6tables \
    tailscale

WORKDIR /app

# Install deps first for layer caching
COPY package*.json ./
# Unraid's default Docker bridge network very often has a working IPv4
# route to the internet but a dead/black-holed IPv6 one (the exact same
# issue src/tmdb.js already works around for the app's own runtime
# fetches — see its comment for the full explanation). npm's registry
# fetches hit this too, but at *build* time, in Docker's build network
# namespace rather than the app's own Node process, so that runtime fix
# doesn't cover it — this needs its own fix here. --dns-result-order=
# ipv4first tells Node (which npm itself runs on) to resolve/try IPv4
# addresses before IPv6 ones, instead of whatever order DNS returned them
# in, sidestepping the dead IPv6 route. The retry/timeout bumps are a
# second, independent safety net for an ordinary flaky-network timeout
# that has nothing to do with IPv6 at all.
# NODE_OPTIONS is set inline on just the npm install call (not a
# persistent ENV) so it doesn't linger into the final image's runtime
# environment — the app doesn't need it at runtime, since tmdb.js already
# handles its own runtime fetches' IPv6 issue directly in code.
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && NODE_OPTIONS=--dns-result-order=ipv4first npm install --omit=dev

# App source and browser frontend
COPY src ./src
COPY public ./public

ENV PORT=8080 \
    NODE_ENV=production \
    PUID=99 \
    PGID=100 \
    MEDIA_DIR=/media \
    DATA_DIR=/config \
    TRANSCODE_DIR=/transcode \
    LIBVA_DRIVER_NAME=iHD \
    HW_TRANSCODE=false

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
