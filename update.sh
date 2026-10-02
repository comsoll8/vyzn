#!/bin/sh
# Pulls the latest VYZN source and rebuilds/restarts the container.
#
# Run this from the git clone on your Unraid box whenever you want to pick
# up changes, e.g.:
#   cd /mnt/user/appdata/vyzn-src && ./update.sh
#
# Why DOCKER_BUILDKIT=0: on this host, BuildKit (Docker's default builder)
# silently ignores docker-compose.yml's `build: network: host` setting and
# falls back to its own internal build network instead — whose DNS/IPv6
# handling turned out to be unreliable here, causing `npm install` to hang
# for 30+ minutes during `docker compose up -d --build`. The classic
# builder (DOCKER_BUILDKIT=0) honors `network: host` correctly, using the
# same working network path the host itself uses, and finishes the same
# install in well under a minute. This is set here so you never have to
# remember to type it by hand.
set -e

echo "==> Pulling latest changes"
git pull

echo "==> Rebuilding and restarting (classic builder — see comment above)"
DOCKER_BUILDKIT=0 docker compose up -d --build

echo "==> Done. Container status:"
docker ps --filter name=vyzn
