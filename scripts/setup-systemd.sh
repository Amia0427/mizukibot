#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="mizukibot"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
WORKER_SERVICE_NAME="mizukibot-postreply-worker"
WORKER_SERVICE_FILE="/etc/systemd/system/${WORKER_SERVICE_NAME}.service"
USER_NAME="${SUDO_USER:-$USER}"
ENV_FILE="$ROOT_DIR/.env"

if [[ "$EUID" -ne 0 ]]; then
  echo "[setup-systemd] please run with sudo: sudo bash scripts/setup-systemd.sh"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[setup-systemd] missing .env: $ENV_FILE"
  exit 1
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=MizukiBot Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $ROOT_DIR/index.js
ExecStartPost=/bin/sh -c 'echo \$MAINPID > $ROOT_DIR/.mizukibot.pid'
ExecStopPost=/bin/rm -f $ROOT_DIR/.mizukibot.pid $ROOT_DIR/.mizukibot.lock
SuccessExitStatus=143 SIGTERM
Restart=always
RestartSec=3
User=$USER_NAME
StandardOutput=append:$ROOT_DIR/logs/mizukibot.log
StandardError=append:$ROOT_DIR/logs/mizukibot.log

[Install]
WantedBy=multi-user.target
EOF

cat > "$WORKER_SERVICE_FILE" <<EOF
[Unit]
Description=MizukiBot Post Reply Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $ROOT_DIR/scripts/post-reply-worker.js
ExecStartPost=/bin/sh -c 'echo \$MAINPID > $ROOT_DIR/.mizukibot-postreply-worker.pid'
ExecStopPost=/bin/rm -f $ROOT_DIR/.mizukibot-postreply-worker.pid
SuccessExitStatus=143 SIGTERM
Restart=always
RestartSec=3
User=$USER_NAME
StandardOutput=append:$ROOT_DIR/logs/postreply-worker.log
StandardError=append:$ROOT_DIR/logs/postreply-worker.log

[Install]
WantedBy=multi-user.target
EOF

mkdir -p "$ROOT_DIR/logs"
chown -R "$USER_NAME":"$USER_NAME" "$ROOT_DIR/logs" || true

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl enable "$WORKER_SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl restart "$WORKER_SERVICE_NAME"

echo "[setup-systemd] installed: $SERVICE_FILE"
echo "[setup-systemd] installed: $WORKER_SERVICE_FILE"
echo "[setup-systemd] status: systemctl status $SERVICE_NAME --no-pager"
echo "[setup-systemd] worker status: systemctl status $WORKER_SERVICE_NAME --no-pager"
echo "[setup-systemd] logs  : journalctl -u $SERVICE_NAME -f"
echo "[setup-systemd] worker logs: journalctl -u $WORKER_SERVICE_NAME -f"
