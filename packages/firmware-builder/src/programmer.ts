import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildJob, ProgramSession, StartupCheck, ValidationIssue } from "@iotedu/contracts";
import type { PartitionRow } from "./index.js";

const PORT_PATTERN = /^\/dev\/cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)[A-Za-z0-9._-]{0,64}$/;

const ARTIFACT_BY_SOURCE: Record<string, string> = {
  "bootloader/bootloader.bin": "bootloader.bin",
  "sensors.bin": "sensors.bin",
  "partition_table/partition-table.bin": "partition-table.bin",
  "ota_data_initial.bin": "ota_data_initial.bin",
};

const REQUIRED_ARTIFACTS = [
  "bootloader.bin",
  "sensors.bin",
  "partition-table.bin",
  "ota_data_initial.bin",
  "usb-image.bin",
  "flasher_args.json",
];

const PROTECTED_PARTITIONS = new Set(["nvs", "nvs_keys", "fctry", "esp_secure_cert", "phy_init"]);

export interface FlashArguments {
  write_flash_args?: string[];
  flash_files?: Record<string, string>;
  extra_esptool_args?: { chip?: string; before?: string; after?: string };
  bootloader?: { encrypted?: string };
  app?: { encrypted?: string };
  "partition-table"?: { encrypted?: string };
  otadata?: { encrypted?: string };
}

export interface FlashPlan {
  ok: boolean;
  issues: ValidationIssue[];
  args: string[];
  regions: Array<{ offset: string; artifact: string; bytes: number }>;
}

export interface ToolRun {
  code: number;
  text: string;
  cancelled: boolean;
}

export interface ToolExecutor {
  run(args: string[], signal: AbortSignal, onLog: (line: string) => void): Promise<ToolRun>;
}

export interface UsbRunnerSpec {
  repoRoot: string;
  port: string;
  writeArgs: string[];
  signal: AbortSignal;
  onLog: (line: string) => void;
  timeoutMs?: number;
  exitGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface UsbRunnerResult {
  ok: boolean;
  cancelled: boolean;
  timedOut?: boolean;
  diagnostic: string | null;
}

export const FLASH_VERIFIED_BOOT_PENDING =
  "Flash contents were verified. Application startup has not been captured yet.";

export const FLASH_VERIFIED_BOOT_UNSEEN =
  "Unable to verify firmware boot. Flash contents were verified, but no application startup was observed.";

export const INSTALL_SUCCEEDED_COMMISSIONING_NOT_PERFORMED =
  "Firmware installation succeeded. Matter commissioning has not yet been performed.";

export const FLASH_RESULT_UNKNOWN =
  "Flash verification timed out. The result is unknown. Review the diagnostic log before retrying.";

export const DOWNLOAD_MODE_CAPTURE =
  "The console shows ROM download mode. Application startup was not observed. Flash was not rewritten.";

export const SILENT_CONSOLE_CAPTURE =
  "No application output was captured. A silent console is not proof that the firmware crashed. Flash was not rewritten.";

export const BOOT_FAILED_CAPTURE =
  "Firmware boot failed. The console showed a panic or repeated resets. Flash was not rewritten.";

export const PORT_REAPPEAR_FAILED =
  "The USB port did not reappear after the application reset. Reconnect the cable and retry boot verification. Flash was not rewritten.";

export const BOOTLOADER_ONLY_CAPTURE =
  "The bootloader started from SPI flash. Application startup was not captured. Flash was not rewritten.";

export const APPLICATION_LISTEN_GRACE_MS = 4_000;

export function applicationBootSeen(monitorLog: string): boolean {
  return /cpu_start:|app_init:|Calling app_main|App version:|App "sensors"|Extended colour light endpoint|Failed to prepare the Matter core|Failed to register the RGB|Failed to start Matter|Failed to create the extended/i.test(monitorLog);
}

export function bootloaderStarted(monitorLog: string): boolean {
  return /ESP-ROM:esp32h2|2nd stage bootloader|SPI_FAST_FLASH_BOOT/i.test(monitorLog);
}

export function bootListenSettled(monitorLog: string, applicationSeenAt: number | null, now: number): { seenAt: number | null; settled: boolean } {
  if (/Guru Meditation|panic'ed|abort\(\)/i.test(monitorLog) || (monitorLog.match(/Rebooting\.\.\./gi)?.length ?? 0) >= 3) {
    return { seenAt: applicationSeenAt, settled: true };
  }
  if (/waiting for download|DOWNLOAD_BOOT/i.test(monitorLog) && !/SPI_FAST_FLASH_BOOT/i.test(monitorLog)) {
    return { seenAt: applicationSeenAt, settled: true };
  }
  if (!applicationBootSeen(monitorLog)) return { seenAt: applicationSeenAt, settled: false };
  const seenAt = applicationSeenAt ?? now;
  if (/Failed to start Matter|Failed to register the RGB light|Failed to prepare the Matter core|Failed to init server/i.test(monitorLog)) {
    return { seenAt, settled: true };
  }
  if (/Fabric already commissioned|Existing Matter fabric count/i.test(monitorLog)) return { seenAt, settled: true };
  if (/SetupQRCode:/i.test(monitorLog) && /Manual pairing code:/i.test(monitorLog)) return { seenAt, settled: true };
  if (/Server Listening|CHIPoBLE advertising started|Commissioning window opened/i.test(monitorLog)) {
    return { seenAt, settled: now - seenAt >= 800 };
  }
  // OpenThread and chip[DL] run before Server::Init. Stopping there drops the fabric, window, and onboarding lines.
  return { seenAt, settled: now - seenAt >= APPLICATION_LISTEN_GRACE_MS };
}

export function firmwareConsole(sdkconfig: string): {
  primary: "uart0" | "usb-serial-jtag" | "none";
  usbSerialJtagOutput: boolean;
  uart0Output: boolean;
} {
  const none = /^CONFIG_ESP_CONSOLE_NONE=y$/m.test(sdkconfig);
  const usbPrimary = /^CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y$/m.test(sdkconfig);
  const uartDefault = /^CONFIG_ESP_CONSOLE_UART_DEFAULT=y$/m.test(sdkconfig) || /^CONFIG_ESP_CONSOLE_UART_CUSTOM=y$/m.test(sdkconfig);
  const usbSecondary = /^CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=y$/m.test(sdkconfig);
  return {
    primary: none ? "none" : usbPrimary ? "usb-serial-jtag" : "uart0",
    usbSerialJtagOutput: !none && (usbPrimary || usbSecondary),
    uart0Output: !none && uartDefault,
  };
}

export function bootCaptureMessage(monitorLog: string): string | null {
  if (/Guru Meditation|panic'ed|abort\(\)/i.test(monitorLog) || (monitorLog.match(/Rebooting\.\.\./gi)?.length ?? 0) >= 3) {
    return BOOT_FAILED_CAPTURE;
  }
  if (applicationBootSeen(monitorLog)) return null;
  if (/waiting for download|DOWNLOAD_BOOT/i.test(monitorLog) && !/SPI_FAST_FLASH_BOOT/i.test(monitorLog)) return DOWNLOAD_MODE_CAPTURE;
  if (bootloaderStarted(monitorLog)) return BOOTLOADER_ONLY_CAPTURE;
  const lines = monitorLog.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("note:"));
  if (lines.length === 0) return SILENT_CONSOLE_CAPTURE;
  return null;
}

export function isAllowedSerialPort(port: string): boolean {
  return PORT_PATTERN.test(port) && !port.includes("..");
}

export function filterSerialPortNames(names: string[]): string[] {
  return names
    .map((name) => `/dev/${name}`)
    .filter(isAllowedSerialPort)
    .sort();
}

export async function listSerialPorts(): Promise<string[]> {
  try {
    return filterSerialPortNames(await readdir("/dev"));
  } catch {
    return [];
  }
}

export function packageProgrammingBlock(job: BuildJob): ValidationIssue | null {
  if (job.simulated || job.verification === "simulated" || job.status === "simulated") {
    return {
      level: "error",
      code: "simulated_package",
      message: "A simulated package cannot be written to a device.",
    };
  }
  if (job.status !== "succeeded" || (job.verification !== "compiled" && job.verification !== "hardware_verified")) {
    return {
      level: "error",
      code: "package_not_compiled",
      message: "Only a successfully compiled package can be written to a device.",
    };
  }
  if (job.request.hardware !== "esp32h2") {
    return {
      level: "error",
      code: "target_mismatch",
      message: "The package target is not ESP32-H2.",
    };
  }
  for (const name of REQUIRED_ARTIFACTS) {
    const artifact = job.artifacts.find((item) => item.name === name);
    if (!artifact || artifact.simulated) {
      return {
        level: "error",
        code: "artifact_missing",
        message: `The package is missing ${name}.`,
      };
    }
  }
  return null;
}

export function flashProgressPercent(line: string): number | null {
  const match = line.match(/\((\d{1,3})\s*%\)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value > 100) return null;
  return value;
}

export function writeDiagnostic(text: string, timedOut: boolean): string {
  if (timedOut) {
    return "The write timed out. Check the USB cable. If the board does not enter download mode, hold BOOT (GPIO9), press and release RESET, then release BOOT.";
  }
  if (/could not open port|No such file or directory|Resource busy|Device not configured/i.test(text)) {
    return "The serial port could not be opened. Reconnect the board and choose the port again. Close any other program using it.";
  }
  if (/No serial data received|Failed to connect|Timed out waiting|packet header/i.test(text)) {
    return "The board did not enter download mode. Hold BOOT (GPIO9), press and release RESET, release BOOT, and try the write again.";
  }
  if (/Wrong chip|Unexpected chip|This chip is/i.test(text)) {
    return "The connected chip is not an ESP32-H2. Choose the USB port of the ESP32-H2 board.";
  }
  return "The write failed. The log has the USB tool output. Flash contents were not reported as verified.";
}

const FLASH_IMAGE_NAMES: Record<number, string> = {
  0x0: "bootloader.bin",
  0xc000: "partition-table.bin",
  0x1d000: "ota_data_initial.bin",
  0x20000: "sensors.bin",
};

export interface ParsedFlashImage {
  label: string;
  offset: number;
  bytes: number | null;
  hashVerified: boolean;
  seconds: number | null;
}

export function flashImagesFromPlan(
  regions: Array<{ offset: string; artifact: string; bytes: number }>,
  hashVerified: boolean,
): ParsedFlashImage[] {
  return regions.map((region) => ({
    label: region.artifact,
    offset: Number.parseInt(region.offset, 16),
    bytes: region.bytes,
    hashVerified,
    seconds: null,
  }));
}

export function parseFlashImages(log: string): ParsedFlashImage[] {
  const images: ParsedFlashImage[] = [];
  const pattern = /Wrote (\d+) bytes \([^)]*\) at (0x[0-9a-f]+) in ([0-9.]+) seconds/gi;
  for (const match of log.matchAll(pattern)) {
    const bytes = Number(match[1]);
    const offset = Number.parseInt(match[2] ?? "", 16);
    const seconds = Number(match[3]);
    const after = log.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 160);
    images.push({
      label: FLASH_IMAGE_NAMES[offset] ?? "Not Verified",
      offset,
      bytes: Number.isInteger(bytes) ? bytes : null,
      hashVerified: /Hash of data verified/i.test(after),
      seconds: Number.isFinite(seconds) ? seconds : null,
    });
  }
  return images;
}

export function redactSerialLog(text: string): string {
  return text
    .replace(/https?:\/\/\S*qrcode\.html\?\S+/gi, "[redacted]")
    .replace(/MT%3A[A-Z0-9.%_-]+/gi, "[redacted]")
    .replace(/MT:[A-Z0-9.-]+/gi, "[redacted]")
    .replace(/Manual pairing code:\s*\[[0-9-]+\]/gi, "Manual pairing code: [redacted]")
    .replace(/\b\d{4}-\d{3}-\d{4}\b/g, "[redacted]")
    .replace(
      /(passcode|pincode|pin code|setup pin|spake2p|salt|verifier|private key)\s*[:=]\s*\S+/gi,
      "$1: [redacted]",
    );
}

/** SHA256 of the application ELF stored in an ESP-IDF app descriptor. The discriminator is not in this value. */
export function readAppElfSha256(binary: Uint8Array): string | null {
  const magic = Buffer.from([0x32, 0x54, 0xcd, 0xab]);
  const bytes = Buffer.from(binary);
  let offset = bytes.indexOf(magic);
  while (offset >= 0 && offset + 176 <= bytes.length) {
    const version = bytes.subarray(offset + 16, offset + 48).toString("utf8").split("\0")[0] ?? "";
    if (/^\d+\.\d+\.\d+$/.test(version)) return bytes.subarray(offset + 144, offset + 176).toString("hex");
    offset = bytes.indexOf(magic, offset + 1);
  }
  return null;
}

export function chipProbeAccepted(exitCode: number, output: string): boolean {
  return exitCode === 0 && /ESP32-H2/i.test(output);
}

export function chipConnectionFailure(text: string): "no_serial_data" | "port_unavailable" | "wrong_chip" | null {
  if (/No serial data received|Failed to connect/i.test(text)) return "no_serial_data";
  if (/could not open port|Resource busy|Device not configured|No such file or directory/i.test(text)) return "port_unavailable";
  if (/Wrong chip|Unexpected chip|This chip is|not an ESP32-H2/i.test(text)) return "wrong_chip";
  return null;
}

export async function probeChip(
  spec: { repoRoot: string; port: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; includeFlashSize?: boolean },
  executor?: ToolExecutor,
): Promise<{ accepted: boolean; text: string; failure: ReturnType<typeof chipConnectionFailure> }> {
  if (!isAllowedSerialPort(spec.port)) {
    return { accepted: false, failure: "port_unavailable", text: "The serial port is not an allowed local USB device." };
  }
  const tool = executor ?? defaultExecutor(path.join(spec.repoRoot, "scripts/idf_exec.sh"), spec.env);
  const controller = new AbortController();
  const signal = spec.signal ?? controller.signal;
  const probe = await runTimed(tool, ["chip-id", spec.port], signal, () => undefined, 45_000);
  let text = redactSerialLog(probe.text).trim();
  if (probe.timedOut) {
    return { accepted: false, failure: "no_serial_data", text: text || "The chip probe timed out before the board answered." };
  }
  const accepted = chipProbeAccepted(probe.code, text);
  if (accepted && spec.includeFlashSize) {
    const flash = await runTimed(tool, ["flash-id", spec.port, "--stay"], signal, () => undefined, 45_000);
    if (flash.code === 0) text = `${text}\n${redactSerialLog(flash.text)}`.trim();
    else if (chipConnectionFailure(flash.text) === "no_serial_data") {
      return { accepted: false, failure: "no_serial_data", text: `${text}\n${redactSerialLog(flash.text)}`.trim() };
    }
  }
  return { accepted, failure: accepted ? null : chipConnectionFailure(text), text };
}

export async function verifyProgrammingTools(repoRoot: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  const tool = defaultExecutor(path.join(repoRoot, "scripts/idf_exec.sh"), env);
  try {
    const result = await runTimed(tool, ["tool-check"], new AbortController().signal, () => undefined, 30_000);
    const version = result.text.trim().split(/\s+/).pop() ?? "";
    if (result.code === 0 && version) {
      return { ok: true, detail: `ESP-IDF v5.4.1 programming tools are ready (version ${version}). A chip probe can identify an ESP32-H2 without a manual export.` };
    }
    return {
      ok: false,
      detail: "ESP-IDF v5.4.1 was found, but esptool did not start. The programming environment is not activated. This is not a missing USB device.",
    };
  } catch {
    return {
      ok: false,
      detail: "ESP-IDF v5.4.1 was found, but the programming tools could not be started. This is not a missing USB device.",
    };
  }
}

function issue(code: string, message: string): ValidationIssue {
  return { level: "error", code, message };
}

function parseOffset(text: string): number | null {
  if (!/^0x[0-9a-fA-F]+$/.test(text)) return null;
  const value = Number.parseInt(text, 16);
  return Number.isSafeInteger(value) ? value : null;
}

function flashSizeLabelBytes(label: string): number | null {
  const match = /^(\d+)(MB|KB)$/i.exec(label);
  const countText = match?.[1];
  const unit = match?.[2];
  if (!countText || !unit) return null;
  const count = Number(countText);
  return unit.toUpperCase() === "MB" ? count * 1024 * 1024 : count * 1024;
}

function overlaps(start: number, size: number, regionStart: number, regionSize: number): boolean {
  return start < regionStart + regionSize && start + size > regionStart;
}

function contained(start: number, size: number, regionStart: number, regionSize: number): boolean {
  return start >= regionStart && start + size <= regionStart + regionSize;
}

function forbiddenToken(arg: string): boolean {
  if (arg.includes(path.sep) || arg.startsWith("/dev/")) return false;
  return /erase/i.test(arg) || arg === "--force";
}

export function buildWritePlan(input: {
  flasher: FlashArguments;
  artifactDir: string;
  port: string;
  partitions: PartitionRow[];
  bootloaderOffset: number;
  partitionTableOffset: number;
  flashSizeBytes: number;
  files: Record<string, Buffer>;
}): FlashPlan {
  const issues: ValidationIssue[] = [];
  if (!isAllowedSerialPort(input.port)) {
    issues.push(issue("port_rejected", "Choose a local macOS USB serial device such as /dev/cu.usbmodem."));
  }
  if (input.flasher.extra_esptool_args?.chip !== "esp32h2") {
    issues.push(issue("target_mismatch", "The flashing metadata does not name ESP32-H2."));
  }
  if (input.flasher.extra_esptool_args?.before !== "default_reset" || input.flasher.extra_esptool_args.after !== "hard_reset") {
    issues.push(issue("reset_mode_rejected", "The flashing metadata must reset into download mode and hard-reset afterwards."));
  }
  for (const region of [input.flasher.bootloader, input.flasher.app, input.flasher["partition-table"], input.flasher.otadata]) {
    if (region?.encrypted && region.encrypted !== "false") {
      issues.push(issue("encrypted_image_rejected", "Encrypted flashing is not part of this workflow."));
    }
  }

  const rawArgs = input.flasher.write_flash_args ?? [];
  if (rawArgs.some(forbiddenToken)) {
    issues.push(issue("erase_rejected", "Full-chip erase and region erase are not permitted."));
  }
  const settings = new Map<string, string>();
  for (let index = 0; index < rawArgs.length; index += 2) {
    const key = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!key || value === undefined || !["--flash_mode", "--flash_size", "--flash_freq"].includes(key)) {
      issues.push(issue("flash_settings_rejected", "Only flash mode, size, and frequency from the package metadata are accepted."));
      break;
    }
    settings.set(key, value);
  }
  const mode = settings.get("--flash_mode");
  const sizeLabel = settings.get("--flash_size");
  const freq = settings.get("--flash_freq");
  if (mode !== "dio" || freq !== "48m" || flashSizeLabelBytes(sizeLabel ?? "") !== input.flashSizeBytes) {
    issues.push(issue("flash_settings_mismatch", "The package must use DIO, 4 MB, and 48 MHz flash settings."));
  }

  const files = input.flasher.flash_files ?? {};
  const pieces: Array<{ offsetText: string; offset: number; artifact: string; bytes: Buffer }> = [];
  const expectedSources = new Set(Object.keys(ARTIFACT_BY_SOURCE));
  const seenSources = new Set<string>();
  for (const [offsetText, source] of Object.entries(files)) {
    const offset = parseOffset(offsetText);
    const artifact = ARTIFACT_BY_SOURCE[source];
    if (offset === null || !artifact) {
      issues.push(issue("flash_map_rejected", `Unsupported flashing entry ${offsetText} ${source}.`));
      continue;
    }
    seenSources.add(source);
    const bytes = input.files[artifact];
    if (!bytes) {
      issues.push(issue("artifact_missing", `Missing ${artifact} for offset ${offsetText}.`));
      continue;
    }
    pieces.push({ offsetText, offset, artifact, bytes });
  }
  for (const source of expectedSources) {
    if (!seenSources.has(source)) {
      issues.push(issue("flash_map_rejected", `The flashing metadata is missing ${source}.`));
    }
  }
  if (Object.keys(files).length !== expectedSources.size) {
    issues.push(issue("flash_map_rejected", "The flashing metadata must list only the bootloader, partition table, OTA data, and application."));
  }

  pieces.sort((left, right) => left.offset - right.offset);
  const protectedRegions = input.partitions.filter(
    (row): row is PartitionRow & { offset: number } => row.offset !== null && PROTECTED_PARTITIONS.has(row.name),
  );
  const otadata = input.partitions.find((row) => row.name === "otadata" && row.offset !== null);
  const application = input.partitions.find((row) => row.name === "ota_0" && row.offset !== null);
  const tableLimit = input.partitions
    .map((row) => row.offset)
    .filter((offset): offset is number => offset !== null && offset > input.partitionTableOffset)
    .sort((left, right) => left - right)[0];

  for (const piece of pieces) {
    const end = piece.offset + piece.bytes.length;
    for (const region of protectedRegions) {
      if (overlaps(piece.offset, piece.bytes.length, region.offset, region.size)) {
        issues.push(issue("protected_partition", `${piece.artifact} overlaps the ${region.name} partition. The write was refused.`));
      }
    }
    if (piece.artifact === "bootloader.bin") {
      if (piece.offset !== input.bootloaderOffset || tableLimit === undefined || end > input.partitionTableOffset) {
        issues.push(issue("layout_mismatch", "The bootloader is not placed in the reserved bootloader region."));
      }
    } else if (piece.artifact === "partition-table.bin") {
      if (piece.offset !== input.partitionTableOffset || tableLimit === undefined || end > tableLimit) {
        issues.push(issue("layout_mismatch", "The partition table is not placed between the bootloader and the first data partition."));
      }
    } else if (piece.artifact === "ota_data_initial.bin") {
      if (!otadata?.offset || !contained(piece.offset, piece.bytes.length, otadata.offset, otadata.size)) {
        issues.push(issue("layout_mismatch", "OTA selection data is not contained in the otadata partition."));
      }
    } else if (piece.artifact === "sensors.bin") {
      if (!application?.offset || !contained(piece.offset, piece.bytes.length, application.offset, application.size)) {
        issues.push(issue("firmware_too_large", "The application image does not fit in the ota_0 slot."));
      }
    }
  }
  for (let index = 1; index < pieces.length; index += 1) {
    const previous = pieces[index - 1];
    if (!previous) continue;
    if (pieces[index]!.offset < previous.offset + previous.bytes.length) {
      issues.push(issue("layout_mismatch", "Flashing regions overlap."));
    }
  }

  const merged = input.files["usb-image.bin"];
  if (!merged) {
    issues.push(issue("artifact_missing", "The merged USB image is missing."));
  } else if (merged.length > input.flashSizeBytes) {
    issues.push(issue("merged_image_rejected", "The merged image is larger than the flash."));
  } else {
    for (const piece of pieces) {
      const slice = merged.subarray(piece.offset, piece.offset + piece.bytes.length);
      if (slice.length !== piece.bytes.length || !slice.equals(piece.bytes)) {
        issues.push(issue("merged_image_mismatch", `The merged image does not contain ${piece.artifact} at ${piece.offsetText}.`));
      }
    }
  }

  const root = path.resolve(input.artifactDir);
  const args = [
    "write-flash",
    "--port",
    input.port,
    "--baud",
    "115200",
    "--before",
    "default_reset",
    "--after",
    "hard_reset",
    "write_flash",
    "--flash_mode",
    mode ?? "",
    "--flash_size",
    sizeLabel ?? "",
    "--flash_freq",
    freq ?? "",
  ];
  for (const piece of pieces) {
    const absolute = path.resolve(root, piece.artifact);
    if (absolute !== path.join(root, piece.artifact)) {
      issues.push(issue("rejected_path", `Refusing to write ${piece.artifact} from outside the package directory.`));
      continue;
    }
    args.push(piece.offsetText, absolute);
  }
  if (args.some((arg) => arg.endsWith("usb-image.bin") || forbiddenToken(arg))) {
    issues.push(issue("erase_rejected", "The write command included an erase request or the merged image."));
  }
  const regions = pieces.map((piece) => ({ offset: piece.offsetText, artifact: piece.artifact, bytes: piece.bytes.length }));
  return { ok: issues.length === 0, issues, args: issues.length === 0 ? args : [], regions: issues.length === 0 ? regions : [] };
}

export function startupChecks(input: {
  writeLog: string;
  monitorLog: string;
  versionString: string;
  writeStatus: ProgramSession["status"];
}): StartupCheck[] {
  const monitorLines = input.monitorLog.split(/\r?\n/).filter((line) => line && !line.startsWith("note:"));
  const disconnected = monitorLines.some((line) => /could not open port|Device not configured|No such file or directory/i.test(line));
  const deviceLines = monitorLines.filter((line) => !/could not open port|Device not configured|No such file or directory/i.test(line));
  const versionMatch = input.monitorLog.match(/App version:\s*(\S+)/) ?? input.monitorLog.match(/App "sensors" version:?\s*(\S+)/);
  const panic = /Guru Meditation|panic'ed|abort\(\)/i.test(input.monitorLog);
  const reboots = input.monitorLog.match(/Rebooting\.\.\./gi)?.length ?? 0;
  const bootSeen = applicationBootSeen(input.monitorLog);
  const bootloader = bootloaderStarted(input.monitorLog);
  const matterFailed = /Failed to start Matter|Failed to create Matter node|Failed to prepare the Matter core|Failed to register the RGB light|Failed to init server/.test(input.monitorLog);
  const matterServer = /Server Listening|Fabric already commissioned|Existing Matter fabric count|SetupQRCode:|CHIPoBLE advertising started|Commissioning window opened/i.test(input.monitorLog);
  const matterStack = /CHIP task running|CHIP:DL|chip\[DL\]/.test(input.monitorLog);
  const threadFailed = /Failed to initialize OpenThread|OpenThread start failed/i.test(input.monitorLog);
  const threadSeen = /OpenThread|esp_openthread|OPENTHREAD/.test(input.monitorLog);
  const dhtFailed = /Failed to initialize DHT11/.test(input.monitorLog);
  const dhtSeen = /DHT11 Temperature|DHT11 temperature|Initialising DHT11|DHT11 read failed/i.test(input.monitorLog);

  const connect: StartupCheck = input.writeStatus === "succeeded" || /ESP32-H2 responded/.test(input.writeLog)
    ? { id: "connect", label: "Connect ESP32-H2 via USB", status: "passed", detail: "The USB tool reached a board before or during the write." }
    : input.writeStatus === "failed"
      ? { id: "connect", label: "Connect ESP32-H2 via USB", status: "failed", detail: "The write did not complete, so the connection was not confirmed." }
      : { id: "connect", label: "Connect ESP32-H2 via USB", status: "unknown", detail: "No board connection has been observed." };

  const serial: StartupCheck = deviceLines.length > 0
    ? { id: "serial", label: "Confirm serial communication", status: "passed", detail: "Serial bytes were received. This does not confirm Matter commissioning." }
    : disconnected
      ? { id: "serial", label: "Confirm serial communication", status: "failed", detail: "The serial port closed or could not be opened." }
      : { id: "serial", label: "Confirm serial communication", status: "unknown", detail: "Startup text has not been captured. Retry boot verification from Setup. A separate serial monitor is not required." };

  const write: StartupCheck = input.writeStatus === "succeeded"
    ? { id: "write", label: "Flash compiled firmware", status: "passed", detail: "The image was written. NVS was not erased. Startup is a separate check." }
    : input.writeStatus === "failed" || input.writeStatus === "interrupted"
      ? { id: "write", label: "Flash compiled firmware", status: "failed", detail: "The write did not finish. The package files were left unchanged." }
      : { id: "write", label: "Flash compiled firmware", status: "unknown", detail: "The write has not finished." };

  const boot: StartupCheck = panic || reboots >= 3
    ? { id: "boot", label: "Confirm successful boot", status: "failed", detail: "The serial log contains a panic, abort, or repeated reboots." }
    : bootSeen
      ? { id: "boot", label: "Confirm successful boot", status: "passed", detail: "Application startup was captured. A ROM banner alone is not this result. Commissioning is not inferred." }
      : bootloader
        ? { id: "boot", label: "Confirm successful boot", status: "unknown", detail: "The ROM and second-stage bootloader started from SPI flash. The application log was not in this capture." }
        : { id: "boot", label: "Confirm successful boot", status: "unknown", detail: "No ESP32-H2 application startup has been captured." };

  const discoveryFailed = /Failed to advertise commissionable node|Failed to finalize service update|Failed to remove advertised services/i.test(input.monitorLog);
  const matter: StartupCheck = matterFailed
    ? { id: "matter", label: "Confirm Matter startup", status: "failed", detail: /Failed to register the RGB light/.test(input.monitorLog) ? "The application stopped while registering the RGB light, before Matter started. This is not a BLE or fabric result." : "The firmware logged a Matter startup failure." }
    : matterServer
      ? { id: "matter", label: "Confirm Matter startup", status: "passed", detail: discoveryFailed
        ? "The Matter server or CHIPoBLE advertising started. DNS-SD commissionable advertising failed separately. That does not by itself mean Bluetooth commissioning failed."
        : "The Matter server reported listening, a stored fabric, or an onboarding code. Commissioning is a separate result." }
      : matterStack
        ? { id: "matter", label: "Confirm Matter startup", status: "unknown", detail: "The Matter stack started. This capture ended before the server reported listening, a fabric, or an onboarding code." }
        : { id: "matter", label: "Confirm Matter startup", status: "unknown", detail: "Not yet performed. A USB installation does not wait for Matter commissioning." };

  const thread: StartupCheck = threadFailed
    ? { id: "openthread", label: "Confirm OpenThread startup", status: "failed", detail: "OpenThread logged a failure." }
    : threadSeen && !threadFailed
      ? { id: "openthread", label: "Confirm OpenThread startup", status: "passed", detail: "An OpenThread line was seen. Joining a network was not observed." }
      : { id: "openthread", label: "Confirm OpenThread startup", status: "unknown", detail: "OpenThread startup was not observed." };

  const dht: StartupCheck = dhtFailed
    ? { id: "dht11", label: "Confirm DHT11 driver initialisation", status: "failed", detail: "The DHT11 driver logged an initialisation failure." }
    : dhtSeen
      ? { id: "dht11", label: "Confirm DHT11 driver initialisation", status: "passed", detail: "The DHT11 task logged. A reading is not evidence of Matter commissioning or a healthy sensor installation." }
      : { id: "dht11", label: "Confirm DHT11 driver initialisation", status: "unknown", detail: "DHT11 initialisation was not observed." };

  const version: StartupCheck = versionMatch && versionMatch[1] === input.versionString
    ? { id: "version", label: "Record firmware version", status: "passed", detail: `Serial banner reports ${versionMatch[1]}.` }
    : versionMatch
      ? { id: "version", label: "Record firmware version", status: "failed", detail: `Serial banner reports ${versionMatch[1]}, not ${input.versionString}.` }
      : { id: "version", label: "Record firmware version", status: "unknown", detail: "The application version banner was not captured." };

  const factory: StartupCheck = {
    id: "factory_reset",
    label: "Verify GPIO9 factory reset when safe",
    status: "unknown",
    detail: "Not observed. Hold GPIO9 for 5 seconds only when removing Matter fabrics is acceptable. Flashing does not perform this check.",
  };

  return [connect, serial, write, boot, matter, thread, dht, version, factory];
}

const COMMISSIONING_EVIDENCE = ["boot", "matter", "openthread", "version"] as const;

export function installationSummary(checks: StartupCheck[], writeStatus: ProgramSession["status"]): string | null {
  if (writeStatus === "failed" || writeStatus === "interrupted") return "Firmware Installation Failed.";
  if (writeStatus !== "succeeded") return null;
  const required = COMMISSIONING_EVIDENCE.map((id) => checks.find((item) => item.id === id)?.status);
  if (required.every((item) => item === "passed")) return "Firmware Installed and Verified.";
  if (required.some((item) => item === "failed")) return "Firmware Installed — Verification Failed.";
  const boot = checks.find((item) => item.id === "boot")?.status;
  if (boot === "passed") return INSTALL_SUCCEEDED_COMMISSIONING_NOT_PERFORMED;
  return FLASH_VERIFIED_BOOT_PENDING;
}

/** A finished capture with device text but no application startup is a completed negative result. */
export function bootResultMessage(monitorLog: string, checks: StartupCheck[], writeStatus: ProgramSession["status"]): string | null {
  const summary = installationSummary(checks, writeStatus);
  const captured = bootCaptureMessage(monitorLog);
  if (captured) return captured;
  const boot = checks.find((item) => item.id === "boot")?.status;
  const deviceText = monitorLog.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("note:");
  });
  if (writeStatus === "succeeded" && boot === "unknown" && deviceText && !applicationBootSeen(monitorLog)) {
    return FLASH_VERIFIED_BOOT_UNSEEN;
  }
  return summary;
}

export function bootEvidenceReady(checks: StartupCheck[]): boolean {
  const boot = checks.find((item) => item.id === "boot")?.status;
  if (boot === "passed" || boot === "failed") return true;
  const summary = installationSummary(checks, "succeeded");
  return summary === "Firmware Installed and Verified."
    || summary === "Firmware Installed — Verification Failed.";
}

function defaultExecutor(script: string, baseEnv: NodeJS.ProcessEnv = process.env): ToolExecutor {
  return {
    run(args, signal, onLog) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          resolve({ code: 1, text: "", cancelled: true });
          return;
        }
        const child = spawn(script, args, { detached: true, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
        let cancelled = false;
        let text = "";
        const onAbort = () => {
          cancelled = true;
          onLog("note: cancellation requested. Stopping the USB tool.");
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
          }
        };
        signal.addEventListener("abort", onAbort);
        const emit = (chunk: Buffer) => {
          const piece = chunk.toString("utf8");
          text += piece;
          for (const line of piece.split(/\r?\n/)) {
            if (line) onLog(line.slice(0, 2000));
          }
        };
        child.stdout?.on("data", emit);
        child.stderr?.on("data", emit);
        child.on("error", (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ code: code ?? 1, text, cancelled });
        });
      });
    },
  };
}

async function runTimed(
  executor: ToolExecutor,
  args: string[],
  signal: AbortSignal,
  onLog: (line: string) => void,
  timeoutMs: number,
  exitGraceMs = 5_000,
): Promise<ToolRun & { timedOut: boolean }> {
  const local = new AbortController();
  const onParent = () => local.abort();
  if (signal.aborted) local.abort();
  else signal.addEventListener("abort", onParent);
  let timedOut = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let lostResolve: (result: ToolRun) => void = () => undefined;
  const lostExit = new Promise<ToolRun>((resolve) => {
    lostResolve = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    local.abort();
    grace = setTimeout(() => {
      lostResolve({ code: 1, text: "note: the USB tool did not report an exit", cancelled: true });
    }, exitGraceMs);
  }, timeoutMs);
  try {
    const result = await Promise.race([executor.run(args, local.signal, onLog), lostExit]);
    return { ...result, timedOut: timedOut && !signal.aborted };
  } finally {
    clearTimeout(timer);
    if (grace) clearTimeout(grace);
    signal.removeEventListener("abort", onParent);
  }
}

export async function runUsbWrite(spec: UsbRunnerSpec, executor?: ToolExecutor): Promise<UsbRunnerResult> {
  if (!isAllowedSerialPort(spec.port)) {
    return { ok: false, cancelled: false, diagnostic: "The serial port is not an allowed local USB device." };
  }
  if (spec.writeArgs[0] !== "write-flash" || spec.writeArgs.some(forbiddenToken) || spec.writeArgs.some((arg) => arg.endsWith("usb-image.bin"))) {
    return { ok: false, cancelled: false, diagnostic: "The write command was rejected before it started." };
  }
  const tool = executor ?? defaultExecutor(path.join(spec.repoRoot, "scripts/idf_exec.sh"), spec.env);
  const timeoutMs = spec.timeoutMs ?? 180_000;
  try {
    const probe = await runTimed(tool, ["chip-id", spec.port], spec.signal, spec.onLog, timeoutMs, spec.exitGraceMs);
    if (probe.timedOut) {
      return { ok: false, cancelled: false, timedOut: true, diagnostic: "The board did not answer the chip probe. The firmware was not written." };
    }
    if (probe.cancelled || spec.signal.aborted) return { ok: false, cancelled: true, diagnostic: null };
    if (!chipProbeAccepted(probe.code, probe.text)) {
      return { ok: false, cancelled: false, diagnostic: writeDiagnostic(probe.text, false) };
    }
    spec.onLog("note: ESP32-H2 responded. Writing the bootloader, partition table, OTA selection data, and application. NVS is not erased.");
    const wrote = await runTimed(tool, spec.writeArgs, spec.signal, spec.onLog, timeoutMs, spec.exitGraceMs);
    if (wrote.timedOut) return { ok: false, cancelled: false, timedOut: true, diagnostic: FLASH_RESULT_UNKNOWN };
    if (wrote.cancelled || spec.signal.aborted) return { ok: false, cancelled: true, diagnostic: null };
    if (wrote.code !== 0) return { ok: false, cancelled: false, diagnostic: writeDiagnostic(wrote.text, false) };
    return { ok: true, cancelled: false, diagnostic: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "USB tool failed to start";
    return { ok: false, cancelled: false, diagnostic: message };
  }
}

export async function runApplicationReset(
  spec: { repoRoot: string; port: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; detail: string }> {
  if (!isAllowedSerialPort(spec.port)) return { ok: false, detail: "The programming port is not an allowed local USB device." };
  const script = path.join(spec.repoRoot, "scripts/idf_exec.sh");
  const executor = defaultExecutor(script, spec.env);
  const signal = spec.signal ?? new AbortController().signal;
  try {
    const result = await runTimed(executor, ["app-reset", spec.port], signal, () => undefined, 25_000);
    if (result.cancelled) return { ok: false, detail: "The application reset was cancelled." };
    if (result.timedOut || result.code !== 0) {
      return { ok: false, detail: "The automatic reset did not finish. Press the board RESET button once. Do not hold BOOT." };
    }
    return { ok: true, detail: "The application was reset. Flash was not erased." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "The application reset did not start." };
  }
}

export async function runSerialMonitor(
  spec: { repoRoot: string; port: string; signal: AbortSignal; onLog: (line: string) => void; env?: NodeJS.ProcessEnv },
  executor?: ToolExecutor,
): Promise<{ cancelled: boolean; code: number }> {
  if (!isAllowedSerialPort(spec.port)) {
    spec.onLog("could not open port: rejected port");
    return { cancelled: false, code: 1 };
  }
  const tool = executor ?? defaultExecutor(path.join(spec.repoRoot, "scripts/idf_exec.sh"), spec.env);
  try {
    const result = await tool.run(["monitor", spec.port, "115200"], spec.signal, spec.onLog);
    return { cancelled: result.cancelled || spec.signal.aborted, code: result.code };
  } catch (error) {
    spec.onLog(error instanceof Error ? error.message : "could not open port");
    return { cancelled: false, code: 1 };
  }
}

export interface FlashIo {
  chip(port: string): Promise<{ code: number; text: string }>;
  flash(port: string): Promise<{ code: number; text: string }>;
  security(port: string): Promise<{ code: number; text: string }>;
  read(port: string, offset: number, size: number): Promise<Buffer>;
  erase(port: string): Promise<{ code: number; text: string; cancelled: boolean }>;
}

export function createFlashIo(repoRoot: string, env: NodeJS.ProcessEnv = process.env): FlashIo {
  const script = path.join(repoRoot, "scripts/idf_exec.sh");
  async function command(args: string[], timeoutMs: number): Promise<ToolRun & { timedOut: boolean }> {
    return runTimed(defaultExecutor(script, env), args, new AbortController().signal, () => undefined, timeoutMs);
  }
  return {
    async chip(port) {
      const result = await command(["chip-id", port], 45_000);
      return { code: result.timedOut ? 1 : result.code, text: redactSerialLog(result.text) };
    },
    async flash(port) {
      const result = await command(["flash-id", port, "--stay"], 45_000);
      return { code: result.timedOut ? 1 : result.code, text: redactSerialLog(result.text) };
    },
    async security(port) {
      const result = await command(["security-info", port], 30_000);
      return { code: result.timedOut ? 1 : result.code, text: result.text };
    },
    async read(port, offset, size) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size <= 0 || size > 0x1000000) {
        throw new Error("The flash read range was rejected.");
      }
      const directory = await mkdtemp(path.join(tmpdir(), "iotedu-read-"));
      const output = path.join(directory, "region.bin");
      try {
        const result = await command([
          "read-flash",
          port,
          `0x${offset.toString(16)}`,
          `0x${size.toString(16)}`,
          output,
        ], size > 0x10000 ? 180_000 : 40_000);
        if (result.code !== 0 || result.timedOut) throw new Error("The flash read failed.");
        const bytes = await readFile(output);
        if (bytes.length !== size) throw new Error("The flash read length did not match the request.");
        return bytes;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async erase(port) {
      const result = await command(["erase-flash", port, "--confirm-blank"], 120_000);
      return { code: result.timedOut ? 1 : result.code, text: redactSerialLog(result.text), cancelled: result.cancelled };
    },
  };
}
