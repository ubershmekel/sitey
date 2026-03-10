#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
  RUN_AS_USER="root"
else
  SUDO="sudo"
  RUN_AS_USER="${USER:-$(id -un)}"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Ubuntu/Debian only."
  exit 1
fi

set_env_key() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -qE "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
  else
    printf "%s=%s\n" "${key}" "${value}" >>"${file}"
  fi
}

echo "==> Installing system packages"
${SUDO} apt-get update -y
${SUDO} apt-get install -y ca-certificates curl git

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | ${SUDO} sh
fi

echo "==> Starting Docker"
${SUDO} systemctl enable --now docker

INSTALL_DIR="/opt/sitey"
REPO_URL="https://github.com/ubershmekel/sitey.git"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "==> Updating Sitey repo"
  ${SUDO} git -C "${INSTALL_DIR}" pull --ff-only
else
  echo "==> Cloning Sitey repo"
  ${SUDO} rm -rf "${INSTALL_DIR}"
  ${SUDO} git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

${SUDO} mkdir -p "${INSTALL_DIR}/data"
${SUDO} chown -R "${RUN_AS_USER}:${RUN_AS_USER}" "${INSTALL_DIR}"

cd "${INSTALL_DIR}/deploy"

PUBLIC_IP="$(curl -4fsSL https://api.ipify.org || true)"
if [[ -z "${PUBLIC_IP}" ]]; then
  PUBLIC_IP="$(hostname -I | awk '{print $1}')"
fi
if [[ -z "${PUBLIC_IP}" ]]; then
  echo "Could not determine public IP."
  exit 1
fi

SITEY_URL="http://${PUBLIC_IP}"

touch .env
set_env_key "DATA_ROOT" "/opt/sitey/data" ".env"
set_env_key "SITEY_URL" "${SITEY_URL}" ".env"

USE_SUDO_DOCKER=0
if ! docker info >/dev/null 2>&1; then
  USE_SUDO_DOCKER=1
fi

docker_cmd() {
  if [[ "${USE_SUDO_DOCKER}" -eq 1 ]]; then
    ${SUDO} docker "$@"
  else
    docker "$@"
  fi
}

echo "==> Building and starting Sitey"
docker_cmd compose up -d --build

echo "==> Waiting for API container"
for _ in $(seq 1 60); do
  if docker_cmd compose exec -T sitey-api sh -lc "node -v" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Generating admin override password"
PASS_OUTPUT="$(docker_cmd compose exec -T sitey-api node --enable-source-maps dist/services/bootstrap.js init)"
ADMIN_PASSWORD="$(printf "%s\n" "${PASS_OUTPUT}" | sed -n 's/.*Password: \([^[:space:]]\+\).*/\1/p' | head -n1)"

echo
echo "Sitey installed."
echo "URL: ${SITEY_URL}"
if [[ -n "${ADMIN_PASSWORD}" ]]; then
  echo "Admin password: ${ADMIN_PASSWORD}"
else
  echo "Admin password: not parsed cleanly; raw output follows:"
  printf "%s\n" "${PASS_OUTPUT}"
fi
