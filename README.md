# IoT.Edu

A local desktop hub for managing **ESP32-H2 Matter-over-Thread** sensor nodes.

IoT.Edu runs on your own computer. It lets you:

- keep a list of your nodes and their hardware details
- compose firmware from a catalogue of sensor and actuator components
- build that firmware with ESP-IDF and write it to a board over USB
- commission a node onto the **IoT.Edu Management** Matter fabric alongside Apple Home, Google Home or Alexa

It does **not** show sensor readings, control actuators, update devices over the air, or replace your smart-home app.

> **Status:** prototype. The desktop UI, local API and Matter controller work on macOS, Windows and Linux. An ESP32-H2 running IoT.Edu firmware 1.3.0 has been commissioned onto both Apple Home and the IoT.Edu management fabric. Firmware building and USB flashing work on **macOS**, are enabled on **Linux** but not yet verified on hardware, and are not yet available on **Windows**.

---

## How it fits together

```text
 Browser (React UI)  ──/api──▶  Local API (Fastify)  ──▶  Matter controller (matter.js)
 http://127.0.0.1:5173          http://127.0.0.1:3847 ──▶  Firmware builder (ESP-IDF, esptool)
                                                      ──▶  PostgreSQL catalogue (optional)
                                                      ──▶  Local data folder (node-data/data/)
```

Everything listens on `127.0.0.1` only. Nothing is exposed to your network except the Matter traffic needed to talk to your devices.

## Platform support

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Desktop UI and local API | ✅ | ✅ (x64 Node; also works on ARM64 PCs such as Snapdragon) | ✅ |
| Matter commissioning and node management | ✅ | ✅ | ✅ |
| Firmware build (ESP-IDF + esp-matter) | ✅ | ❌ not yet (planned: Docker build backend) | ⚠️ enabled, not yet verified on hardware |
| USB flashing | ✅ | ❌ not yet (planned: native esptool runner) | ⚠️ enabled, not yet verified on hardware |
| Serial ports recognised | `/dev/cu.usbmodem*`, `/dev/cu.usbserial*` and similar | `COM1`–`COM999` (detected; flashing not yet available) | `/dev/ttyACM*`, `/dev/ttyUSB*` |

Without the firmware toolchain, or on Windows, the app still runs. Build and flash features show as unavailable instead of failing.

## Requirements

- **Node.js 22.14 or newer** (22 LTS recommended). On Windows ARM64 PCs, install the **x64** build of Node so the `argon2` dependency can use its prebuilt binary.
- **Git**
- Optional: a **PostgreSQL** database for the component catalogue and sign-in (see [Database](#database-optional))
- Optional, macOS or Linux: **ESP-IDF v5.4.1** and **esp-matter** for building and flashing firmware (see [Firmware toolchain](#firmware-toolchain-optional-macos-and-linux))

## Quick start

### 1. Clone and install

```bash
git clone <this-repo-url> iotedu
cd iotedu
npm install
```

### 2. Create your configuration

Copy the example environment file:

```bash
# macOS / Linux
cp apps/local-api/.env.example apps/local-api/.env
```

```powershell
# Windows (PowerShell)
Copy-Item apps\local-api\.env.example apps\local-api\.env
```

Open `apps/local-api/.env` and set `IOTEDU_FIRMWARE_ARCHIVE` to a folder that exists, for example `~/iotedu-archive` or `C:\iotedu-archive`. Leave `DATABASE_URL` empty unless you are setting up a database.

`.env` holds your own settings and secrets. It is ignored by git. Never commit it.

### 3. Create the local data folder

IoT.Edu will not create its data folder automatically. This is deliberate: it stops the app from silently creating a new Matter identity if your real data folder goes missing. On a first install, create an empty one:

```bash
# macOS / Linux
mkdir -p node-data/data/application/firmware-library ~/iotedu-archive
echo '[]' > node-data/data/application/builds.json
echo '{"components":[]}' > node-data/data/application/firmware-library/index.json
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force node-data\data\application\firmware-library, C:\iotedu-archive | Out-Null
Set-Content node-data\data\application\builds.json '[]' -Encoding ascii
Set-Content node-data\data\application\firmware-library\index.json '{"components":[]}' -Encoding ascii
```

### 4. Run

```bash
npm run dev
```

Open **http://127.0.0.1:5173**. The API takes up to about 20 seconds to start, so the first page load may show connection errors until it is ready.

On Windows, if `npm run dev` fails, start the two halves in separate terminals:

```powershell
npm run dev -w @iotedu/local-api
npm run dev -w @iotedu/desktop-ui
```

When your firewall asks whether Node may use the network, allow it on **private networks only**. Matter needs this to discover your devices.

### 5. Check everything works

```bash
npm run typecheck
npm test
```

A few tests use the original developer's firmware archive. They skip themselves on machines that don't have it, so they show as passed. The database test is skipped unless a database is configured.

## Configuration

All settings go in `apps/local-api/.env`. A value set in your shell overrides the file.

| Variable | Required | Purpose |
|---|---|---|
| `IOTEDU_FIRMWARE_ARCHIVE` | Yes | Folder where finished firmware packages are archived. Must exist. |
| `DATABASE_URL` | No | PostgreSQL connection string. Enables the catalogue and sign-in. Use `sslmode=require` for hosted databases. |
| `NEON_BRANCH` | No | Label for the Neon branch in use. Informational. |
| `DATA_DIR` | No | Use a different local data folder instead of `node-data/data/application/`. |
| `PORT` | No | API port (default `3847`). |
| `MATTER_MODE` | No | `live` (default) or `mock`. Mock mode runs without real Matter networking, which is useful for trying the UI. |
| `AUTH_COOKIE_SECURE` | No | Set to `1` to mark session cookies `Secure` when serving over HTTPS. |
| `IDF_PATH`, `IDF_ACTIVATE`, `ESP_MATTER_PATH` | No | Firmware toolchain locations (macOS and Linux). |

The API always binds to `127.0.0.1` and refuses to start on any other address.

## Database (optional)

IoT.Edu uses PostgreSQL for two things:

- **Component catalogue:** component identifiers, revisions, source fingerprints and firmware-release records
- **Accounts:** sign-in and roles

The database never stores compiled firmware, Matter fabric credentials or commissioning codes. Those stay on your computer.

**Without a database**, sign-in is turned off and the catalogue is unavailable. The app is then usable by anyone on your computer, but not from other machines.

**To set one up**, create a PostgreSQL database (the project was developed against [Neon](https://neon.tech)) and put its connection string in `DATABASE_URL`. Then:

- **Accounts:** the account tables are created automatically on startup.
- **Catalogue:** apply the catalogue schema once:
  ```bash
  psql "$DATABASE_URL" -f apps/local-api/db/001_catalogue.sql
  psql "$DATABASE_URL" -f apps/local-api/db/002_firmware_releases.sql
  ```
- **First account:** the first account you register becomes the **administrator**. After that, self-registration is closed, and new accounts are created by an administrator.

## Firmware toolchain (optional, macOS and Linux)

Building and flashing need:

- **ESP-IDF v5.4.1.** Use exactly this version. Do not use a different minor version unless a later audit supersedes the pin in `toolchain.lock.json`.
- An **esp-matter** checkout that contains `connectedhomeip/connectedhomeip`.

```bash
export IDF_PATH=/path/to/esp-idf-v5.4.1
export ESP_MATTER_PATH=/path/to/esp-matter
export IDF_ACTIVATE=/path/to/activate_idf_v5.4.1.sh   # only for installs made with Espressif EIM
./scripts/baseline_build.sh
```

`$IDF_PATH/export.sh` is the standard way to activate ESP-IDF. Installs made with Espressif's EIM tool need `IDF_ACTIVATE` instead.

**On Linux**, your user also needs permission to open serial ports. On Debian and Ubuntu, add yourself to the `dialout` group, then log out and back in:

```bash
sudo usermod -aG dialout "$USER"
```

Other distributions may use a different group, such as `uucp` on Arch.

Keep the toolchain and any checkout of this repository on a path **without spaces**. ESP-IDF does not support them.

Build trees (`build/`, `sdkconfig`, `managed_components/`) and logs under `node-data/firmware/out/` are ignored by git.

## Repository layout

```text
iotedu/
├── apps/
│   ├── desktop-ui/        React + Vite interface (port 5173)
│   └── local-api/         Fastify API (port 3847), database schema and migrations
├── packages/
│   ├── contracts/         Shared types and validation schemas
│   ├── catalog/           Component catalogue reader
│   ├── firmware-builder/  ESP-IDF build, Matter OTA image packaging, USB programming,
│   │                      and platform.ts: the one place that handles OS differences
│   └── matter-controller/ matter.js controller for the IoT.Edu Management fabric
├── node-data/
│   ├── board-profiles/        Board definitions (ESP32-H2)
│   ├── catalogue/components/  Editable sensor and actuator source
│   ├── component-manifests/   Component metadata
│   ├── firmware/              Firmware template and shared core component
│   └── data/                  YOUR LOCAL DATA: ignored by git (see below)
├── scripts/               Build, flash and development helpers
├── tests/                 Python tests for the reference-firmware importer
└── toolchain.lock.json    Pinned toolchain versions
```

## Your local data

`node-data/data/application/` holds:

- your Matter controller identity, **including the fabric's private root key**
- your node records
- build history and programming-session history

It is ignored by git and must never be committed or shared. Anyone with the root key can control the devices on your IoT.Edu fabric. To move to another computer, copy this folder privately, for example on a USB drive. Do not move it through a repository.

## Security

- The API binds to `127.0.0.1` only and rejects requests whose `Host` header is not `127.0.0.1` or `localhost`. This protects against DNS-rebinding attacks.
- Cross-origin requests are rejected, except from the local UI.
- Passwords are hashed with Argon2. Sessions use `HttpOnly`, `SameSite=Lax` cookies.
- Toolchain commands go through an allowlisted script. eFuse writes are blocked entirely, and a full flash erase needs explicit confirmation.
- Pairing codes are redacted from API errors and logs.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the trust boundaries and how controller credentials are stored.

## Known limitations

- **Windows:** firmware building and USB flashing are not available yet. The toolchain scripts need bash, and esp-matter does not support native Windows. COM ports are detected, and the app reports build and flash as unavailable.
- **Linux:** building and flashing are enabled but have not yet been verified on real hardware. Please open an issue with your results.
- **Board identification:** detecting which port is an ESP32-H2, as opposed to listing it, currently uses macOS's USB information only.
- On Windows, the combined `npm run dev` may fail. Start the API and UI separately, as shown above.
- `hardwareVerified` remains `false`. The modular DHT11 firmware compiles but has not been fully verified on hardware.

## Contributing: platform-specific code

All operating-system differences live in `packages/firmware-builder/src/platform.ts`: serial-port names and listing, process cancellation, and whether the toolchain is supported. Other code calls this module and does not check `process.platform` itself.

Every function there takes the platform as a parameter, so its tests (`platform.test.ts`) cover macOS, Windows and Linux on any machine. When adding OS-specific behaviour, add it there with a test for each platform.

`.gitattributes` keeps shell and Python scripts with LF line endings. Don't override it, or bash will fail on checkouts made from Windows.

## Roadmap

1. ~~Platform module: per-OS serial ports and cancellation; Linux build and flash~~ ✅
2. Windows flashing: run esptool directly from TypeScript, with the same safety rules as the current script
3. Building on every OS: a Docker build backend using a pinned esp-matter image

## Not planned for the initial release

GitHub catalogue sync, a cloud backend, a mobile app, a custom Thread Border Router, sensor dashboards, and production Matter certification.