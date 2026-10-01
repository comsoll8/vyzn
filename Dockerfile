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
RUN npm install --omit=dev

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
