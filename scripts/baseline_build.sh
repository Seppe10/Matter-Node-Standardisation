#!/usr/bin/env bash
# Attempt a native baseline compile of the imported reference firmware.
# Paths come from environment variables. Do not hard-code a home directory.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Generated output matches repositoryPaths().firmwareRoot + "/out".
PROJECT="${IOTEDU_WORKSPACE:-$ROOT/node-data/firmware/out/baseline}"
LOG="${IOTEDU_BUILD_LOG:-$ROOT/node-data/firmware/out/baseline-build.log}"

if [[ -z "${IDF_PATH:-}" ]]; then
  echo "IDF_PATH is not set" >&2
  exit 2
fi
if [[ -z "${ESP_MATTER_PATH:-}" ]]; then
  echo "ESP_MATTER_PATH is not set" >&2
  exit 2
fi
if [[ ! -f "$IDF_PATH/tools/idf.py" ]]; then
  echo "IDF_PATH does not contain tools/idf.py: $IDF_PATH" >&2
  exit 2
fi
# shellcheck disable=SC1091
source "$ROOT/scripts/idf_env.sh"

# The template is not a build directory. Generate an isolated workspace, then compile that copy.
npx tsx "$ROOT/scripts/generate_dht11_workspace.ts" "$PROJECT"
rm -rf "$PROJECT/build"
mkdir -p "$(dirname "$LOG")"

IDF_PY=(python "$IDF_PATH/tools/idf.py")

{
  echo "start=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "IDF_PATH=$IDF_PATH"
  echo "ESP_MATTER_PATH=$ESP_MATTER_PATH"
  echo "IDF_PYTHON_ENV_PATH=${IDF_PYTHON_ENV_PATH:-}"
  "${IDF_PY[@]}" --version
  cd "$PROJECT"
  "${IDF_PY[@]}" set-target esp32h2
  "${IDF_PY[@]}" build
  echo "end=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "RESULT=success"
} 2>&1 | tee "$LOG"
