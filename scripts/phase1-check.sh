#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
run_sqlite() {
  local script="$1"
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/voxera-phase1-XXXXXX")"
  trap 'rm -rf "$dir"' RETURN
  VOXERA_STORE=sqlite \
  VOXERA_DATA_DIR="$dir" \
  VOXERA_BLOB_ROOT="$dir/blobs" \
  VOXERA_DOCUMENT_MASTER_KEY="$KEY" \
  VOXERA_MALWARE_SCAN_COMMAND=/bin/true \
  VOXERA_MALWARE_SCAN_ARGS_JSON='["{file}"]' \
  VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE=1 \
  NODE_ENV=test \
  npx tsx "$script"
  rm -rf "$dir"
  trap - RETURN
}
run_sqlite scripts/phase1-clinical-foundation-check.ts
run_sqlite scripts/phase1-race-check.ts
run_sqlite scripts/document-scan-retry-check.ts
NODE_ENV=test npx tsx scripts/s3-blob-check.ts
