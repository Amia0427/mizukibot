#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/_dist"
STAMP="$(date +%Y%m%d_%H%M%S)"
PACK_NAME="mizukibot_linux_migration_${STAMP}"
STAGE_DIR="$OUT_DIR/$PACK_NAME"
ARCHIVE_PATH="$OUT_DIR/${PACK_NAME}.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

copy_item() {
  local src="$1"
  if [[ -e "$ROOT_DIR/$src" ]]; then
    cp -R "$ROOT_DIR/$src" "$STAGE_DIR/"
  fi
}

copy_item api
copy_item core
copy_item data
copy_item deploy
copy_item prompts
copy_item scripts
copy_item tests
copy_item utils
copy_item web
copy_item package.json
copy_item package-lock.json
copy_item index.js
copy_item config
copy_item .env.example
copy_item README.md
copy_item README_PORTABLE.md
copy_item .gitignore

rm -rf "$STAGE_DIR/node_modules" "$STAGE_DIR/logs"
rm -f "$STAGE_DIR/.env"

tar -czf "$ARCHIVE_PATH" -C "$OUT_DIR" "$PACK_NAME"

echo "[pack-linux-migration] created: $ARCHIVE_PATH"
