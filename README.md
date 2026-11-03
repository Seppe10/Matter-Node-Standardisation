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
                                                      ──▶  PostgreSQL (optional: accounts, saved Node Types)
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
- Optional: a hosted **PostgreSQL** database, for accounts and saved Node Types. Without one, IoT.Edu runs in **local mode** (see [Database](#database-optional)).
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

The defaults work as they are: the firmware archive goes in `iotedu-archive` in your home folder, and with `DATABASE_URL` left empty IoT.Edu runs in **local mode** with no sign-in. You can change either later.

`.env` holds your own settings and secrets. It is ignored by git. Never commit it.

### 3. Create the local data folder

```bash
# macOS / Linux
mkdir -p node-data/data/application/firmware-library ~/iotedu-archive
echo '[]' > node-data/data/application/builds.json
echo '{"components":[]}' > node-data/data/application/firmware-library/index.json
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force node-data\data\application\firmware-library, "$HOME\iotedu-archive" | Out-Null
Set-Content node-data\data\application\builds.json '[]' -Encoding ascii
Set-Content node-data\data\application\firmware-library\index.json '{"components":[]}' -Encoding ascii
```

### 4. Run

**macOS/Linux**

```bash
npm run dev
```
**Windows:** start the two halves in separate terminals (the single `npm run dev` command doesn't work on Windows yet):

```powershell
npm run dev -w @iotedu/local-api
```
```powershell
npm run dev -w @iotedu/desktop-ui
```

Open **http://127.0.0.1:5173**. The API takes up to about 20 seconds to start, so the first page load may show "Unable to connect" until it is ready. Click **Try again**.

In local mode you go straight to the Overview page, with no sign-in.

When your firewall asks whether Node may use the network, allow it on **private networks only**. Matter needs this to discover your devices.

### 5. Create the management identity

Before you can pair a node, IoT.Edu needs its own Matter identity: the "IoT.Edu Management" fabric.

1. Open **Settings**.
2. Next to **Controller identity**, click **Create management identity**, and confirm.

This is done once per installation, and needs a network connection. Afterwards, **back up** `node-data/data/application/matter-controller/` somewhere private. If it is lost, every node paired to this identity has to be paired again. IoT.Edu never replaces an identity automatically.

### 6. Check everything works

```bash
npm run typecheck
npm test
```

A few tests use the original developer's firmware archive. They skip themselves on machines that don't have it, so they show as passed. The database test is skipped unless a database is configured.

## Configuration

All settings go in `apps/local-api/.env`. A value set in your shell overrides the file.

| Variable | Required | Purpose |
|---|---|---|
| `IOTEDU_FIRMWARE_ARCHIVE` | Yes | Folder where finished firmware packages are archived. Must exist. `~/` is allowed. |
| `DATABASE_URL` | No | PostgreSQL connection string. Empty means local mode. See [Database](#database-optional). |
| `NEON_BRANCH` | No | Label for the Neon branch in use. Informational. |
| `DATA_DIR` | No | Use a different local data folder instead of `node-data/data/application/`. `~/` is allowed. |
| `PORT` | No | API port (default `3847`). |
| `MATTER_MODE` | No | `live` (default) or `mock`. Mock mode runs without real Matter networking, which is useful for trying the UI. It never creates a management identity. |
| `AUTH_COOKIE_SECURE` | No | Set to `1` to mark session cookies `Secure` when serving over HTTPS. |
| `IDF_PATH`, `IDF_ACTIVATE`, `ESP_MATTER_PATH` | No | Firmware toolchain locations (macOS and Linux). |

The API always binds to `127.0.0.1` and refuses to start on any other address.

## Database (optional)

IoT.Edu works without a database. A database adds accounts, and lets you save Node Types and firmware release records.

| | Local mode (default, no database) | With a database |
|---|---|---|
| Sign-in | None. The person using this computer is the administrator, as with any desktop app. | Accounts and roles. The first account becomes the administrator. |
| Nodes, pairing, Matter identity, build and USB history | ✅ stored in `node-data/data/` | ✅ the same, still stored locally |
| Component library | ✅ read from the repository's files | ✅ stored in the database, starting with the repository's components |
| Saving Node Types and release records | ❌ needs a database | ✅ |

The database never stores compiled firmware, Matter fabric credentials or commissioning codes. Those stay on your computer.

### Adding a database later

Nothing needs to be migrated. Local mode stores nothing that the database replaces.

1. **Create a PostgreSQL database that accepts TLS connections with a trusted certificate.** Hosted services such as [Neon](https://neon.tech) (free tier available), Supabase or Amazon RDS do this. The project was developed against Neon. A default local PostgreSQL install, which has no trusted certificate, is **not supported**: IoT.Edu always verifies the server's certificate.
2. Put the connection string in `apps/local-api/.env`, for example:
   ```text
   DATABASE_URL=postgresql://user:password@your-host/dbname?sslmode=require
   ```
3. Set the database up. This creates the tables and adds the starter components that ship in this repository. It is safe to run more than once.
   ```bash
   npm run db:setup
   ```
4. Restart IoT.Edu (`Ctrl+C` in its terminal, the restart it with the command from step 4). You now see a sign-in page. Choose **Create account**: the first account becomes the **administrator**. After that, self-registration is closed, and an administrator creates further accounts.

The starter components appear in the Firmware Library as **waiting for validation**. Validating them, and building Node Types from them, needs the [firmware toolchain](#firmware-toolchain-optional-macos-and-linux).

To go back to local mode, empty `DATABASE_URL` and restart. Nothing in the database is deleted.

## Firmware toolchain (optional, macOS and Linux)

You only need this to build firmware and write it to a board. Everything else works without it, and the app shows building and flashing as unavailable until it is installed.

Building and flashing need:

- **ESP-IDF v5.4.1.** Use exactly this version. Do not use a different minor version unless a later audit supersedes the pin in `toolchain.lock.json`.
- **esp-matter** at the revision pinned in `toolchain.lock.json`.

Together they need several GB of disk space, and the first install takes a while. Keep both, and this repository, on a path **without spaces**: ESP-IDF does not support them.

### 1. Install the prerequisites

Follow Espressif's prerequisite steps for your OS:

- [ESP-IDF prerequisites](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/linux-macos-setup.html): Python, CMake, Ninja and similar. On macOS this includes the Xcode Command Line Tools.
- [Matter prerequisites](https://github.com/project-chip/connectedhomeip/tree/master/docs/guides/BUILDING.md#prerequisites): extra build packages that esp-matter needs.

### 2. Install ESP-IDF v5.4.1

```bash
mkdir -p ~/esp && cd ~/esp
git clone -b v5.4.1 --recursive https://github.com/espressif/esp-idf.git esp-idf-v5.4.1
cd esp-idf-v5.4.1
./install.sh esp32h2
source ./export.sh
```

### 3. Install esp-matter at the pinned revision

Run this in the same terminal, with ESP-IDF activated by the previous step:

```bash
cd ~/esp
git clone https://github.com/espressif/esp-matter.git
cd esp-matter
git checkout 2cb668c95de4f24786d20b7cb03c171d6e27b79e   # "observedRevision" in toolchain.lock.json
git submodule update --init --depth 1
cd connectedhomeip/connectedhomeip
./scripts/checkout_submodules.py --platform esp32 linux --shallow    # on macOS: --platform esp32 darwin
cd ../..
./install.sh
```

These steps follow esp-matter's own setup guide for that revision. If one fails, check its `docs/en/developing.rst`.

### 4. Tell IoT.Edu where they are

Add the paths to `apps/local-api/.env`, then restart IoT.Edu:

```text
IDF_PATH=~/esp/esp-idf-v5.4.1
ESP_MATTER_PATH=~/esp/esp-matter
```

IoT.Edu activates ESP-IDF with `$IDF_PATH/export.sh`. If you installed ESP-IDF with Espressif's **EIM** installer instead, also set `IDF_ACTIVATE` to its `activate_idf_v5.4.1.sh` script.

Check it worked: **Settings** should show `IDF_PATH` and `ESP_MATTER_PATH` as configured, and the build mode as `native`.

To build the baseline firmware from a terminal instead:

```bash
export IDF_PATH=~/esp/esp-idf-v5.4.1 ESP_MATTER_PATH=~/esp/esp-matter
./scripts/baseline_build.sh
```

**On Linux**, your user also needs permission to open serial ports. On Debian and Ubuntu, add yourself to the `dialout` group, then log out and back in:

```bash
sudo usermod -aG dialout "$USER"
```

Other distributions may use a different group, such as `uucp` on Arch.

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
- **Local mode** (no database) has no sign-in. Anyone using this computer can use IoT.Edu, as with any desktop app. The protections above still apply, so other computers and websites cannot reach it. If several people share the computer and need separate access, [add a database](#database-optional).
- With a database, passwords are hashed with Argon2, and sessions use `HttpOnly`, `SameSite=Lax` cookies.
- Toolchain commands go through an allowlisted script. eFuse writes are blocked entirely, and a full flash erase needs explicit confirmation.
- Pairing codes are redacted from API errors and logs.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the trust boundaries and how controller credentials are stored.

## Known limitations

- **Windows:** firmware building and USB flashing are not available yet. The toolchain scripts need bash, and esp-matter does not support native Windows. COM ports are detected, and the app reports build and flash as unavailable.
- **Linux:** building and flashing are enabled but have not yet been verified on real hardware. Please open an issue with your results.
- **Board identification:** detecting which port is an ESP32-H2, as opposed to listing it, currently uses macOS's USB information only.
- **Database:** a default local PostgreSQL install is not supported, because IoT.Edu always verifies the server's TLS certificate. Use a hosted PostgreSQL service.
- **Starter catalogue:** the RGB component's source in the starter catalogue is `rgb_led.cpp`. The original catalogue import used a host-application snapshot, which is not in this repository.
- `hardwareVerified` remains `false`. The modular DHT11 firmware compiles but has not been fully verified on hardware.

## Contributing: platform-specific code

All operating-system differences live in `packages/firmware-builder/src/platform.ts`: serial-port names and listing, process cancellation, and whether the toolchain is supported. Other code calls this module and does not check `process.platform` itself.

Every function there takes the platform as a parameter, so its tests (`platform.test.ts`) cover macOS, Windows and Linux on any machine. When adding OS-specific behaviour, add it there with a test for each platform.

`.gitattributes` keeps shell and Python scripts with LF line endings. Don't override it, or bash will fail on checkouts made from Windows.

## Roadmap

1. ~~Platform module: per-OS serial ports and cancellation; Linux build and flash~~ ✅
2. ~~Local mode by default, optional database with `npm run db:setup`~~ ✅
3. Windows flashing: run esptool directly from TypeScript, with the same safety rules as the current script
4. Building on every OS: a Docker build backend using a pinned esp-matter image

## Not planned for the initial release

GitHub catalogue sync, a cloud backend, a mobile app, a custom Thread Border Router, sensor dashboards, and production Matter certification.