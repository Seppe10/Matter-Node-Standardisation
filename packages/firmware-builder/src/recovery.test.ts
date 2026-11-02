import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverToolchain } from "./index.js";
import {
  assessEraseReadiness,
  createFlashBackup,
  credentialMode,
  encodeBootHeader,
  encodePartitionTable,
  loadBackup,
  parseBootHeader,
  parseDeviceEvidence,
  parsePartitionTable,
  parseSecuritySummary,
  samplesAreBlank,
  type DeviceEvidence,
  type PackageReadiness,
} from "./recovery.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SAFE = [
  "SECURE_BOOT_EN (BLOCK0) = False R/W (0b0)",
  "SPI_BOOT_CRYPT_CNT (BLOCK0) = 0 R/W (0b000)",
  "DIS_DOWNLOAD_MODE (BLOCK0) = False R/W (0b0)",
  "DIS_USB_JTAG (BLOCK0) = False R/W (0b0)",
].join("\n");

const rows = [
  { name: "esp_secure_cert", type: 0x3f, subtype: 0x06, offset: 0x100, size: 16 },
  { name: "nvs", type: 0x01, subtype: 0x02, offset: 0x200, size: 16 },
  { name: "fctry", type: 0x01, subtype: 0x02, offset: 0x300, size: 16 },
];

function evidence(overrides: Partial<DeviceEvidence> = {}): DeviceEvidence {
  return {
    chip: "ESP32-H2",
    revision: "v0.1",
    mac: "48:31:b7:cf:3d:52",
    flashSizeBytes: 1024,
    flashMode: "dio",
    flashFrequency: "48m",
    partitions: rows,
    security: parseSecuritySummary(SAFE),
    bootloaderCompatible: true,
    ...overrides,
  };
}

function readyPackage(overrides: Partial<PackageReadiness> = {}): PackageReadiness {
  return {
    ready: true,
    buildId: "pkg",
    detail: "The four-image package matches ESP32-H2 and embeds example Device Attestation Credentials.",
    credentialMode: "example_dac",
    issues: [],
    ...overrides,
  };
}

function image(): Buffer {
  const bytes = Buffer.alloc(1024, 0xff);
  bytes.set(Buffer.from("unique-factory"), 0x300);
  bytes.set(Buffer.from("matter-nvs-data"), 0x200);
  bytes.set(Buffer.from("private key: secret"), 0x120);
  return bytes;
}

describe("flash recovery", () => {
  it("reads security from the eFuse summary and ignores a disabled sdkconfig", () => {
    expect(parseSecuritySummary(SAFE).reflashable).toBe(true);
    expect(parseSecuritySummary("# CONFIG_SECURE_BOOT is not set\n# CONFIG_FLASH_ENCRYPTION_ENABLED is not set").reflashable).toBe(false);
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = True R/W (0b1)\nSPI_BOOT_CRYPT_CNT (BLOCK0) = 0\nDIS_DOWNLOAD_MODE (BLOCK0) = False\nDIS_USB_JTAG (BLOCK0) = False").secureBoot).toBe("enabled");
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = 1\nDIS_DOWNLOAD_MODE (BLOCK0) = False\nDIS_USB_JTAG (BLOCK0) = False").flashEncryption).toBe("enabled");
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = 0\nDIS_DOWNLOAD_MODE (BLOCK0) = True\nDIS_USB_JTAG (BLOCK0) = False").downloadMode).toBe("disabled");
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = 0\nDIS_DOWNLOAD_MODE (BLOCK0) = False").usbDownload).toBe("unknown");
    const espefuse = [
      "SECURE_BOOT_EN (BLOCK0)                               Represents whether secure boot is enabled or = False R/W (0b0)",
      "SPI_BOOT_CRYPT_CNT (BLOCK0)                           Enables flash encryption when 1 or 3 bits are = Disable R/W (0b000)",
      "DIS_DOWNLOAD_MODE (BLOCK0)                            Represents whether download mode is disabled = False R/W (0b0)",
      "DIS_USB_JTAG (BLOCK0)                                 Represents whether USB JTAG is disabled      = False R/W (0b0)",
    ].join("\n");
    expect(parseSecuritySummary(espefuse)).toMatchObject({
      secureBoot: "disabled",
      flashEncryption: "disabled",
      downloadMode: "allowed",
      usbDownload: "allowed",
      known: true,
      reflashable: true,
    });
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = Disable R/W (0b011)\nDIS_DOWNLOAD_MODE (BLOCK0) = False\nDIS_USB_JTAG (BLOCK0) = False").flashEncryption).toBe("disabled");
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = Enable R/W (0b001)\nDIS_DOWNLOAD_MODE (BLOCK0) = False\nDIS_USB_JTAG (BLOCK0) = False").flashEncryption).toBe("enabled");
    expect(parseSecuritySummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = 3\nDIS_DOWNLOAD_MODE (BLOCK0) = False\nDIS_USB_JTAG (BLOCK0) = False").flashEncryption).toBe("disabled");
  });

  it("parses the connected chip, image header, and the device partition table", () => {
    const header = encodeBootHeader({ mode: 2, speed: 0xf, size: 2 });
    expect(parseBootHeader(header)).toMatchObject({ mode: "dio", frequency: "48m", compatible: true, chipId: 16 });
    const table = encodePartitionTable(rows);
    const parsed = parseDeviceEvidence({
      chipText: "Chip is ESP32-H2 (revision v0.1)\nMAC: 48:31:b7:ff:fe:cf:3d:52\nBASE MAC: 48:31:b7:cf:3d:52\nMAC_EXT: ff:fe\n",
      flashText: "Detected flash size: 4MB\n",
      securityText: SAFE,
      partitionTable: table,
      bootHeader: header,
    });
    expect(parsed.chip).toBe("ESP32-H2");
    expect(parsed.mac).toBe("48:31:b7:cf:3d:52");
    expect(parsed.flashSizeBytes).toBe(4 * 1024 * 1024);
    expect(parsed.partitions?.map((row) => row.name)).toEqual(["esp_secure_cert", "nvs", "fctry"]);
    expect(parsed.partitions?.map((row) => row.offset)).toEqual([0x100, 0x200, 0x300]);
    expect(parsePartitionTable(Buffer.from("not a table"))).toBeNull();
    expect(parseDeviceEvidence({
      chipText: "Chip is ESP32-C6 (revision v0.2)\nMAC: aa:bb:cc:dd:ee:ff\n",
      flashText: "Detected flash size: 4MB\n",
      securityText: SAFE,
      partitionTable: table,
      bootHeader: header,
    }).chip).toBe("ESP32-C6");
  });

  it("distinguishes example credentials from a secure-cert package", () => {
    expect(credentialMode("CONFIG_EXAMPLE_DAC_PROVIDER=y\n# CONFIG_SEC_CERT_DAC_PROVIDER is not set\n")).toBe("example_dac");
    expect(credentialMode("CONFIG_SEC_CERT_DAC_PROVIDER=y\n")).toBe("secure_cert");
    expect(credentialMode(null)).toBe("unknown");
  });

  it("creates a verified backup for the device MAC and rejects a tampered copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "iotedu-backup-"));
    const device = evidence();
    const record = await createFlashBackup({
      evidence: device,
      packageReady: readyPackage(),
      backupRoot: root,
      buildId: "pkg",
      image: image(),
      now: "2026-10-23T00:00:00.000Z",
    });
    expect(record.verified).toBe(true);
    expect(record.mac).toBe(device.mac);
    expect(record.complete).toBe(true);
    expect(record.regions.find((region) => region.name === "fctry")).toMatchObject({ offset: 0x300, state: "present", classification: "factory" });
    expect(record.regions.find((region) => region.name === "nvs")?.classification).toBe("operational");
    const manifest = await readFile(path.join(record.location, "manifest.json"), "utf8");
    expect(manifest).not.toContain("secret");
    expect(manifest).not.toContain("unique-factory");
    const loaded = await loadBackup(record.location);
    expect(loaded?.verified).toBe(true);
    const flash = await readFile(path.join(record.location, "flash.bin"));
    flash.writeUInt8(flash.readUInt8(0x300) ^ 0xff, 0x300);
    await writeFile(path.join(record.location, "flash.bin"), flash);
    expect((await loadBackup(record.location))?.verified).toBe(false);
  });

  it("enables erase only when identity, fuses, backup, package, and tools agree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "iotedu-ready-"));
    const device = evidence();
    const backup = await createFlashBackup({
      evidence: device,
      packageReady: readyPackage(),
      backupRoot: root,
      buildId: "pkg",
      image: image(),
    });
    const base = {
      portConnected: true,
      port: "/dev/cu.usbmodem143401",
      consolePort: "/dev/cu.usbmodem5AF61108281",
      toolchainAvailable: true,
      toolchainDetail: "ESP-IDF v5.4.1 was discovered for this application.",
      evidence: device,
      backup,
      packageReady: readyPackage(),
      previouslyCommissioned: true,
    };
    expect(assessEraseReadiness(base).enabled).toBe(true);
    expect(assessEraseReadiness(base).previouslyCommissionedBlocksErase).toBe(false);
    expect(assessEraseReadiness({ ...base, portConnected: false, port: null }).blockers.some((item) => item.code === "device_disconnected")).toBe(true);
    expect(assessEraseReadiness({ ...base, evidence: evidence({ chip: "ESP32-C6", mac: null }) }).enabled).toBe(false);
    expect(assessEraseReadiness({ ...base, evidence: evidence({ security: parseSecuritySummary("") }) }).blockers.some((item) => item.code === "security_unknown")).toBe(true);
    expect(assessEraseReadiness({ ...base, backup: null }).blockers.some((item) => item.code === "backup_missing")).toBe(true);
    expect(assessEraseReadiness({ ...base, backup: { ...backup, mac: "aa:bb:cc:dd:ee:ff" } }).enabled).toBe(false);
    expect(assessEraseReadiness({ ...base, consolePort: base.port }).blockers.some((item) => item.code === "port_conflict")).toBe(true);
    expect(assessEraseReadiness({ ...base, toolchainAvailable: false }).enabled).toBe(false);
    const shifted = evidence({
      partitions: rows.map((row) => row.name === "fctry" ? { ...row, offset: 0x3f0000 } : row),
      flashSizeBytes: 0x400000,
    });
    expect(assessEraseReadiness({ ...base, evidence: shifted, backup }).blockers.some((item) => item.code === "backup_incomplete" || item.code === "backup_missing")).toBe(true);
    const secure = readyPackage({
      ready: false,
      credentialMode: "secure_cert",
      issues: [{ code: "secure_cert_required", message: "needs the secure-cert partition", action: "Choose another package." }],
    });
    expect(assessEraseReadiness({ ...base, packageReady: secure }).enabled).toBe(false);
    expect(samplesAreBlank([Buffer.from([0xff, 0xff])])).toBe(true);
    expect(samplesAreBlank([Buffer.from([0xff, 0x00])])).toBe(false);
    expect(samplesAreBlank([])).toBe(false);
  });

  it("discovers ESP-IDF v5.4.1 without requiring the variables to be exported", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "iotedu-idf-"));
    const idf = path.join(home, ".espressif", "v5.4.1", "esp-idf");
    await mkdir(path.join(idf, "tools", "cmake"), { recursive: true });
    await writeFile(path.join(idf, "tools", "idf.py"), "# idf\n");
    await writeFile(path.join(idf, "tools", "cmake", "version.cmake"), "set(IDF_VERSION_MAJOR 5)\nset(IDF_VERSION_MINOR 4)\nset(IDF_VERSION_PATCH 1)\n");
    await mkdir(path.join(home, "esp", "esp-matter", "components"), { recursive: true });
    await mkdir(path.join(home, ".espressif", "tools"), { recursive: true });
    const activate = path.join(home, ".espressif", "tools", "activate_idf_v5.4.1.sh");
    await writeFile(activate, "# activate\n");
    const discovered = await discoverToolchain({}, home, "darwin");
    expect(discovered.nativeAvailable).toBe(true);
    expect(discovered.source).toBe("discovered");
    expect(discovered.childEnv.IDF_PATH).toBe(idf);
    expect(discovered.childEnv.ESP_MATTER_PATH).toBe(path.join(home, "esp", "esp-matter"));
    expect(discovered.childEnv.IDF_ACTIVATE).toBe(activate);
    const missing = await discoverToolchain({}, path.join(home, "empty"), "darwin");
    expect(missing.nativeAvailable).toBe(false);
    expect(missing.programmingAvailable).toBe(false);
    expect(missing.programmingCode).toBe("toolchain_not_installed");
    const programmingOnly = path.join(home, "programming-only");
    const idfOnly = path.join(programmingOnly, ".espressif", "v5.4.1", "esp-idf");
    await mkdir(path.join(idfOnly, "tools", "cmake"), { recursive: true });
    await writeFile(path.join(idfOnly, "tools", "idf.py"), "# idf\n");
    await writeFile(path.join(idfOnly, "tools", "cmake", "version.cmake"), "set(IDF_VERSION_MAJOR 5)\nset(IDF_VERSION_MINOR 4)\nset(IDF_VERSION_PATCH 1)\n");
    await mkdir(path.join(programmingOnly, ".espressif", "tools"), { recursive: true });
    const activateOnly = path.join(programmingOnly, ".espressif", "tools", "activate_idf_v5.4.1.sh");
    await writeFile(activateOnly, "# activate\n");
    const toolsOnly = await discoverToolchain({}, programmingOnly, "darwin");
    expect(toolsOnly.programmingAvailable).toBe(true);
    expect(toolsOnly.nativeAvailable).toBe(false);
    expect(toolsOnly.programmingCode).toBe("ok");
    expect(toolsOnly.detail).toMatch(/Chip identification does not need it/);
    const script = await readFile(path.join(repoRoot, "scripts/idf_exec.sh"), "utf8");
    expect(script).toContain("--before usb_reset --after no_reset chip_id");
    expect(script).toContain("tool-check");
    expect(script).toContain("erase-flash");
    expect(script).toContain("security-info");
    expect(script).toContain("eFuse changes are not permitted");
    expect(script).not.toContain("burn_efuse");
    expect(script).not.toContain("espefuse burn");
  });
});
