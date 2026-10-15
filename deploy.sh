#!/bin/sh
# Rebuild and restart with the current git commit baked in (shown by ?build).
set -e
cd "$(dirname "$0")"
GIT_COMMIT=$(git rev-parse HEAD) GIT_MESSAGE=$(git log -1 --format=%B) docker compose up -d --build "$@"
