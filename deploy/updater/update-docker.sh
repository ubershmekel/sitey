#!/bin/sh
# This script is NOT baked into the sitey-updater Docker image.
# It is read from the /sitey-root mount at exec time.
#
# RENAMING: This file can be safely renamed. system.ts reads its contents
# into a shell variable BEFORE `git pull`, then evals from memory after
# the pull. Each deployed generation only references its own filename, so
# a rename + system.ts update in the same commit works without breakage.
#
# All output is tee'd to /data/.update.log so it survives the sitey-api
# restart that happens at the end of this script.
set -e
set -o pipefail 2>/dev/null || true

LOG="/data/.update.log"
: > "$LOG"

log() { echo "[sitey-updater] $(date -Iseconds) $1" | tee -a "$LOG"; }

# Derive the host path of /sitey-root by inspecting our own container's mounts
# via the Docker API. This lets `docker compose up -d` resolve relative volume
# paths (like ./caddy/Caddyfile) against the HOST filesystem, not the container's.
HOST_ROOT=$(docker inspect "$(hostname)" \
  --format '{{range .Mounts}}{{if eq .Destination "/sitey-root"}}{{.Source}}{{end}}{{end}}')

# Docker Desktop on Windows reports mount sources as Windows paths (E:\foo\bar)
# but the Docker VM expects /e/foo/bar. Convert if needed.
case "$HOST_ROOT" in
  [A-Za-z]:\\*|[A-Za-z]:/*)
    drive=$(echo "${HOST_ROOT%%:*}" | tr 'A-Z' 'a-z')
    rest=$(echo "${HOST_ROOT#*:}" | tr '\\' '/')
    HOST_ROOT="/$drive$rest"
    ;;
esac

HOST_DEPLOY="$HOST_ROOT/deploy"

log "=== update starting ==="
log "Host deploy dir: $HOST_DEPLOY"

cd /sitey-root/deploy

# Exclude the updater itself — recreating our own container kills this exec.
# The updater rarely needs rebuilding since its script is mounted, not baked in.
SERVICES=$(docker compose config --services | grep -v sitey-updater | tr '\n' ' ')

log "[1/2] docker compose build"
log "Rebuild images for services built from source"
docker compose build $SERVICES 2>&1 | tee -a "$LOG"

log "[2/2] docker compose up -d"
log "Recreate containers whose images or config have changed"
log "Restarting: $SERVICES"
# build: uses container paths (sends file context to daemon as tar) — works fine.
# up: bind mount paths must be HOST paths, so we use --project-directory to
# resolve relative paths against the host filesystem.
# --env-file is needed because --project-directory changes where compose looks
# for .env (to the host path, which doesn't exist inside this container).
ENV_FILE=""
if [ -f /sitey-root/deploy/.env ]; then
  ENV_FILE="--env-file /sitey-root/deploy/.env"
fi
docker compose \
  -f /sitey-root/deploy/docker-compose.yml \
  $ENV_FILE \
  --project-directory "$HOST_DEPLOY" \
  up -d $SERVICES 2>&1 | tee -a "$LOG"

log "=== update complete ==="
