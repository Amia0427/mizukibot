#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[linux-install] project root: $ROOT_DIR"

ensure_runtime_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return 0
  fi

  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=("curl")
  command -v unzip >/dev/null 2>&1 || missing+=("unzip")
  command -v python3 >/dev/null 2>&1 || missing+=("python3")

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return 0
  fi

  if [[ "$EUID" -ne 0 ]]; then
    echo "[linux-install] WARN: missing runtime packages: ${missing[*]}"
    echo "[linux-install] Debian 12 建议先执行: sudo apt-get update && sudo apt-get install -y ${missing[*]}"
    return 0
  fi

  echo "[linux-install] installing runtime packages via apt-get: ${missing[*]}"
  apt-get update
  apt-get install -y "${missing[@]}"
}

install_node_if_missing() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$EUID" -ne 0 ]]; then
    echo "[linux-install] Node.js/npm not found. On Debian 12 run as root:"
    echo "[linux-install]   bash scripts/bootstrap-debian12.sh"
    exit 1
  fi

  echo "[linux-install] Node.js/npm missing, bootstrapping Node.js 20 LTS for Debian 12"
  bash "$ROOT_DIR/scripts/bootstrap-debian12.sh"
}

ensure_runtime_packages
install_node_if_missing

NODE_VER="$(node -v)"
NPM_VER="$(npm -v)"
echo "[linux-install] node: $NODE_VER"
echo "[linux-install] npm : $NPM_VER"

cd "$ROOT_DIR"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "[linux-install] .env created from .env.example"
  echo "[linux-install] Please edit .env and set API_KEY / NAPCAT_WS_URL / WEB_TOKEN before start"
fi

if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

mkdir -p "$ROOT_DIR/logs"
chmod +x "$ROOT_DIR/scripts/bootstrap-debian12.sh" || true
chmod +x "$ROOT_DIR/scripts/mizukibot.sh" || true
chmod +x "$ROOT_DIR/scripts/check-linux.sh" || true
chmod +x "$ROOT_DIR/scripts/setup-systemd.sh" || true

echo "[linux-install] done"
echo "[linux-install] next steps:"
echo "  1) edit .env (API_KEY / NAPCAT_WS_URL / WEB_TOKEN)"
echo "  2) npm run linux:check"
echo "  3) npm run linux:start"
