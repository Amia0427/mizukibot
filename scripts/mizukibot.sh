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

find_worker_pid_by_process_scan() {
  local pid
  pid="$(pgrep -f "$ROOT_DIR/.*/post-reply-worker\\.js|$ROOT_DIR/scripts/post-reply-worker\\.js|node .*scripts/post-reply-worker\\.js" 2>/dev/null | awk -v self="$$" '$1 != self { print $1; exit }' || true)"
  if [[ -n "$pid" ]] && [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  fi
}

repair_worker_pid_file_if_running() {
  local pid
  pid="$(find_worker_pid_by_process_scan)"
  if [[ -n "$pid" ]]; then
    echo "$pid" > "$WORKER_PID_FILE"
    return 0
  fi
  return 1
}

list_child_tree_pids() {
  local root_pid="$1"
  local child
  if [[ -z "$root_pid" ]] || ! [[ "$root_pid" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  for child in $(pgrep -P "$root_pid" 2>/dev/null || true); do
    list_child_tree_pids "$child"
    echo "$child"
  done
}

stop_pid_tree() {
  local root_pid="$1"
  local label="${2:-process}"
  if [[ -z "$root_pid" ]] || ! [[ "$root_pid" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  local children
  children="$(list_child_tree_pids "$root_pid" | awk '!seen[$0]++' || true)"
  if [[ -n "$children" ]]; then
    echo "[mizukibot] stopping ${label} children: $(echo "$children" | tr '\n' ' ')"
    while IFS= read -r child_pid; do
      [[ -z "$child_pid" || "$child_pid" == "$$" ]] && continue
      kill "$child_pid" 2>/dev/null || true
    done <<< "$children"
  fi

  if [[ "$root_pid" != "$$" ]]; then
    echo "[mizukibot] stopping ${label} pid=$root_pid"
    kill "$root_pid" 2>/dev/null || true
  fi

  for _ in {1..15}; do
    local alive=0
    if kill -0 "$root_pid" 2>/dev/null; then
      alive=1
    fi
    while IFS= read -r child_pid; do
      [[ -z "$child_pid" ]] && continue
      if kill -0 "$child_pid" 2>/dev/null; then
        alive=1
        break
      fi
    done <<< "$children"
    if [[ "$alive" -eq 0 ]]; then
      return 0
    fi
    sleep 1
  done

  if [[ -n "$children" ]]; then
    echo "[mizukibot] force killing ${label} children"
    while IFS= read -r child_pid; do
      [[ -z "$child_pid" || "$child_pid" == "$$" ]] && continue
      kill -9 "$child_pid" 2>/dev/null || true
    done <<< "$children"
  fi
  if [[ "$root_pid" != "$$" ]] && kill -0 "$root_pid" 2>/dev/null; then
    echo "[mizukibot] force killing ${label} pid=$root_pid"
    kill -9 "$root_pid" 2>/dev/null || true
  fi
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
    if repair_worker_pid_file_if_running; then
      :
    else
      nohup node scripts/post-reply-worker.js >>"$WORKER_LOG_FILE" 2>&1 &
      echo $! > "$WORKER_PID_FILE"
    fi
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

  stop_pid_tree "$pid" "main"

  rm -f "$PID_FILE"
  if is_worker_running; then
    local worker_pid
    worker_pid="$(cat "$WORKER_PID_FILE")"
    stop_pid_tree "$worker_pid" "post-reply worker"
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
