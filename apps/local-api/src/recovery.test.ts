import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBootHeader, encodePartitionTable } from "@iotedu/firmware-builder/recovery";
import type { FlashIo } from "@iotedu/firmware-builder/programmer";
import type { BuildJob } from "@iotedu/contracts";
import { componentManifestDir } from "@iotedu/contracts/paths";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, readBoardProfile } from "./app.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const port = "/dev/cu.usbmodem143401";
const consolePort = "/dev/cu.usbmodem5AF61108281";
const mac = "48:31:b7:cf:3d:52";
const security = [
  "SECURE_BOOT_EN (BLOCK0) = False R/W (0b0)",
  "SPI_BOOT_CRYPT_CNT (BLOCK0) = 0 R/W (0b000)",
  "DIS_DOWNLOAD_MODE (BLOCK0) = False R/W (0b0)",
  "DIS_USB_JTAG (BLOCK0) = False R/W (0b0)",
].join("\n");

const partitions = [
  { name: "esp_secure_cert", type: 0x3f, subtype: 0x06, offset: 0xd000, size: 0x2000 },
  { name: "nvs", type: 0x01, subtype: 0x02, offset: 0x10000, size: 0xc000 },
  { name: "nvs_keys", type: 0x01, subtype: 0x04, offset: 0x1c000, size: 0x1000 },
  { name: "otadata", type: 0x01, subtype: 0x00, offset: 0x1d000, size: 0x2000 },
  { name: "phy_init", type: 0x01, subtype: 0x01, offset: 0x1f000, size: 0x1000 },
  { name: "ota_0", type: 0x00, subtype: 0x10, offset: 0x20000, size: 0x1e0000 },
  { name: "ota_1", type: 0x00, subtype: 0x11, offset: 0x200000, size: 0x1e0000 },
  { name: "fctry", type: 0x01, subtype: 0x02, offset: 0x3e0000, size: 0x6000 },
];

const closers: Array<{ close: () => Promise<void> }> = [];

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function slice(image: Buffer, offset: number, size: number): Buffer {
  const out = Buffer.alloc(size, 0xff);
  if (offset >= image.length) return out;
  const end = Math.min(offset + size, image.length);
  image.copy(out, 0, offset, end);
  return out;
}

async function packageOnDisk(dataDir: string): Promise<void> {
  const directory = path.join(dataDir, "pkg");
  await mkdir(directory, { recursive: true });
  const bootloader = encodeBootHeader({ mode: 2, speed: 0xf, size: 2 });
  const table = Buffer.from("partition-table");
  const otadata = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const application = encodeBootHeader({ mode: 2, speed: 0xf, size: 2 });
  const merged = Buffer.alloc(0x20000 + application.length, 0xff);
  merged.set(bootloader, 0);
  merged.set(table, 0xc000);
  merged.set(otadata, 0x1d000);
  merged.set(application, 0x20000);
  const flasher = {
    write_flash_args: ["--flash_mode", "dio", "--flash_size", "4MB", "--flash_freq", "48m"],
    flash_files: {
      "0x0": "bootloader/bootloader.bin",
      "0xc000": "partition_table/partition-table.bin",
      "0x1d000": "ota_data_initial.bin",
      "0x20000": "sensors.bin",
    },
    extra_esptool_args: { chip: "esp32h2", before: "default_reset", after: "hard_reset" },
    bootloader: { encrypted: "false" },
    app: { encrypted: "false" },
    "partition-table": { encrypted: "false" },
    otadata: { encrypted: "false" },
  };
  const files: Record<string, Buffer> = {
    "bootloader.bin": bootloader,
    "partition-table.bin": table,
    "ota_data_initial.bin": otadata,
    "sensors.bin": application,
    "usb-image.bin": merged,
    "flasher_args.json": Buffer.from(`${JSON.stringify(flasher)}\n`),
    sdkconfig: Buffer.from("CONFIG_EXAMPLE_DAC_PROVIDER=y\n# CONFIG_SEC_CERT_DAC_PROVIDER is not set\n"),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes);
  const names = ["bootloader.bin", "sensors.bin", "partition-table.bin", "ota_data_initial.bin", "usb-image.bin", "flasher_args.json"];
  const now = "2026-10-23T00:00:00.000Z";
  const job: BuildJob = {
    id: "pkg",
    simulated: false,
    verification: "compiled",
    status: "succeeded",
    request: {
      mode: "native",
      codeSource: "approved",
      nodeId: null,
      hardware: "esp32h2",
      baseFirmwareId: "iotedu-core",
      componentIds: ["iotedu-dht11"],
      pins: [],
      softwareVersion: 4,
      softwareVersionString: "1.3.0",
      uploadId: null,
      confirm: true,
    },
    validation: { ok: true, issues: [] },
    logs: [],
    artifacts: names.map((name) => ({
      name,
      relativePath: path.join("pkg", name),
      sha256: hash(files[name]!),
      size: files[name]!.length,
      simulated: false,
      deployable: name === "sensors.bin",
    })),
    partitionLayoutId: "layout",
    durationMs: 1,
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([job]));
}

function device(): { io: FlashIo; calls: { erase: number } } {
  const calls = { erase: 0 };
  let erased = false;
  let chip = "ESP32-H2";
  let identity = mac;
  let fuses = security;
  let eraseCode = 0;
  let cancelled = false;
  let leaveByte = false;
  const image = Buffer.alloc(4 * 1024 * 1024, 0xff);
  image.set(encodeBootHeader({ mode: 2, speed: 0xf, size: 2 }), 0);
  image.set(encodePartitionTable(partitions), 0xc000);
  image.set(Buffer.from("factory-cert"), 0x3e0000);
  image.set(Buffer.from("operational-nvs"), 0x10000);
  const io: FlashIo = {
    async chip() {
      return { code: 0, text: `Chip is ${chip} (revision v0.1)\nMAC: ${identity}\n` };
    },
    async flash() {
      return { code: 0, text: "Detected flash size: 4MB\n" };
    },
    async security() {
      return { code: 0, text: fuses };
    },
    async read(_port, offset, size) {
      if (erased) {
        const blank = Buffer.alloc(size, 0xff);
        if (leaveByte) blank[0] = 0x11;
        return blank;
      }
      return slice(image, offset, size);
    },
    async erase() {
      calls.erase += 1;
      if (cancelled) return { code: 1, text: "", cancelled: true };
      if (eraseCode !== 0) return { code: eraseCode, text: "failed", cancelled: false };
      erased = true;
      return { code: 0, text: "erase finished", cancelled: false };
    },
  };
  return {
    io: Object.assign(io, {
      setChip(next: string) { chip = next; },
      setMac(next: string) { identity = next; },
      setFuses(next: string) { fuses = next; },
      failErase() { eraseCode = 2; },
      cancelErase() { cancelled = true; },
      leaveData() { leaveByte = true; },
    }),
    calls,
  };
}

async function start(io: FlashIo, nativeAvailable = true) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-recovery-"));
  const backupRoot = await mkdtemp(path.join(tmpdir(), "iotedu-backups-"));
  await packageOnDisk(dataDir);
  const app = await buildApp({
    dataDir,
    repoRoot,
    catalogDir: componentManifestDir(repoRoot),
    profile: await readBoardProfile(repoRoot),
    nativeAvailable,
    listPorts: async () => [port, consolePort],
    flashIo: io,
    backupRoot,
  });
  closers.push(app);
  return { app, dataDir };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((app) => app.close()));
});

describe("full flash erase API", () => {
  it("keeps erase disabled until a verified backup exists, then erases only after the MAC is confirmed", async () => {
    const hardware = device();
    const { app } = await start(hardware.io);
    const tools = await app.inject({ method: "GET", url: "/api/programmer/toolchain" });
    expect(tools.json().available).toBe(true);

    const before = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/assess",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(before.json().enabled).toBe(false);
    expect(before.json().blockers.some((item: { code: string }) => item.code === "backup_missing")).toBe(true);
    expect(before.json().security.reflashable).toBe(true);
    expect(before.json().device.mac).toBe(mac);
    expect(before.json().firmware.credentialMode).toBe("example_dac");
    expect(hardware.calls.erase).toBe(0);

    const saved = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/backup",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().verified).toBe(true);
    expect(saved.json().mac).toBe(mac);
    expect(saved.json().regions.find((region: { name: string }) => region.name === "fctry").state).toBe("present");
    const manifest = await readFile(path.join(saved.json().location, "manifest.json"), "utf8");
    expect(manifest).not.toContain("factory-cert");
    expect(manifest).not.toContain("operational-nvs");

    const ready = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/assess",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(ready.json().enabled).toBe(true);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/erase",
      payload: {
        port,
        consolePort,
        buildId: "pkg",
        backupId: saved.json().id,
        mac: "aa:bb:cc:dd:ee:ff",
        confirmDevice: true,
        confirmBackup: true,
        acknowledgeCommissioningLoss: true,
        confirm: true,
      },
    });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json().session.status).toBe("failed");
    expect(wrong.json().session.verifiedBlank).toBe(false);
    expect(hardware.calls.erase).toBe(0);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/erase",
      payload: {
        port,
        consolePort: port,
        buildId: "pkg",
        backupId: saved.json().id,
        mac,
        confirmDevice: true,
        confirmBackup: true,
        acknowledgeCommissioningLoss: true,
        confirm: true,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("port_conflict");

    const erased = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/erase",
      payload: {
        port,
        consolePort,
        buildId: "pkg",
        backupId: saved.json().id,
        mac,
        confirmDevice: true,
        confirmBackup: true,
        acknowledgeCommissioningLoss: true,
        confirm: true,
      },
    });
    expect(erased.statusCode).toBe(200);
    expect(erased.json().session.verifiedBlank).toBe(true);
    expect(erased.json().session.needsFirmware).toBe(true);
    expect(erased.json().session.hardwareVerified).toBe(false);
    expect(hardware.calls.erase).toBe(1);

    const plan = await app.inject({
      method: "POST",
      url: "/api/programmer/plan",
      payload: { buildId: "pkg", port },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().regions.map((region: { offset: string }) => region.offset)).toEqual(["0x0", "0xc000", "0x1d000", "0x20000"]);
    expect(plan.json().preserved).toContain("fctry");

    const exported = await app.inject({ method: "GET", url: `/api/programmer/recovery/backups/${saved.json().id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/x-tar");
    expect(exported.rawPayload.length).toBeGreaterThan(1000);
  });

  it("refuses the wrong chip, an enabled fuse, a failed erase, a dirty read-back, and an interrupted session", async () => {
    const hardware = device();
    const io = hardware.io as FlashIo & {
      setChip: (value: string) => void;
      setFuses: (value: string) => void;
      failErase: () => void;
      cancelErase: () => void;
      leaveData: () => void;
    };
    const { app, dataDir } = await start(io);
    io.setChip("ESP32-C6");
    const wrongChip = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/assess",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(wrongChip.json().enabled).toBe(false);
    expect(wrongChip.json().blockers.some((item: { code: string }) => item.code === "device_unidentified")).toBe(true);
    io.setChip("ESP32-H2");
    io.setFuses("SECURE_BOOT_EN (BLOCK0) = True\nSPI_BOOT_CRYPT_CNT (BLOCK0) = 0\nDIS_DOWNLOAD_MODE (BLOCK0) = False\nDIS_USB_JTAG (BLOCK0) = False\n");
    const locked = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/backup",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe("security_blocked");
    expect(hardware.calls.erase).toBe(0);

    io.setFuses(security);
    const saved = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/backup",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(saved.statusCode).toBe(200);
    const payload = {
      port,
      consolePort,
      buildId: "pkg",
      backupId: saved.json().id,
      mac,
      confirmDevice: true,
      confirmBackup: true,
      acknowledgeCommissioningLoss: true,
      confirm: true,
    };
    io.failErase();
    const failed = await app.inject({ method: "POST", url: "/api/programmer/recovery/erase", payload });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().session.status).toBe("failed");
    expect(failed.json().session.needsFirmware).toBe(false);
    expect(failed.json().session.verifiedBlank).toBe(false);

    io.failErase = () => undefined;
    (hardware.io as FlashIo & { failErase: () => void }).failErase = () => undefined;
    const dirtyHardware = device();
    const dirtyIo = dirtyHardware.io as FlashIo & { leaveData: () => void };
    const dirty = await start(dirtyIo);
    const dirtyBackup = await dirty.app.inject({
      method: "POST",
      url: "/api/programmer/recovery/backup",
      payload: { port, consolePort, buildId: "pkg" },
    });
    dirtyIo.leaveData();
    const dirtyErase = await dirty.app.inject({
      method: "POST",
      url: "/api/programmer/recovery/erase",
      payload: { ...payload, backupId: dirtyBackup.json().id },
    });
    expect(dirtyErase.json().session.status).toBe("failed");
    expect(dirtyErase.json().session.verifiedBlank).toBe(false);
    expect(dirtyErase.json().session.hardwareVerified).toBe(false);

    const cancelHardware = device();
    const cancelIo = cancelHardware.io as FlashIo & { cancelErase: () => void };
    const cancelled = await start(cancelIo);
    const cancelBackup = await cancelled.app.inject({
      method: "POST",
      url: "/api/programmer/recovery/backup",
      payload: { port, consolePort, buildId: "pkg" },
    });
    cancelIo.cancelErase();
    const cancelResult = await cancelled.app.inject({
      method: "POST",
      url: "/api/programmer/recovery/erase",
      payload: { ...payload, backupId: cancelBackup.json().id },
    });
    expect(cancelResult.json().session.status).toBe("interrupted");

    const orphan = {
      id: "orphan-erase",
      port,
      buildId: "pkg",
      backupId: "missing",
      mac,
      status: "running",
      verifiedBlank: false,
      needsFirmware: false,
      hardwareVerified: false,
      message: "Erasing flash.",
      createdAt: "2026-10-23T00:00:00.000Z",
      updatedAt: "2026-10-23T00:00:00.000Z",
    };
    await writeFile(path.join(dataDir, "erase-sessions.json"), JSON.stringify([orphan]));
    const reopened = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile: await readBoardProfile(repoRoot),
      nativeAvailable: true,
      listPorts: async () => [port],
      flashIo: device().io,
      backupRoot: await mkdtemp(path.join(tmpdir(), "iotedu-backups-")),
    });
    closers.push(reopened);
    const sessions = await reopened.inject({ method: "GET", url: "/api/programmer/recovery/sessions" });
    expect(sessions.json().sessions[0].status).toBe("interrupted");
    expect(sessions.json().sessions[0].needsFirmware).toBe(false);
  });

  it("does not contact a chip when the programming tools are unavailable", async () => {
    let calls = 0;
    const io: FlashIo = {
      async chip() { calls += 1; return { code: 1, text: "" }; },
      async flash() { calls += 1; return { code: 1, text: "" }; },
      async security() { calls += 1; return { code: 1, text: "" }; },
      async read() { calls += 1; return Buffer.alloc(0); },
      async erase() { calls += 1; return { code: 1, text: "", cancelled: false }; },
    };
    const { app } = await start(io, false);
    const body = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/assess",
      payload: { port, consolePort, buildId: "pkg" },
    });
    expect(body.json().enabled).toBe(false);
    expect(body.json().toolchain.available).toBe(false);
    expect(calls).toBe(0);
  });
});
