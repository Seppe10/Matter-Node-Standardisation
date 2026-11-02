import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildJob } from "@iotedu/contracts";
import { describe, expect, it } from "vitest";
import { loadReferenceLayout, type BoardProfile } from "./index.js";
import {
  buildWritePlan,
  chipConnectionFailure,
  chipProbeAccepted,
  filterSerialPortNames,
  flashProgressPercent,
  isAllowedSerialPort,
  packageProgrammingBlock,
  flashImagesFromPlan,
  parseFlashImages,
  readAppElfSha256,
  redactSerialLog,
  probeChip,
  runUsbWrite,
  applicationBootSeen,
  bootCaptureMessage,
  bootListenSettled,
  bootResultMessage,
  firmwareConsole,
  installationSummary,
  startupChecks,
  writeDiagnostic,
  type FlashArguments,
  type ToolExecutor,
} from "./programmer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const profile: BoardProfile = {
  id: "esp32h2-devkitm-1",
  target: "esp32h2",
  gpioMin: 0,
  gpioMax: 27,
  reservedGpio: [],
  flashSizeBytes: 4 * 1024 * 1024,
  bootloaderOffset: 0,
  partitionTableOffset: 0xc000,
};

function job(overrides: Partial<BuildJob> = {}): BuildJob {
  const names = ["bootloader.bin", "sensors.bin", "partition-table.bin", "ota_data_initial.bin", "usb-image.bin", "flasher_args.json"];
  return {
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
      softwareVersion: 3,
      softwareVersionString: "1.2.0",
      uploadId: null,
      confirm: true,
    },
    validation: { ok: true, issues: [] },
    logs: [],
    artifacts: names.map((name) => ({
      name,
      relativePath: name,
      sha256: "abc",
      size: 1,
      simulated: false,
      deployable: false,
    })),
    partitionLayoutId: "layout",
    durationMs: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

function flasher(): FlashArguments {
  return {
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
}

async function samplePlan() {
  const bootloader = Buffer.from("boot");
  const table = Buffer.from("table");
  const otadata = Buffer.from("ota");
  const app = Buffer.from("app-image");
  const merged = Buffer.alloc(0x20000 + app.length, 0xff);
  merged.set(bootloader, 0);
  merged.set(table, 0xc000);
  merged.set(otadata, 0x1d000);
  merged.set(app, 0x20000);
  merged[0x10000] = 0x5a;
  const dir = await mkdtemp(path.join(tmpdir(), "iotedu-plan-"));
  const layout = await loadReferenceLayout(repoRoot, profile);
  const plan = buildWritePlan({
    flasher: flasher(),
    artifactDir: dir,
    port: "/dev/cu.usbmodem1101",
    partitions: layout.partitions,
    bootloaderOffset: profile.bootloaderOffset,
    partitionTableOffset: profile.partitionTableOffset,
    flashSizeBytes: profile.flashSizeBytes,
    files: {
      "bootloader.bin": bootloader,
      "partition-table.bin": table,
      "ota_data_initial.bin": otadata,
      "sensors.bin": app,
      "usb-image.bin": merged,
    },
  });
  return { plan, dir, app };
}

describe("USB programmer", () => {
  it("accepts a compiled package and rejects a simulated one", () => {
    expect(packageProgrammingBlock(job())).toBeNull();
    const simulated = packageProgrammingBlock(job({ simulated: true, verification: "simulated", status: "simulated" }));
    expect(simulated?.code).toBe("simulated_package");
    expect(packageProgrammingBlock(job({ status: "failed", verification: null }))?.code).toBe("package_not_compiled");
  });

  it("accepts only a local macOS USB device path", () => {
    expect(isAllowedSerialPort("/dev/cu.usbmodem1101")).toBe(true);
    expect(isAllowedSerialPort("/dev/cu.usbserial-1410")).toBe(true);
    expect(isAllowedSerialPort("/dev/cu.wchusbserial110")).toBe(true);
    expect(isAllowedSerialPort("/dev/cu.SLAB_USBtoUART")).toBe(true);
    expect(isAllowedSerialPort("/dev/tty.usbmodem1101")).toBe(false);
    expect(isAllowedSerialPort("/tmp/cu.usbmodem1101")).toBe(false);
    expect(isAllowedSerialPort("/dev/cu.usbmodem1101;reboot")).toBe(false);
    expect(isAllowedSerialPort("/dev/cu.usbmodem1101/../../etc/passwd")).toBe(false);
    expect(filterSerialPortNames(["cu.usbmodem1101", "cu.Bluetooth-Incoming-Port", "tty.usbmodem1101"], "darwin")).toEqual([
      "/dev/cu.usbmodem1101",
    ]);
  });

  it("builds a write from package metadata without erase or the merged image", async () => {
    const { plan, dir } = await samplePlan();
    expect(plan.ok, plan.issues.map((item) => item.message).join("; ")).toBe(true);
    expect(plan.args[0]).toBe("write-flash");
    expect(plan.args).toContain("/dev/cu.usbmodem1101");
    expect(plan.args).toEqual(expect.arrayContaining(["0x0", "0xc000", "0x1d000", "0x20000", "write_flash"]));
    expect(plan.args.some((arg) => arg.endsWith("usb-image.bin"))).toBe(false);
    expect(plan.args.some((arg) => /erase/i.test(arg))).toBe(false);
    expect(plan.args).not.toContain("0x10000");
    expect(plan.args).toContain(path.join(dir, "sensors.bin"));
  });

  it("reinstalls firmware while preserving NVS and does not claim commissioning was cleared", async () => {
    const { plan } = await samplePlan();
    expect(plan.ok).toBe(true);
    expect(plan.args.some((arg) => /erase/i.test(arg))).toBe(false);
    expect(plan.args).not.toContain("0x10000");
    expect(plan.issues.map((item) => item.message).join(" ")).not.toMatch(/commissioning|factory reset|nvs erased/i);
  });

  it("rejects an erase flag, an NVS overlap, and a merged image that does not match", async () => {
    const { plan } = await samplePlan();
    expect(plan.ok).toBe(true);
    const layout = await loadReferenceLayout(repoRoot, profile);
    const erased = buildWritePlan({
      flasher: { ...flasher(), write_flash_args: ["--flash_mode", "dio", "--flash_size", "4MB", "--flash_freq", "48m", "--erase-all"] },
      artifactDir: "/tmp/pkg",
      port: "/dev/cu.usbmodem1101",
      partitions: layout.partitions,
      bootloaderOffset: 0,
      partitionTableOffset: 0xc000,
      flashSizeBytes: profile.flashSizeBytes,
      files: {},
    });
    expect(erased.ok).toBe(false);
    expect(erased.args).toEqual([]);
    expect(erased.issues.some((item) => item.code === "erase_rejected")).toBe(true);

    const bootloader = Buffer.alloc(0x12000, 1);
    const overlapping = buildWritePlan({
      flasher: flasher(),
      artifactDir: "/tmp/pkg",
      port: "/dev/cu.usbmodem1101",
      partitions: layout.partitions,
      bootloaderOffset: 0,
      partitionTableOffset: 0xc000,
      flashSizeBytes: profile.flashSizeBytes,
      files: {
        "bootloader.bin": bootloader,
        "partition-table.bin": Buffer.from("table"),
        "ota_data_initial.bin": Buffer.from("ota"),
        "sensors.bin": Buffer.from("app"),
        "usb-image.bin": Buffer.alloc(0x21000, 0xff),
      },
    });
    expect(overlapping.issues.some((item) => item.code === "protected_partition")).toBe(true);

    const merged = Buffer.alloc(0x20010, 0xff);
    const mismatch = buildWritePlan({
      flasher: flasher(),
      artifactDir: "/tmp/pkg",
      port: "/dev/cu.usbmodem1101",
      partitions: layout.partitions,
      bootloaderOffset: 0,
      partitionTableOffset: 0xc000,
      flashSizeBytes: profile.flashSizeBytes,
      files: {
        "bootloader.bin": Buffer.from("boot"),
        "partition-table.bin": Buffer.from("table"),
        "ota_data_initial.bin": Buffer.from("ota"),
        "sensors.bin": Buffer.from("app"),
        "usb-image.bin": merged,
      },
    });
    expect(mismatch.issues.some((item) => item.code === "merged_image_mismatch")).toBe(true);
  });

  it("reports progress and a disconnected-port diagnostic", () => {
    expect(flashProgressPercent("Writing at 0x00020000... (40 %)")).toBe(40);
    expect(flashProgressPercent("done")).toBeNull();
    expect(writeDiagnostic("could not open port /dev/cu.usbmodem1101", false)).toMatch(/could not be opened/);
    expect(writeDiagnostic("", true)).toMatch(/timed out/);
  });

  it("redacts pairing material and does not treat a sensor line as commissioning", () => {
    const raw = "Advertise commission parameter vendorID=65521 productID=32768 discriminator=3840/00 passcode: 20202021";
    const redacted = redactSerialLog(`payload MT:Y.ABCDEF ${raw} manual 3497-011-2332`);
    expect(redacted).not.toContain("MT:Y");
    expect(redacted).not.toContain("20202021");
    expect(redacted).toContain("discriminator=3840/00");
    expect(redacted).not.toContain("3497-011-2332");
    expect(redacted).toContain("passcode: [redacted]");
    const url = redactSerialLog("https://project-chip.github.io/connectedhomeip/qrcode.html?data=MT%3AY.ABCDEF");
    expect(url).not.toContain("MT%3A");
    expect(url).not.toContain("qrcode.html?data");
    const image = Buffer.alloc(176, 0);
    image.writeUInt32LE(0xabcd5432, 0);
    image.write("1.3.0", 16, "utf8");
    const digest = Buffer.alloc(32, 0xab);
    digest[0] = 0xa4;
    digest.write("a4a5dcfd", 0, "hex");
    digest.copy(image, 144);
    expect(readAppElfSha256(image)).toBe(digest.toString("hex"));
    expect(readAppElfSha256(Buffer.from("not an image"))).toBeNull();

    const planned = flashImagesFromPlan([
      { offset: "0x0", artifact: "bootloader.bin", bytes: 21696 },
      { offset: "0x20000", artifact: "sensors.bin", bytes: 1000 },
    ], false);
    expect(planned).toEqual([
      { label: "bootloader.bin", offset: 0, bytes: 21696, hashVerified: false, seconds: null },
      { label: "sensors.bin", offset: 0x20000, bytes: 1000, hashVerified: false, seconds: null },
    ]);

    const images = parseFlashImages([
      "Wrote 21696 bytes (13414 compressed) at 0x00000000 in 0.2 seconds (effective 933.1 kbit/s)...",
      "Hash of data verified.",
      "Wrote 3072 bytes (181 compressed) at 0x0000c000 in 0.0 seconds (effective 1179.7 kbit/s)...",
      "Hash of data verified.",
      "Wrote 8192 bytes (31 compressed) at 0x0001d000 in 0.0 seconds (effective 1564.6 kbit/s)...",
      "Hash of data verified.",
      "Wrote 1592800 bytes (961211 compressed) at 0x00020000 in 6.8 seconds (effective 1869.0 kbit/s)...",
      "Hash of data verified.",
    ].join("\n"));
    expect(images.map((image) => [image.label, image.offset, image.bytes, image.hashVerified])).toEqual([
      ["bootloader.bin", 0, 21696, true],
      ["partition-table.bin", 0xc000, 3072, true],
      ["ota_data_initial.bin", 0x1d000, 8192, true],
      ["sensors.bin", 0x20000, 1592800, true],
    ]);
    expect(parseFlashImages("Wrote 100 bytes (10 compressed) at 0x00000000 in 0.1 seconds\n").every((image) => image.hashVerified)).toBe(false);

    const checks = startupChecks({
      writeLog: "note: ESP32-H2 responded",
      monitorLog: [
        'I boot: App "sensors" version 1.2.0',
        "OpenThread started",
        "DHT11 read failed: ESP_ERR_TIMEOUT",
      ].join("\n"),
      versionString: "1.2.0",
      writeStatus: "succeeded",
    });
    expect(checks.find((item) => item.id === "matter")?.status).toBe("unknown");
    expect(checks.find((item) => item.id === "openthread")?.status).toBe("passed");
    expect(checks.find((item) => item.id === "dht11")?.status).toBe("passed");
    expect(checks.find((item) => item.id === "version")?.status).toBe("passed");
    expect(checks.find((item) => item.id === "factory_reset")?.status).toBe("unknown");
    expect(checks.find((item) => item.id === "dht11")?.detail).toMatch(/not evidence of Matter commissioning/);

    const other = startupChecks({
      writeLog: "",
      monitorLog: 'App "sensors" version 1.1.0\nGuru Meditation Error',
      versionString: "1.2.0",
      writeStatus: "succeeded",
    });
    expect(other.find((item) => item.id === "version")?.status).toBe("failed");
    expect(other.find((item) => item.id === "boot")?.status).toBe("failed");

    const device = startupChecks({
      writeLog: "Hash of data verified.",
      monitorLog: [
        "ESP-ROM:esp32h2-20221101",
        "I (28) cpu_start: App version:      1.3.0",
        "I (900) chip[DL]: OpenThread started: OK",
        "I (1200) chip[DL]: CHIP task running",
        "I (3200) DHT11: DHT11 Temperature: 24°C, Humidity: 51%RH",
      ].join("\n"),
      versionString: "1.3.0",
      writeStatus: "succeeded",
    });
    expect(device.find((item) => item.id === "boot")?.status).toBe("passed");
    expect(device.find((item) => item.id === "version")?.status).toBe("passed");
    expect(device.find((item) => item.id === "matter")?.status).toBe("unknown");
    expect(device.find((item) => item.id === "openthread")?.status).toBe("passed");
    expect(device.find((item) => item.id === "dht11")?.status).toBe("passed");
    expect(installationSummary(device, "succeeded")).toBe("Firmware installation succeeded. Matter commissioning has not yet been performed.");
    expect(installationSummary(checks, "succeeded")).toBe("Firmware installation succeeded. Matter commissioning has not yet been performed.");
    expect(installationSummary(other, "succeeded")).toBe("Firmware Installed — Verification Failed.");
    expect(installationSummary(device, "failed")).toBe("Firmware Installation Failed.");
    const matterFailed = startupChecks({
      writeLog: "",
      monitorLog: "App version: 1.3.0\nFailed to start Matter, err:1\nOpenThread started",
      versionString: "1.3.0",
      writeStatus: "succeeded",
    });
    expect(matterFailed.find((item) => item.id === "matter")?.status).toBe("failed");
    expect(installationSummary(matterFailed, "succeeded")).toBe("Firmware Installed — Verification Failed.");
    const withoutSensor = startupChecks({
      writeLog: "Hash of data verified.",
      monitorLog: "ESP-ROM:esp32h2-20221101\nI (28) cpu_start: App version:      1.3.0\nI (900) chip[DL]: OpenThread started: OK\nI (1400) chip[DL]: Server Listening...",
      versionString: "1.3.0",
      writeStatus: "succeeded",
    });
    expect(withoutSensor.find((item) => item.id === "dht11")?.status).toBe("unknown");
    expect(installationSummary(withoutSensor, "succeeded")).toBe("Firmware Installed and Verified.");
    const listening = startupChecks({
      writeLog: "",
      monitorLog: "I (1400) chip[DL]: Server Listening...",
      versionString: "1.3.0",
      writeStatus: "succeeded",
    });
    expect(listening.find((item) => item.id === "matter")?.status).toBe("passed");
  });

  it("stops after a failed chip probe and still refuses an erase command", async () => {
    const calls: string[][] = [];
    const executor: ToolExecutor = {
      async run(args) {
        calls.push(args);
        return { code: 1, text: "Failed to connect to ESP32-H2", cancelled: false };
      },
    };
    const result = await runUsbWrite({
      repoRoot,
      port: "/dev/cu.usbmodem1101",
      writeArgs: ["write-flash", "--port", "/dev/cu.usbmodem1101", "write_flash"],
      signal: new AbortController().signal,
      onLog: () => undefined,
    }, executor);
    expect(result.ok).toBe(false);
    expect(chipProbeAccepted(1, "Failed to connect to ESP32-H2")).toBe(false);
    expect(calls.map((args) => args[0])).toEqual(["chip-id"]);

    const refused = await runUsbWrite({
      repoRoot,
      port: "/dev/cu.usbmodem1101",
      writeArgs: ["write-flash", "--erase-all"],
      signal: new AbortController().signal,
      onLog: () => undefined,
    }, executor);
    expect(refused.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("writes only after the chip probe reports ESP32-H2 and reports a timeout", async () => {
    const calls: string[][] = [];
    const executor: ToolExecutor = {
      async run(args) {
        calls.push(args);
        if (args[0] === "chip-id") return { code: 0, text: "Chip is ESP32-H2", cancelled: false };
        return { code: 0, text: "Hash of data verified", cancelled: false };
      },
    };
    const wrote = await runUsbWrite({
      repoRoot,
      port: "/dev/cu.usbmodem1101",
      writeArgs: ["write-flash", "--port", "/dev/cu.usbmodem1101", "write_flash", "0x20000", "/tmp/sensors.bin"],
      signal: new AbortController().signal,
      onLog: () => undefined,
    }, executor);
    expect(wrote.ok).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["chip-id", "write-flash"]);

    const hanging: ToolExecutor = {
      run(_args, signal) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ code: 0, text: "Chip is ESP32-H2", cancelled: false }), 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ code: 1, text: "", cancelled: true });
          });
        });
      },
    };
    const timed = await runUsbWrite({
      repoRoot,
      port: "/dev/cu.usbmodem1101",
      writeArgs: ["write-flash", "write_flash"],
      signal: new AbortController().signal,
      onLog: () => undefined,
      timeoutMs: 20,
    }, hanging);
    expect(timed.ok).toBe(false);
    expect(timed.cancelled).toBe(false);
    expect(timed.timedOut).toBe(true);
    expect(timed.diagnostic).toBe("The board did not answer the chip probe. The firmware was not written.");
  });

  it("records an unknown result when the USB tool never reports an exit and does not start another write", async () => {
    const calls: string[][] = [];
    const executor: ToolExecutor = {
      run(args) {
        calls.push(args);
        if (args[0] === "chip-id") return Promise.resolve({ code: 0, text: "Chip is ESP32-H2", cancelled: false });
        return new Promise(() => undefined);
      },
    };
    const timed = await runUsbWrite({
      repoRoot,
      port: "/dev/cu.usbmodem1101",
      writeArgs: ["write-flash", "--port", "/dev/cu.usbmodem1101", "write_flash", "0x20000", "/tmp/sensors.bin"],
      signal: new AbortController().signal,
      onLog: () => undefined,
      timeoutMs: 20,
      exitGraceMs: 20,
    }, executor);
    expect(timed.ok).toBe(false);
    expect(timed.timedOut).toBe(true);
    expect(timed.diagnostic).toBe("Flash verification timed out. The result is unknown. Review the diagnostic log before retrying.");
    expect(calls.map((args) => args[0])).toEqual(["chip-id", "write-flash"]);
  });

  it("rejects a busy or missing port and a hash mismatch without treating either as a verified write", async () => {
    const busy = await runUsbWrite({
      repoRoot,
      port: "/tmp/not-a-port",
      writeArgs: ["write-flash", "write_flash"],
      signal: new AbortController().signal,
      onLog: () => undefined,
    });
    expect(busy.ok).toBe(false);
    expect(busy.diagnostic).toMatch(/not an allowed local USB device/);

    const mismatch = await runUsbWrite({
      repoRoot,
      port: "/dev/cu.usbmodem1101",
      writeArgs: ["write-flash", "write_flash", "0x20000", "/tmp/sensors.bin"],
      signal: new AbortController().signal,
      onLog: () => undefined,
    }, {
      async run(args) {
        if (args[0] === "chip-id") return { code: 0, text: "Chip is ESP32-H2", cancelled: false };
        return { code: 2, text: "Hash of data verified failed\nVerify failed", cancelled: false };
      },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.timedOut).toBeUndefined();
    expect(mismatch.diagnostic).toMatch(/not reported as verified/);
  });

  it("keeps a higher version distinct in the startup record", () => {
    const first = startupChecks({
      writeLog: "",
      monitorLog: 'App "sensors" version 1.1.0',
      versionString: "1.1.0",
      writeStatus: "succeeded",
    });
    const second = startupChecks({
      writeLog: "",
      monitorLog: 'App "sensors" version 1.2.0',
      versionString: "1.2.0",
      writeStatus: "succeeded",
    });
    expect(first.find((item) => item.id === "version")?.detail).toContain("1.1.0");
    expect(second.find((item) => item.id === "version")?.detail).toContain("1.2.0");
    expect(first.find((item) => item.id === "version")?.detail).not.toContain("1.2.0");
  });

  it("reads identity in ROM download mode and hard-resets only to start the application", async () => {
    const script = await readFile(path.join(repoRoot, "scripts/idf_exec.sh"), "utf8");
    const chip = script.slice(script.indexOf("chip-id)"), script.indexOf("flash-id)"));
    expect(chip).toContain("--before usb_reset");
    expect(chip).toContain("--after no_reset chip_id");
    const reset = script.slice(script.indexOf("app-reset)"), script.indexOf("monitor)"));
    expect(reset).toContain("--after hard_reset run");
    expect(reset).not.toMatch(/erase_flash|erase-flash/);
    const uart = firmwareConsole("CONFIG_ESP_CONSOLE_UART_DEFAULT=y\n# CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG is not set\n# CONFIG_ESP_CONSOLE_SECONDARY_NONE is not set\n");
    expect(uart).toMatchObject({ primary: "uart0", usbSerialJtagOutput: false, uart0Output: true });
    const shared = firmwareConsole("CONFIG_ESP_CONSOLE_UART_DEFAULT=y\n# CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG is not set\nCONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=y\n");
    expect(shared).toMatchObject({ primary: "uart0", usbSerialJtagOutput: true, uart0Output: true });
    const usb = firmwareConsole("CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y\n");
    expect(usb).toMatchObject({ primary: "usb-serial-jtag", usbSerialJtagOutput: true, uart0Output: false });
    expect(bootCaptureMessage("")).toMatch(/silent console/);
    expect(bootCaptureMessage("waiting for download")).toMatch(/ROM download mode/);
    expect(bootCaptureMessage("ESP-ROM:esp32h2-eco5-20240613\nI (23) boot: ESP-IDF v5.4.1 2nd stage bootloader\nboot:0xc (SPI_FAST_FLASH_BOOT)")).toMatch(/bootloader started/i);
    expect(bootCaptureMessage("Guru Meditation Error: Core 0 panic'ed")).toMatch(/panic or repeated resets/);
    expect(bootCaptureMessage('App "sensors" version: 1.6.0')).toBeNull();
    const rom = "ESP-ROM:esp32h2-eco5-20240613\nI (23) boot: ESP-IDF v5.4.1 2nd stage bootloader";
    expect(applicationBootSeen(rom)).toBe(false);
    expect(bootListenSettled(rom, null, 1_000).settled).toBe(false);
    const started = `${rom}\nI (80) cpu_start: Calling app_main()\nI (90) app_main: Extended colour light endpoint 1`;
    expect(applicationBootSeen(started)).toBe(true);
    expect(bootListenSettled(started, 1_000, 1_100).settled).toBe(false);
    expect(bootListenSettled(`${started}\nCHIP task running\nOpenThread started`, 1_000, 1_100).settled).toBe(false);
    expect(bootListenSettled(`${started}\nCHIP task running\nOpenThread started`, 1_000, 5_100).settled).toBe(true);
    expect(bootListenSettled(`${started}\nServer Listening...\nSetupQRCode: [MT:Y.K9042C00KA0648G00]\nManual pairing code: [34970112332]`, 1_000, 1_100).settled).toBe(true);
    const romOnly = startupChecks({ writeLog: "Hash of data verified.", monitorLog: rom, versionString: "1.6.0", writeStatus: "succeeded" });
    expect(romOnly.find((item) => item.id === "boot")?.status).toBe("unknown");
    const app = startupChecks({ writeLog: "Hash of data verified.", monitorLog: started, versionString: "1.6.0", writeStatus: "succeeded" });
    expect(app.find((item) => item.id === "boot")?.status).toBe("passed");
    expect(app.find((item) => item.id === "version")?.status).toBe("unknown");
    const stopped = `${started}\nI (552) app_init: App version:      1.6.0\nE (657) app_main: Failed to register the RGB light, err:261`;
    const failed = startupChecks({ writeLog: "Hash of data verified.", monitorLog: stopped, versionString: "1.6.0", writeStatus: "succeeded" });
    expect(failed.find((item) => item.id === "boot")?.status).toBe("passed");
    expect(failed.find((item) => item.id === "version")?.status).toBe("passed");
    expect(failed.find((item) => item.id === "matter")?.status).toBe("failed");
    expect(failed.find((item) => item.id === "openthread")?.status).toBe("unknown");
    const running = [
      "I (598) app_init: App version: 1.5.0",
      "I (699) main_task: Calling app_main()",
      "I (709) dht11_matter: Initialising DHT11 on GPIO4",
      "I (789) chip[DL]: OpenThread started: OK",
      "I (1429) chip[DL]: CHIPoBLE advertising started",
      "I (2739) dht11_matter: DHT11 temperature 24 C, humidity 36%",
      "Failed to advertise commissionable node: 3",
      "note: cancellation requested. Stopping the USB tool.",
    ].join("\n");
    const booted = startupChecks({ writeLog: "Wrote 1592992 bytes at 0x00020000\nHash of data verified.", monitorLog: running, versionString: "1.5.0", writeStatus: "succeeded" });
    expect(booted.find((item) => item.id === "boot")?.status).toBe("passed");
    expect(booted.find((item) => item.id === "version")?.status).toBe("passed");
    expect(booted.find((item) => item.id === "matter")?.status).toBe("passed");
    expect(booted.find((item) => item.id === "matter")?.detail).toMatch(/DNS-SD/);
    expect(booted.find((item) => item.id === "dht11")?.status).toBe("passed");
    expect(bootResultMessage(running, booted, "succeeded")).toBe("Firmware Installed and Verified.");
    expect(installationSummary(booted, "succeeded")).toBe("Firmware Installed and Verified.");
    const pending = startupChecks({ writeLog: "Hash of data verified.", monitorLog: "", versionString: "1.5.0", writeStatus: "succeeded" });
    expect(installationSummary(pending, "succeeded")).toMatch(/has not been captured yet/);
    expect(bootResultMessage("I (1) boot: something else", pending, "succeeded")).toMatch(/no application startup was observed/);
  });

  it("identifies an ESP32-H2 without starting a flash write", async () => {
    const calls: string[][] = [];
    const executor: ToolExecutor = {
      async run(args) {
        calls.push(args);
        return { code: 0, text: "Detecting chip type... ESP32-H2\n", cancelled: false };
      },
    };
    const result = await probeChip({ repoRoot, port: "/dev/cu.usbmodem101" }, executor);
    expect(result.accepted).toBe(true);
    expect(calls).toEqual([["chip-id", "/dev/cu.usbmodem101"]]);
    expect(chipConnectionFailure("A fatal error occurred: Failed to connect to ESP32-H2: No serial data received.")).toBe("no_serial_data");
    expect(chipConnectionFailure("Chip is ESP32-H2")).toBeNull();
  });

  it("reads flash size only after the chip answers, without resetting again", async () => {
    const calls: string[][] = [];
    const executor: ToolExecutor = {
      async run(args) {
        calls.push(args);
        return { code: 0, text: args[0] === "chip-id" ? "Chip is ESP32-H2\n" : "Detected flash size: 4MB\n", cancelled: false };
      },
    };
    const result = await probeChip({ repoRoot, port: "/dev/cu.usbmodem101", includeFlashSize: true }, executor);
    expect(result.accepted).toBe(true);
    expect(result.failure).toBeNull();
    expect(calls).toEqual([
      ["chip-id", "/dev/cu.usbmodem101"],
      ["flash-id", "/dev/cu.usbmodem101", "--stay"],
    ]);
  });

  it("rejects a probe that does not report ESP32-H2 and does not write", async () => {
    const calls: string[][] = [];
    const executor: ToolExecutor = {
      async run(args) {
        calls.push(args);
        return { code: 2, text: "This chip is ESP32-C6, not ESP32-H2.\n", cancelled: false };
      },
    };
    const rejected = await probeChip({ repoRoot, port: "/dev/cu.usbmodem101" }, executor);
    const skipped = await probeChip({ repoRoot, port: "/tmp/not-a-port" }, executor);
    expect(rejected.accepted).toBe(false);
    expect(skipped.accepted).toBe(false);
    expect(calls).toEqual([["chip-id", "/dev/cu.usbmodem101"]]);
  });
});
