#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

echo "[linux-check] root: $ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[linux-check] FAIL: node not found"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[linux-check] FAIL: npm not found"
  exit 1
fi

echo "[linux-check] node: $(node -v)"
echo "[linux-check] npm : $(npm -v)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[linux-check] FAIL: .env not found"
  exit 1
fi

echo "[linux-check] .env exists"

API_KEY_VAL="$(grep -E '^API_KEY=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
if [[ -z "${API_KEY_VAL// }" ]]; then
  echo "[linux-check] FAIL: API_KEY is empty in .env"
  exit 1
fi

echo "[linux-check] API_KEY configured"

NAPCAT_VAL="$(grep -E '^NAPCAT_WS_URL=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
if [[ -z "${NAPCAT_VAL// }" ]]; then
  echo "[linux-check] WARN: NAPCAT_WS_URL not set, fallback from config will be used"
else
  echo "[linux-check] NAPCAT_WS_URL=$NAPCAT_VAL"
fi

NAPCAT_TOKEN_VAL="$(grep -E '^NAPCAT_WS_TOKEN=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
if [[ -n "${NAPCAT_TOKEN_VAL// }" ]]; then
  echo "[linux-check] NAPCAT_WS_TOKEN is configured"
fi

SUBAGENT_ENABLED_VAL="$(grep -E '^SUBAGENT_ENABLED=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
if [[ "${SUBAGENT_ENABLED_VAL,,}" == "true" ]]; then
  SUBAGENT_COMMAND_VAL="$(grep -E '^SUBAGENT_COMMAND=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
  SUBAGENT_WORKDIR_VAL="$(grep -E '^SUBAGENT_WORKDIR=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"
  SUBAGENT_ARGS_VAL="$(grep -E '^SUBAGENT_ARGS=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)"

  if [[ -z "${SUBAGENT_COMMAND_VAL// }" ]]; then
    echo "[linux-check] FAIL: SUBAGENT_ENABLED=true but SUBAGENT_COMMAND is empty"
    exit 1
  fi

  if [[ -z "${SUBAGENT_WORKDIR_VAL// }" ]]; then
    echo "[linux-check] FAIL: SUBAGENT_ENABLED=true but SUBAGENT_WORKDIR is empty"
    exit 1
  fi

  if [[ -z "${SUBAGENT_ARGS_VAL// }" ]]; then
    echo "[linux-check] FAIL: SUBAGENT_ENABLED=true but SUBAGENT_ARGS is empty"
    exit 1
  fi

  echo "[linux-check] SUBAGENT bridge is enabled"
fi

cd "$ROOT_DIR"

node -c config.js
node -c index.js
node -c web/server.js
node -c api/ai.js
node -c core/tickEngine.js

echo "[linux-check] syntax check passed"

if npm run -s check:agent:static; then
  echo "[linux-check] static agent check passed"
else
  echo "[linux-check] WARN: static agent check failed"
fi

echo "[linux-check] done"
