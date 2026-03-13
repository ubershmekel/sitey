#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/testing/reset-remote.sh <ssh-target> [--url https://sitey.example.com] [--dir /opt/sitey/deploy] [--refresh pull|installer|none]

Example:
  ./scripts/testing/reset-remote.sh root@your-server --url https://sitey.example.com --refresh pull

What it does on the remote host:
1) cd into Sitey deploy dir
2) docker compose down
3) wipe deploy/data/sitey.db and deploy/data/projects
4) set SITEY_URL in .env (if --url given)
5) optionally refresh code (`git pull` or installer)
6) docker compose up -d --build
7) run bootstrap:init and print a fresh override password
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

SSH_TARGET="$1"
shift

SITEY_URL=""
REMOTE_DEPLOY_DIR="/opt/sitey/deploy"
REFRESH_MODE="pull"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      SITEY_URL="${2:-}"
      shift 2
      ;;
    --dir)
      REMOTE_DEPLOY_DIR="${2:-}"
      shift 2
      ;;
    --refresh)
      REFRESH_MODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ "${REFRESH_MODE}" != "pull" && "${REFRESH_MODE}" != "installer" && "${REFRESH_MODE}" != "none" ]]; then
  echo "Invalid --refresh value: ${REFRESH_MODE} (expected: pull|installer|none)"
  exit 1
fi

if [[ "${REFRESH_MODE}" == "installer" && "${REMOTE_DEPLOY_DIR}" != "/opt/sitey/deploy" ]]; then
  echo "--refresh installer requires --dir /opt/sitey/deploy"
  exit 1
fi

echo "Resetting Sitey on ${SSH_TARGET} (${REMOTE_DEPLOY_DIR})..."

ssh -o StrictHostKeyChecking=accept-new "${SSH_TARGET}" \
  "REMOTE_DEPLOY_DIR='${REMOTE_DEPLOY_DIR}' SITEY_URL='${SITEY_URL}' REFRESH_MODE='${REFRESH_MODE}' bash -s" <<'REMOTE_EOF'
set -euo pipefail

cd "${REMOTE_DEPLOY_DIR}"

# Stop all containers
docker compose down

# Wipe DB and project data so we start fresh
rm -f data/sitey.db
rm -rf data/projects
mkdir -p data/projects

# Set SITEY_URL in .env (upsert)
if [[ -n "${SITEY_URL}" ]]; then
  touch .env
  if grep -qE '^SITEY_URL=' .env; then
    sed -i "s|^SITEY_URL=.*|SITEY_URL=${SITEY_URL}|" .env
  else
    echo "SITEY_URL=${SITEY_URL}" >> .env
  fi
fi

# Refresh code (installer re-clones + rebuilds, pull just fast-forwards)
if [[ "${REFRESH_MODE}" == "installer" ]]; then
  curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
elif [[ "${REFRESH_MODE}" == "pull" ]]; then
  SITEY_ROOT="$(cd "${REMOTE_DEPLOY_DIR}/.." && pwd)"
  git -C "${SITEY_ROOT}" pull --ff-only
fi

# Rebuild and start containers
docker compose up -d --build

# Wait for sitey-api to be healthy (up to 2 minutes)
# /health only responds after migrations + bootstrap have completed
for _ in $(seq 1 60); do
  if docker compose exec --interactive=false -T sitey-api sh -c "wget -qO- http://localhost:3001/health" >/dev/null 2>&1; then
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
if [[ -n "${SITEY_URL}" ]]; then
  echo "URL: ${SITEY_URL}"
fi
if [[ -n "${PASSWORD}" ]]; then
  echo "Password: ${PASSWORD}"
else
  echo "Password parse failed. Raw output:"
  printf "%s\n" "${PASS_OUTPUT}"
fi
REMOTE_EOF
