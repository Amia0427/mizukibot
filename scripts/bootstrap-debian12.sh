#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[bootstrap-debian12] Linux only"
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "[bootstrap-debian12] please run as root"
  exit 1
fi

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
else
  echo "[bootstrap-debian12] /etc/os-release not found"
  exit 1
fi

if [[ "${ID:-}" != "debian" || "${VERSION_ID:-}" != "12" ]]; then
  echo "[bootstrap-debian12] target system is ${PRETTY_NAME:-unknown}, script is tuned for Debian 12"
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg unzip python3 python3-venv python3-pip build-essential

install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi

cat > /etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main
EOF

apt-get update
apt-get install -y nodejs

echo "[bootstrap-debian12] node: $(node -v)"
echo "[bootstrap-debian12] npm : $(npm -v)"
echo "[bootstrap-debian12] python3: $(python3 --version)"
