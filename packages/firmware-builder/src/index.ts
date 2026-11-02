import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { ComponentManifest, ValidationIssue } from "@iotedu/contracts";
import { repositoryPaths } from "@iotedu/contracts/paths";

export interface PartitionRow {
  name: string;
  type: string;
  subtype: string;
  offset: number | null;
  size: number;
  flags: string;
}

export interface BoardProfile {
  id: string;
  target: string;
  gpioMin: number;
  gpioMax: number;
  reservedGpio: { gpio: number; reason: string }[];
  adc1Channels?: { channel: number; gpio: number }[];
  flashSizeBytes: number;
  bootloaderOffset: number;
  partitionTableOffset: number;
}

export interface PinAssignment {
  componentId: string;
  pinName: string;
  gpio: number;
}

export function parsePartitionCsv(text: string): PartitionRow[] {
  const rows: PartitionRow[] = [];
  let cursor = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",").map((part) => part.trim());
    const name = parts[0] ?? "";
    const type = parts[1] ?? "";
    const subtype = parts[2] ?? "";
    const offsetText = parts[3] ?? "";
    const sizeText = parts[4] ?? "";
    const flags = parts[5] ?? "";
    if (!name || !sizeText) {
      throw new Error(`Unreadable partition row: ${line}`);
    }
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error(`Bad partition size for ${name}`);
    let offset: number | null = offsetText ? parseInt(offsetText, 16) : null;
    if (offsetText && !Number.isFinite(offset)) throw new Error(`Bad partition offset for ${name}`);
    if (offset === null) {
      offset = cursor;
    }
    rows.push({ name, type, subtype, offset, size, flags });
    cursor = offset + size;
  }
  return rows;
}

export function partitionLayoutId(input: {
  partitions: PartitionRow[];
  flashSizeBytes: number;
  bootloaderOffset: number;
  partitionTableOffset: number;
}): string {
  const canonical = [
    `flash=${input.flashSizeBytes}`,
    `bootloader=${input.bootloaderOffset}`,
    `table=${input.partitionTableOffset}`,
    ...input.partitions.map(
      (row) =>
        `${row.name}|${row.type}|${row.subtype}|${row.offset}|${row.size}|${row.flags}`,
    ),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function loadReferenceLayout(repoRoot: string, profile: BoardProfile) {
  const text = await readFile(path.join(repositoryPaths(repoRoot).firmwareTemplateRoot, "partitions.csv"), "utf8");
  const partitions = parsePartitionCsv(text);
  return {
    partitions,
    layoutId: partitionLayoutId({
      partitions,
      flashSizeBytes: profile.flashSizeBytes,
      bootloaderOffset: profile.bootloaderOffset,
      partitionTableOffset: profile.partitionTableOffset,
    }),
  };
}

export function detectGpioConflicts(profile: BoardProfile, pins: PinAssignment[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<number, PinAssignment>();
  for (const pin of pins) {
    if (pin.gpio < profile.gpioMin || pin.gpio > profile.gpioMax) {
      issues.push({
        level: "error",
        code: "gpio_out_of_range",
        message: `${pin.pinName} GPIO${pin.gpio} is outside ESP32-H2 GPIO ${profile.gpioMin}-${profile.gpioMax}`,
      });
      continue;
    }
    const reserved = profile.reservedGpio.find((item) => item.gpio === pin.gpio);
    if (reserved) {
      issues.push({
        level: "error",
        code: "gpio_reserved",
        message: `${pin.pinName} cannot use GPIO${pin.gpio}: ${reserved.reason}`,
      });
    }
    const previous = seen.get(pin.gpio);
    if (previous) {
      issues.push({
        level: "error",
        code: "gpio_conflict",
        message: `GPIO${pin.gpio} is assigned to both ${previous.pinName} (${previous.componentId}) and ${pin.pinName} (${pin.componentId})`,
      });
    } else {
      seen.set(pin.gpio, pin);
    }
  }
  return issues;
}

export function renderVersionSdkconfig(versionNumber: number, versionString: string): string {
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    throw new Error("Software version number must be a positive integer");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(versionString)) {
    throw new Error("Software version string contains unsupported characters");
  }
  return [
    `# One version pair for the application description and Matter Basic Information.`,
    `# CONFIG_APP_PROJECT_VER_FROM_CONFIG makes CONFIG_APP_PROJECT_VER the app-description string`,
    `# and CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER the Matter SoftwareVersion.`,
    `CONFIG_APP_PROJECT_VER_FROM_CONFIG=y`,
    `CONFIG_APP_PROJECT_VER="${versionString}"`,
    `CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=${versionNumber}`,
    `# CMake must repeat both. ota_image_tool.py reads PROJECT_VER and PROJECT_VER_NUMBER.`,
    `# set(PROJECT_VER "${versionString}")`,
    `# set(PROJECT_VER_NUMBER ${versionNumber})`,
    "",
  ].join("\n");
}

export function selectionIssues(
  manifests: ComponentManifest[],
  componentIds: string[],
  mode: "mock" | "native" | "docker",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(manifests.map((item) => [item.id, item]));
  for (const id of componentIds) {
    const manifest = byId.get(id);
    if (!manifest) {
      issues.push({ level: "error", code: "unknown_component", message: `Unknown component ${id}` });
      continue;
    }
    if (!manifest.selectableForBuild || manifest.status === "planned" || manifest.status === "template") {
      issues.push({
        level: "error",
        code: "component_not_buildable",
        message: `${manifest.name} is ${manifest.status} and cannot be included in a firmware package`,
      });
      continue;
    }
    if (mode !== "mock" && manifest.firmware?.registerFunction == null && manifest.type !== "core") {
      issues.push({
        level: "error",
        code: "native_component_not_ready",
        message: `${manifest.name} has no modular register function, so it cannot enter a native build`,
      });
    }
  }
  if (mode === "docker") {
    issues.push({
      level: "error",
      code: "toolchain_mode_unavailable",
      message: "Docker builds are not available. Native builds use the local ESP-IDF v5.4.1 environment when it is configured.",
    });
  }
  return issues;
}

export function versionSupersedes(candidate: number, installed: number): boolean {
  return Number.isInteger(candidate) && Number.isInteger(installed) && candidate > installed;
}

export function applyCmakeProjectVersion(cmake: string, versionNumber: number, versionString: string): string {
  renderVersionSdkconfig(versionNumber, versionString);
  if (!cmake.includes('set(PROJECT_VER "') || !cmake.includes("set(PROJECT_VER_NUMBER ")) {
    throw new Error("Reference CMake version fields were not found");
  }
  return cmake
    .replace(/set\(PROJECT_VER "[^"]*"\)/, `set(PROJECT_VER "${versionString}")`)
    .replace(/set\(PROJECT_VER_NUMBER \d+\)/, `set(PROJECT_VER_NUMBER ${versionNumber})`);
}

export interface AppDescription {
  version: string;
  project: string;
  idf: string;
}

export function readAppDescription(binary: Buffer): AppDescription {
  const magic = Buffer.from([0x32, 0x54, 0xcd, 0xab]);
  const offset = binary.indexOf(magic);
  if (offset < 0) throw new Error("Application description magic was not found in the firmware image");
  const field = (start: number, length: number) =>
    binary.subarray(offset + start, offset + start + length).toString("utf8").split("\0")[0] ?? "";
  return {
    version: field(16, 32),
    project: field(48, 32),
    idf: field(112, 32),
  };
}

export interface OtaHeaderInfo {
  vendorId: number;
  productId: number;
  version: number;
  versionString: string;
}

export function parseOtaShow(text: string): OtaHeaderInfo {
  if (!/Magic:\s*1beef11e/i.test(text)) {
    throw new Error("OTA show output does not contain the Matter image magic");
  }
  const vendor = text.match(/Vendor Id:\s*(\d+)/);
  const product = text.match(/Product Id:\s*(\d+)/);
  const version = text.match(/\n\s*\[\d+\] Version:\s*(\d+)/);
  const versionString = text.match(/Version String:\s*(.+)/);
  if (!vendor?.[1] || !product?.[1] || !version?.[1] || !versionString?.[1]) {
    throw new Error("OTA show output is missing vendor, product, or version fields");
  }
  return {
    vendorId: Number(vendor[1]),
    productId: Number(product[1]),
    version: Number(version[1]),
    versionString: versionString[1].trim(),
  };
}

export function sdkconfigValue(sdkconfig: string, key: string): string | null {
  const match = sdkconfig.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match?.[1]) return null;
  return match[1].replace(/^"(.*)"$/, "$1");
}

export function firmwareCompatibilityIssues(input: {
  sdkconfig: string;
  layoutId: string;
  expectedLayoutId: string;
  softwareVersion: number;
  softwareVersionString: string;
  dht11Gpio: number;
  pinExpectations?: { key: string; value: string }[];
  expectedProductId?: number;
  appBytes: number;
  slotBytes: number;
  appVersion: string;
  appProject: string;
  ota: OtaHeaderInfo | null;
  vendorId: number;
  productId: number;
  dependencyLockMatchesReference: boolean;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expect = (key: string, value: string, code: string, message: string) => {
    if (sdkconfigValue(input.sdkconfig, key) !== value) {
      issues.push({ level: "error", code, message });
    }
  };
  expect("CONFIG_IDF_TARGET", "esp32h2", "target_mismatch", "Compiled target is not ESP32-H2");
  expect("CONFIG_ENABLE_OTA_REQUESTOR", "y", "ota_requestor_disabled", "OTA Requestor is not enabled");
  expect("CONFIG_MAX_FABRICS", "5", "multi_fabric_disabled", "Multi-fabric support is not the reference maximum of 5");
  expect("CONFIG_OPENTHREAD_ENABLED", "y", "openthread_disabled", "OpenThread is not enabled");
  if (input.pinExpectations) {
    for (const pin of input.pinExpectations) {
      expect(pin.key, pin.value, "gpio_mismatch", `Compiled ${pin.key} is not ${pin.value}`);
    }
  } else {
    expect(
      "CONFIG_IOTEDU_DHT11_PIN",
      String(input.dht11Gpio),
      "dht11_pin_mismatch",
      `Compiled DHT11 pin does not match GPIO${input.dht11Gpio}`,
    );
  }
  expect(
    "CONFIG_APP_PROJECT_VER_FROM_CONFIG",
    "y",
    "version_source_mismatch",
    "Application version is not taken from the generated version pair",
  );
  expect(
    "CONFIG_APP_PROJECT_VER",
    input.softwareVersionString,
    "version_string_mismatch",
    `Application version string is not ${input.softwareVersionString}`,
  );
  expect(
    "CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER",
    String(input.softwareVersion),
    "version_number_mismatch",
    `Matter software version number is not ${input.softwareVersion}`,
  );
  if (input.layoutId !== input.expectedLayoutId) {
    issues.push({
      level: "error",
      code: "partition_layout_mismatch",
      message: "Partition layout does not match the reference ESP32-H2 table",
    });
  }
  if (!input.dependencyLockMatchesReference) {
    issues.push({
      level: "error",
      code: "dependency_lock_changed",
      message: "The component manager changed dependencies.lock. The reference lock was not updated.",
    });
  }
  issues.push(...appFitsPartition(input.appBytes, input.slotBytes));
  if (input.appVersion !== input.softwareVersionString || input.appProject !== "sensors") {
    issues.push({
      level: "error",
      code: "app_description_mismatch",
      message: `Application description is ${input.appProject} ${input.appVersion}, expected sensors ${input.softwareVersionString}`,
    });
  }
  if (!input.ota) {
    issues.push({
      level: "error",
      code: "matter_ota_missing",
      message: "The Matter OTA image was not produced",
    });
  } else if (
    input.ota.vendorId !== input.vendorId ||
    input.ota.productId !== input.productId ||
    input.ota.version !== input.softwareVersion ||
    input.ota.versionString !== input.softwareVersionString
  ) {
    issues.push({
      level: "error",
      code: "ota_header_mismatch",
      message: `OTA header ${input.ota.vendorId}/${input.ota.productId} ${input.ota.version} ${input.ota.versionString} does not match the compiled firmware`,
    });
  }
  const expectedProductId = input.expectedProductId ?? 0x8000;
  if (input.vendorId !== 0xfff1 || input.productId !== expectedProductId) {
    issues.push({
      level: "error",
      code: "identity_mismatch",
      message: `Vendor and product identifiers are not VID 0xFFF1 and PID 0x${expectedProductId.toString(16).toUpperCase()}`,
    });
  }
  return issues;
}

export type ProgrammingToolCode = "ok" | "toolchain_not_installed" | "toolchain_not_activated" | "tools_unavailable";

export interface ToolchainInspection {
  nativeAvailable: boolean;
  programmingAvailable: boolean;
  programmingCode: ProgrammingToolCode;
  idfPathConfigured: boolean;
  espMatterPathConfigured: boolean;
  activateConfigured: boolean;
  source: "environment" | "discovered" | "incomplete";
  detail: string;
  childEnv: NodeJS.ProcessEnv;
}

async function fileExists(file: string | undefined): Promise<boolean> {
  if (!file) return false;
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function isIdf541(idfPath: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(idfPath, "tools", "cmake", "version.cmake"), "utf8");
    return /IDF_VERSION_MAJOR\s+5/.test(text) && /IDF_VERSION_MINOR\s+4/.test(text) && /IDF_VERSION_PATCH\s+1/.test(text);
  } catch {
    return false;
  }
}

export async function inspectToolchain(env: NodeJS.ProcessEnv = process.env): Promise<ToolchainInspection> {
  const idfPathConfigured = await fileExists(env.IDF_PATH ? path.join(env.IDF_PATH, "tools", "idf.py") : undefined)
    && (env.IDF_PATH ? await isIdf541(env.IDF_PATH) : false);
  const espMatterPathConfigured = await fileExists(env.ESP_MATTER_PATH ? path.join(env.ESP_MATTER_PATH, "components") : undefined);
  const activateConfigured = await fileExists(env.IDF_ACTIVATE);
  const programmingAvailable = idfPathConfigured && activateConfigured;
  const nativeAvailable = programmingAvailable && espMatterPathConfigured;
  const programmingCode: ProgrammingToolCode = !idfPathConfigured
    ? "toolchain_not_installed"
    : !activateConfigured
      ? "toolchain_not_activated"
      : "ok";
  return {
    nativeAvailable,
    programmingAvailable,
    programmingCode,
    idfPathConfigured,
    espMatterPathConfigured,
    activateConfigured,
    source: nativeAvailable ? "environment" : "incomplete",
    detail: programmingDetail({ idfPathConfigured, activateConfigured, programmingAvailable, espMatterPathConfigured, nativeAvailable, activated: true }),
    childEnv: env,
  };
}

function programmingDetail(input: {
  idfPathConfigured: boolean;
  activateConfigured: boolean;
  programmingAvailable: boolean;
  espMatterPathConfigured: boolean;
  nativeAvailable: boolean;
  activated: boolean;
}): string {
  if (!input.idfPathConfigured) {
    return "ESP-IDF v5.4.1 is not installed. IoT.Edu looked for the v5.4.1 toolchain. A missing toolchain is not a missing USB device.";
  }
  if (!input.activateConfigured) {
    return "ESP-IDF v5.4.1 is installed, but its activation script was not found. The programming environment is not activated.";
  }
  if (!input.programmingAvailable) {
    return "ESP-IDF v5.4.1 was found, but the programming tools could not be started.";
  }
  if (!input.espMatterPathConfigured) {
    return "ESP-IDF v5.4.1 programming tools are available. ESP_MATTER_PATH was not found, so firmware compilation stays unavailable. Chip identification does not need it.";
  }
  return input.nativeAvailable
    ? "ESP-IDF v5.4.1 programming tools are available. A manual export in the terminal is not required."
    : "ESP-IDF v5.4.1 programming tools are available.";
}

export async function discoverToolchain(env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? env.USERPROFILE ?? ""): Promise<ToolchainInspection> {
  const idfFromEnv = env.IDF_PATH && await fileExists(path.join(env.IDF_PATH, "tools", "idf.py")) && await isIdf541(env.IDF_PATH) ? env.IDF_PATH : null;
  const matterFromEnv = env.ESP_MATTER_PATH && await fileExists(path.join(env.ESP_MATTER_PATH, "components")) ? env.ESP_MATTER_PATH : null;
  const activateFromEnv = env.IDF_ACTIVATE && await fileExists(env.IDF_ACTIVATE) ? env.IDF_ACTIVATE : null;
  const idfCandidate = path.join(home, ".espressif", "v5.4.1", "esp-idf");
  const matterCandidate = path.join(home, "esp", "esp-matter");
  const activateCandidate = path.join(home, ".espressif", "tools", "activate_idf_v5.4.1.sh");
  const idfPath = idfFromEnv ?? (await fileExists(path.join(idfCandidate, "tools", "idf.py")) && await isIdf541(idfCandidate) ? idfCandidate : null);
  const espMatterPath = matterFromEnv ?? (await fileExists(path.join(matterCandidate, "components")) ? matterCandidate : null);
  const activate = activateFromEnv
    ?? (await fileExists(activateCandidate) ? activateCandidate : null)
    ?? (idfPath && await fileExists(path.join(idfPath, "export.sh")) ? path.join(idfPath, "export.sh") : null);
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (idfPath) childEnv.IDF_PATH = idfPath;
  if (espMatterPath) childEnv.ESP_MATTER_PATH = espMatterPath;
  if (activate) childEnv.IDF_ACTIVATE = activate;
  const programmingAvailable = Boolean(idfPath && activate);
  const nativeAvailable = programmingAvailable && Boolean(espMatterPath);
  const usedDiscovery = programmingAvailable && !(idfFromEnv && activateFromEnv && matterFromEnv);
  const programmingCode: ProgrammingToolCode = idfPath ? (activate ? "ok" : "toolchain_not_activated") : "toolchain_not_installed";
  return {
    nativeAvailable,
    programmingAvailable,
    programmingCode,
    idfPathConfigured: Boolean(idfPath),
    espMatterPathConfigured: Boolean(espMatterPath),
    activateConfigured: Boolean(activate),
    source: programmingAvailable ? (usedDiscovery ? "discovered" : "environment") : "incomplete",
    detail: programmingDetail({
      idfPathConfigured: Boolean(idfPath),
      activateConfigured: Boolean(activate),
      programmingAvailable,
      espMatterPathConfigured: Boolean(espMatterPath),
      nativeAvailable,
      activated: true,
    }),
    childEnv,
  };
}

export function appFitsPartition(appBytes: number, slotBytes: number): ValidationIssue[] {
  if (appBytes > slotBytes) {
    return [
      {
        level: "error",
        code: "firmware_too_large",
        message: `Application image ${appBytes} bytes exceeds the OTA slot ${slotBytes} bytes`,
      },
    ];
  }
  if (appBytes > slotBytes * 0.9) {
    return [
      {
        level: "warning",
        code: "firmware_near_capacity",
        message: `Application image uses more than 90% of the ${slotBytes}-byte OTA slot`,
      },
    ];
  }
  return [];
}

export { encodeMatterOtaImage, inspectMatterOtaImage, ESP32H2_CHIP_ID, type MatterOtaInspection } from "./ota-image.js";
export { safeRelativePath, safeUploadName } from "./library-paths.js";
export { extractSafeZip, UnsafeArchiveError, zipCrc32 } from "./safe-zip.js";
export { compileLibraryComponent } from "./library-compile.js";
export { nextSoftwareVersion } from "./firmware-release.js";
export {
  approvedLibraryRecords,
  libraryFingerprint,
  sourceContentHash,
  validateLibraryComponent,
  type LibraryBoardProfile,
  type NativeCompileReport,
  type LibraryCheckInput,
  type LibraryCheckResult,
  type LibraryCheckedFile,
  type LibraryGpioInput,
  type LibrarySourceFile,
} from "./library-validation.js";
