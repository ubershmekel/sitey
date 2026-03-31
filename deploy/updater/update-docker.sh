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

# ── Overridable settings (for testing) ────────────────────────────────────────
SITEY_ROOT="${SITEY_ROOT:-/sitey-root}"
SERVICES="${UPDATE_SERVICES:-caddy sitey-api}"
BUILDER="${UPDATE_BUILDER:-sitey-web-builder}"
BUILD_SERVICES="${UPDATE_BUILD_SERVICES:-$BUILDER $SERVICES}"

LOG="/data/.update.log"
: > "$LOG"

log() { echo "[sitey-updater] $(date -Iseconds) $1" | tee -a "$LOG"; }

# Derive the host path of $SITEY_ROOT by inspecting our own container's mounts
# via the Docker API. This lets `docker compose up -d` resolve relative volume
# paths (like ./caddy/Caddyfile) against the HOST filesystem, not the container's.
HOST_ROOT=$(docker inspect "$(hostname)" \
  --format "{{range .Mounts}}{{if eq .Destination \"$SITEY_ROOT\"}}{{.Source}}{{end}}{{end}}")

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

cd "$SITEY_ROOT/deploy"

# build: uses container paths (sends file context to daemon as tar) — works fine.
# up: bind mount paths must be HOST paths, so we use --project-directory to
# resolve relative paths against the host filesystem.
# --env-file is needed because --project-directory changes where compose looks
# for .env (to the host path, which doesn't exist inside this container).
ENV_FILE=""
if [ -f "$SITEY_ROOT/deploy/.env" ]; then
  ENV_FILE="--env-file $SITEY_ROOT/deploy/.env"
fi

DC="docker compose -f $SITEY_ROOT/deploy/docker-compose.yml $ENV_FILE"
DC_HOST="$DC --project-directory $HOST_DEPLOY"

log "[1/3] docker compose build"
log "Rebuild images for services built from source"
$DC build $BUILD_SERVICES 2>&1 | tee -a "$LOG"

log "[2/3] $BUILDER"
log "Build and deploy SPA to data volume (Caddy stays up)"
$DC_HOST up "$BUILDER" 2>&1 | tee -a "$LOG"

log "[3/3] docker compose up -d"
log "Recreate containers whose images or config have changed"
log "Restarting: $SERVICES"
$DC_HOST up -d $SERVICES 2>&1 | tee -a "$LOG"

log "=== update complete ==="
