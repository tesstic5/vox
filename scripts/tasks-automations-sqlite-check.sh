#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d /tmp/voxera-task-auto-sqlite.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cd "$root"
VOXERA_STORE=sqlite VOXERA_DATA_DIR="$tmp" ./node_modules/.bin/tsx scripts/tasks-automations-check.ts
VOXERA_DB_PATH="$tmp/voxera-db.sqlite" ./node_modules/.bin/tsx scripts/tasks-automations-sqlite-check.ts
