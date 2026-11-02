#!/usr/bin/env bash
# Generate a temporary DHT11 workspace and compile it with the same IDF environment
# as the reference baseline. The reference tree is not modified.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Generated output matches repositoryPaths().firmwareRoot + "/out".
OUT="${IOTEDU_WORKSPACE:-$ROOT/node-data/firmware/out/dht11-node}"
LOG="${IOTEDU_BUILD_LOG:-$ROOT/node-data/firmware/out/modular-build.log}"

# shellcheck disable=SC1091
source "$ROOT/scripts/idf_env.sh"

npx tsx "$ROOT/scripts/generate_dht11_workspace.ts" "$OUT"

rm -rf "$OUT/build"
mkdir -p "$(dirname "$LOG")"
IDF_PY=(python "$IDF_PATH/tools/idf.py")

{
  echo "start=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "IDF_PATH=$IDF_PATH"
  echo "ESP_MATTER_PATH=$ESP_MATTER_PATH"
  echo "workspace=$OUT"
  "${IDF_PY[@]}" --version
  cd "$OUT"
  "${IDF_PY[@]}" set-target esp32h2
  "${IDF_PY[@]}" build
  echo "end=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "RESULT=success"
} 2>&1 | tee "$LOG"
