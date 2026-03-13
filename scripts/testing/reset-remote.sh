#!/usr/bin/env bash
# Remote reset script — piped to the remote host via ssh by remote-test-wipe.mjs
# Can also be run standalone: ssh root@host "REMOTE_DEPLOY_DIR=/opt/sitey/deploy REFRESH_MODE=pull bash -s" < reset-remote.sh
set -euo pipefail

cd "${REMOTE_DEPLOY_DIR}"

# Stop all containers
docker compose down

# Wipe DB (including SQLite WAL files) and project data so we start fresh
DATA_ROOT_HOST="./data"
echo "Pwd: $(pwd)"
echo "Wiping data under ${DATA_ROOT_HOST}"
rm -f "${DATA_ROOT_HOST}/sitey.db" "${DATA_ROOT_HOST}/sitey.db-wal" "${DATA_ROOT_HOST}/sitey.db-shm"
rm -rf "${DATA_ROOT_HOST}/projects"

# Refresh code (installer re-clones + rebuilds, pull just fast-forwards)
if [[ "${REFRESH_MODE}" == "installer" ]]; then
  curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
elif [[ "${REFRESH_MODE}" == "pull" ]]; then
  SITEY_ROOT="$(cd "${REMOTE_DEPLOY_DIR}/.." && pwd)"
  git -C "${SITEY_ROOT}" pull --ff-only
fi

# Rebuild and start containers
docker compose up -d --build

# Wait for sitey-api to be ready (up to 2 minutes)
for _ in $(seq 1 60); do
  if docker compose exec --interactive=false -T sitey-api sh -lc "node -v" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Generate a fresh override password
PASS_OUTPUT="$(docker compose exec --interactive=false -T sitey-api npm run -s bootstrap:init 2>&1 || true)"
if [[ -z "${PASS_OUTPUT}" ]]; then
  echo "Failed to get password from bootstrap:init"
  exit 1
fi

PASSWORD="$(printf "%s\n" "${PASS_OUTPUT}" | sed -n 's/.*Password: \([^[:space:]]\+\).*/\1/p' | head -n1)"

# Print results
echo "----- SITEY RESET COMPLETE -----"
if [[ -n "${PASSWORD}" ]]; then
  echo "Password: ${PASSWORD}"
else
  echo "Password parse failed. Raw output:"
  printf "%s\n" "${PASS_OUTPUT}"
fi
