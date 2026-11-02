#!/usr/bin/env bash
# Run one allowlisted toolchain command with the ESP-IDF v5.4.1 environment.
# Arguments are passed to exec. They are not interpolated into a shell string.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/idf_env.sh"

valid_port() {
  case "$1" in
    /dev/cu.usbmodem*|/dev/cu.usbserial*|/dev/cu.wchusbserial*|/dev/cu.SLAB_USBtoUART*|/dev/ttyACM[0-9]*|/dev/ttyUSB[0-9]*)
      ;;
    *)
      echo "rejected serial port" >&2
      exit 2
      ;;
  esac
  case "$1" in
    *..*|*[!A-Za-z0-9._/-]*)
      echo "rejected serial port" >&2
      exit 2
      ;;
  esac
}

require_matter() {
  if [[ -z "${ESP_MATTER_PATH:-}" || ! -d "$ESP_MATTER_PATH/components" ]]; then
    echo "ESP_MATTER_PATH is not set to an esp-matter checkout" >&2
    exit 2
  fi
}

cmd="${1:-}"
shift || true

case "$cmd" in
  tool-check)
    exec python -c 'import esptool; print(esptool.__version__)'
    ;;
  idf)
    require_matter
    exec python "$IDF_PATH/tools/idf.py" "$@"
    ;;
  ota-create)
    require_matter
    if [[ $# -ne 6 ]]; then
      echo "ota-create expects vendor product version version-string input output" >&2
      exit 2
    fi
    exec python "$ESP_MATTER_PATH/connectedhomeip/connectedhomeip/src/app/ota_image_tool.py" create \
      -v "$1" -p "$2" -vn "$3" -vs "$4" -da sha256 "$5" "$6"
    ;;
  ota-show)
    require_matter
    if [[ $# -ne 1 ]]; then
      echo "ota-show expects one image path" >&2
      exit 2
    fi
    exec python "$ESP_MATTER_PATH/connectedhomeip/connectedhomeip/src/app/ota_image_tool.py" show "$1"
    ;;
  merge-bin)
    exec python -m esptool --chip esp32h2 merge_bin "$@"
    ;;
  chip-id)
    valid_port "${1:-}"
    # USB Serial/JTAG uses the usb_reset sequence. Leave the ROM in download mode
    # so a following flash read does not reset the interface again.
    exec python -m esptool --chip esp32h2 --port "$1" --before usb_reset --after no_reset chip_id
    ;;
  flash-id)
    valid_port "${1:-}"
    before="usb_reset"
    if [[ "${2:-}" == "--stay" ]]; then
      before="no_reset"
    fi
    exec python -m esptool --chip esp32h2 --port "$1" --before "$before" --after no_reset flash_id
    ;;
  security-info)
    if [[ $# -ne 1 ]]; then
      echo "security-info accepts only a serial port" >&2
      exit 2
    fi
    valid_port "$1"
    case "$*" in
      *burn*)
        echo "eFuse changes are not permitted" >&2
        exit 2
        ;;
    esac
    exec python -m espefuse --chip esp32h2 --port "$1" summary
    ;;
  read-flash)
    if [[ $# -ne 4 ]]; then
      echo "read-flash expects port offset size output" >&2
      exit 2
    fi
    valid_port "$1"
    case "$2" in
      0x[0-9a-fA-F]*) ;;
      *) echo "rejected flash offset" >&2; exit 2 ;;
    esac
    case "$3" in
      0x[0-9a-fA-F]*) ;;
      *) echo "rejected flash size" >&2; exit 2 ;;
    esac
    case "$4" in
      /tmp/*|/private/tmp/*|/var/folders/*) ;;
      *) echo "read output path rejected" >&2; exit 2 ;;
    esac
    case "$4" in
      *..*) echo "read output path rejected" >&2; exit 2 ;;
    esac
    exec python -m esptool --chip esp32h2 --port "$1" --before default_reset --after no_reset read_flash "$2" "$3" "$4"
    ;;
  erase-flash)
    valid_port "${1:-}"
    if [[ "${2:-}" != "--confirm-blank" || $# -ne 2 ]]; then
      echo "erase requires an explicit confirmation flag" >&2
      exit 2
    fi
    exec python -m esptool --chip esp32h2 --port "$1" --before default_reset --after no_reset erase_flash
    ;;
  write-flash)
    port=""
    prev=""
    saw_write=0
    for arg in "$@"; do
      case "$arg" in
        --erase-all|--erase-flash|erase_flash|erase_region|--force)
          echo "erase is not permitted" >&2
          exit 2
          ;;
        write_flash)
          saw_write=1
          ;;
      esac
      if [[ "$prev" == "--port" || "$prev" == "-p" ]]; then
        port="$arg"
      fi
      prev="$arg"
    done
    if [[ "$saw_write" -ne 1 ]]; then
      echo "only write_flash is permitted" >&2
      exit 2
    fi
    valid_port "$port"
    exec python -m esptool --chip esp32h2 "$@"
    ;;
  app-reset)
    valid_port "${1:-}"
    # Connect, then leave the ROM and start the application. This does not erase flash or NVS.
    exec python -m esptool --chip esp32h2 --port "$1" --after hard_reset run
    ;;
  monitor)
    valid_port "${1:-}"
    if [[ "${2:-}" != "115200" ]]; then
      echo "unsupported baud" >&2
      exit 2
    fi
    exec python "$ROOT/scripts/serial_read.py" "$1" "$2"
    ;;
  *)
    echo "unsupported toolchain command" >&2
    exit 2
    ;;
esac
