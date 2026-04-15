#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.mizukibot.pid"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/mizukibot.log"
ENV_FILE="$ROOT_DIR/.env"
SERVICE_NAME="mizukibot"
WORKER_SERVICE_NAME="mizukibot-postreply-worker"
WORKER_PID_FILE="$ROOT_DIR/.mizukibot-postreply-worker.pid"
WORKER_LOG_FILE="$LOG_DIR/postreply-worker.log"

mkdir -p "$LOG_DIR"

has_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi

  systemctl cat "${SERVICE_NAME}.service" >/dev/null 2>&1
}

has_systemd_worker_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi

  systemctl cat "${WORKER_SERVICE_NAME}.service" >/dev/null 2>&1
}

systemd_is_active() {
  systemctl --quiet is-active "$SERVICE_NAME"
}

systemd_worker_is_active() {
  systemctl --quiet is-active "$WORKER_SERVICE_NAME"
}

is_running() {
  if has_systemd_service; then
    systemd_is_active
    return $?
  fi

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

is_worker_running() {
  if has_systemd_worker_service; then
    systemd_worker_is_active
    return $?
  fi

  if [[ -f "$WORKER_PID_FILE" ]]; then
    local pid
    pid="$(cat "$WORKER_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_app() {
  if has_systemd_service; then
    echo "[mizukibot] systemd service detected, delegating to systemctl start ${SERVICE_NAME}"
    systemctl start "$SERVICE_NAME"
    if has_systemd_worker_service; then
      echo "[mizukibot] systemd worker detected, delegating to systemctl start ${WORKER_SERVICE_NAME}"
      systemctl start "$WORKER_SERVICE_NAME"
    fi
    return 0
  fi

  if is_running; then
    echo "[mizukibot] already running (pid=$(cat "$PID_FILE"))"
    exit 0
  fi

  cd "$ROOT_DIR"

  if [[ ! -f "$ENV_FILE" ]]; then
    echo "[mizukibot] .env not found. Copy .env.example to .env and fill API_KEY first."
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "[mizukibot] node not found in PATH"
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a

  nohup node index.js >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  if ! is_worker_running; then
    nohup node scripts/post-reply-worker.js >>"$WORKER_LOG_FILE" 2>&1 &
    echo $! > "$WORKER_PID_FILE"
  fi

  sleep 1
  if is_running; then
    echo "[mizukibot] started (pid=$(cat "$PID_FILE"))"
    echo "[mizukibot] logs: tail -f $LOG_FILE"
  else
    echo "[mizukibot] failed to start, check logs: $LOG_FILE"
    exit 1
  fi
}

stop_app() {
  if has_systemd_service; then
    echo "[mizukibot] systemd service detected, delegating to systemctl stop ${SERVICE_NAME}"
    systemctl stop "$SERVICE_NAME"
    if has_systemd_worker_service; then
      echo "[mizukibot] systemd worker detected, delegating to systemctl stop ${WORKER_SERVICE_NAME}"
      systemctl stop "$WORKER_SERVICE_NAME"
    fi
    rm -f "$PID_FILE"
    rm -f "$WORKER_PID_FILE"
    return 0
  fi

  if ! is_running; then
    echo "[mizukibot] not running"
    rm -f "$PID_FILE"
    exit 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"

  echo "[mizukibot] stopping pid=$pid"
  kill "$pid" 2>/dev/null || true

  for _ in {1..15}; do
    if kill -0 "$pid" 2>/dev/null; then
      sleep 1
    else
      break
    fi
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "[mizukibot] force killing pid=$pid"
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  if is_worker_running; then
    local worker_pid
    worker_pid="$(cat "$WORKER_PID_FILE")"
    echo "[mizukibot] stopping post-reply worker pid=$worker_pid"
    kill "$worker_pid" 2>/dev/null || true
    for _ in {1..15}; do
      if kill -0 "$worker_pid" 2>/dev/null; then
        sleep 1
      else
        break
      fi
    done
    if kill -0 "$worker_pid" 2>/dev/null; then
      echo "[mizukibot] force killing post-reply worker pid=$worker_pid"
      kill -9 "$worker_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$WORKER_PID_FILE"
  echo "[mizukibot] stopped"
}

status_app() {
  if has_systemd_service; then
    if systemd_is_active; then
      echo "[mizukibot] systemd service is active"
    else
      echo "[mizukibot] systemd service is not active"
      systemctl status "$SERVICE_NAME" --no-pager || true
      return 1
    fi
    if has_systemd_worker_service; then
      if systemd_worker_is_active; then
        echo "[mizukibot] post-reply worker service is active"
      else
        echo "[mizukibot] post-reply worker service is not active"
        systemctl status "$WORKER_SERVICE_NAME" --no-pager || true
      fi
    fi
    return 0
  fi

  if is_running; then
    echo "[mizukibot] running (pid=$(cat "$PID_FILE"))"
  else
    echo "[mizukibot] not running"
  fi
  if is_worker_running; then
    echo "[mizukibot] post-reply worker running (pid=$(cat "$WORKER_PID_FILE"))"
  else
    echo "[mizukibot] post-reply worker not running"
  fi
}

logs_app() {
  if has_systemd_service; then
    journalctl -u "$SERVICE_NAME" -n 80 -f
    return 0
  fi

  touch "$LOG_FILE"
  tail -n 80 -f "$LOG_FILE"
}

case "${1:-}" in
  start)
    start_app
    ;;
  stop)
    stop_app
    ;;
  restart)
    stop_app
    start_app
    ;;
  status)
    status_app
    ;;
  logs)
    logs_app
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
