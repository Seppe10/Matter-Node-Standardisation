import { z } from "zod";

export const commissioningStateSchema = z.enum(["uncommissioned", "commissioned", "unknown"]);
export type CommissioningState = z.infer<typeof commissioningStateSchema>;

export const windowNowSchema = z.enum(["open", "closed", "unknown"]);
export type WindowNow = z.infer<typeof windowNowSchema>;

export const flashImageResultSchema = z.object({
  label: z.string(),
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative().nullable(),
  hashVerified: z.boolean(),
  seconds: z.number().nullable(),
});
export type FlashImageResult = z.infer<typeof flashImageResultSchema>;

export const EXPECTED_FLASH_OFFSETS = [0x0, 0xc000, 0x1d000, 0x20000] as const;

export const macSourceSchema = z.enum(["base_mac", "bluetooth_mac", "chip_id", "stored_session", "unverified"]);
export type MacSource = z.infer<typeof macSourceSchema>;

export const hardwareInstallationSchema = z.object({
  mac: z.string().nullable(),
  macSource: macSourceSchema.optional(),
  identityDetail: z.string().optional(),
  programmingPort: z.string(),
  consolePort: z.string().nullable(),
  buildId: z.string(),
  sessionId: z.string(),
  softwareVersion: z.number().int().nullable(),
  softwareVersionString: z.string(),
  vendorId: z.number().int().nullable(),
  productId: z.number().int().nullable(),
  writeCompleted: z.boolean(),
  bootVerified: z.boolean(),
  matterReady: z.boolean(),
  matterStartup: z.enum(["started", "failed", "unknown"]).optional(),
  nvsPreserved: z.boolean().optional(),
  threadReady: z.boolean(),
  versionVerified: z.boolean(),
  dht11: z.enum(["passed", "failed", "unknown"]),
  commissioningState: commissioningStateSchema,
  commissioningWindowOpen: z.boolean().nullable(),
  windowNow: windowNowSchema,
  lastWindowEvent: z.enum(["ble_advertising_started", "window_opened", "window_closed", "window_failed"]).nullable(),
  bleAdvertisingObserved: z.boolean(),
  dnsSdWarning: z.string().nullable(),
  appleHomeFabric: z.boolean(),
  fabricVendors: z.array(z.string()),
  managedNodeId: z.string().nullable(),
  commissioningDetail: z.string(),
  commissioningObservedAt: z.string().nullable(),
  onboardingStatus: z.enum(["verified", "image_verified", "not_verified", "invalid"]),
  onboardingReason: z.string(),
  onboardingPayload: z.enum(["consistent", "invalid", "unknown"]),
  firmwareImageIdentity: z.enum(["verified", "mismatch", "unknown"]),
  discriminatorEvidence: z.enum(["live_match", "live_mismatch", "redacted", "absent"]),
  deviceOnboarding: z.object({
    qrPayload: z.string(),
    manualCode: z.string(),
  }).nullable().optional(),
  startupStages: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["passed", "failed", "not_reached", "unverified", "not_applicable"]),
    detail: z.string(),
  })).optional(),
  flashImages: z.array(flashImageResultSchema),
  startedAt: z.string(),
  elapsedSeconds: z.number().nullable(),
  updatedAt: z.string(),
});
export type HardwareInstallation = z.infer<typeof hardwareInstallationSchema>;

export const DEVELOPMENT_ONBOARDING = {
  softwareVersion: 4,
  softwareVersionString: "1.3.0",
  vendorId: 0xfff1,
  productId: 0x8000,
  passcode: 20202021,
  discriminator: 0xf00,
  qrPayload: "MT:Y.K9042C00KA0648G00",
  manualCode: "34970112332",
} as const;

const COMPILED_TEST_PASSCODE = 20202021;
const COMPILED_TEST_DISCRIMINATOR = 0xf00;
const COMPILED_TEST_DISCOVERY = 0x02;

export interface CompiledTestOnboarding {
  vendorId: number;
  productId: number;
  passcode: number;
  discriminator: number;
  qrPayload: string;
  manualCode: string;
}

function writeBits(bytes: number[], offset: number, count: number, value: number): number {
  for (let index = 0; index < count; index += 1) {
    const position = offset + index;
    const byteIndex = position >> 3;
    while (bytes.length <= byteIndex) bytes.push(0);
    if ((value & (1 << index)) !== 0) bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (position & 7));
  }
  return offset + count;
}

function encodeBase38(bytes: number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length;) {
    const remaining = bytes.length - index;
    const width = remaining >= 3 ? 3 : remaining === 2 ? 2 : 1;
    const chars = width === 3 ? 5 : width === 2 ? 4 : 2;
    let value = 0;
    for (let cursor = 0; cursor < width; cursor += 1) value |= (bytes[index + cursor] ?? 0) << (8 * cursor);
    for (let cursor = 0; cursor < chars; cursor += 1) {
      out += BASE38[value % 38] ?? "";
      value = Math.floor(value / 38);
    }
    index += width;
  }
  return out;
}

function verhoeffDigit(body: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    if (verhoeffValid(`${body}${digit}`)) return String(digit);
  }
  return "";
}

function manualPairingCode(passcode: number, discriminator: number): string {
  const short = discriminator >> 8;
  const chunk1 = (short >> 2) & 0x3;
  const chunk2 = (passcode & 0x3fff) | ((short & 0x3) << 14);
  const chunk3 = (passcode >> 14) & 0x1fff;
  const body = `${chunk1}${String(chunk2).padStart(5, "0")}${String(chunk3).padStart(4, "0")}`;
  return `${body}${verhoeffDigit(body)}`;
}

/** Matter QR for the compiled CHIP test passcode and discriminator. Discovery is BLE, matching the checked product 0x8000 payload. */
export function compiledTestOnboarding(vendorId: number | null, productId: number | null): CompiledTestOnboarding | null {
  if (vendorId !== 0xfff1 || productId == null || productId < 0 || productId > 0xffff) return null;
  const bytes: number[] = [];
  let offset = 0;
  offset = writeBits(bytes, offset, 3, 0);
  offset = writeBits(bytes, offset, 16, vendorId);
  offset = writeBits(bytes, offset, 16, productId);
  offset = writeBits(bytes, offset, 2, 0);
  offset = writeBits(bytes, offset, 8, COMPILED_TEST_DISCOVERY);
  offset = writeBits(bytes, offset, 12, COMPILED_TEST_DISCRIMINATOR);
  offset = writeBits(bytes, offset, 27, COMPILED_TEST_PASSCODE);
  writeBits(bytes, offset, 4, 0);
  const manualCode = manualPairingCode(COMPILED_TEST_PASSCODE, COMPILED_TEST_DISCRIMINATOR);
  const qrPayload = `MT:${encodeBase38(bytes)}`;
  const decoded = decodeMatterPayload(qrPayload, manualCode);
  if (!decoded || decoded.vendorId !== vendorId || decoded.productId !== productId || decoded.passcode !== COMPILED_TEST_PASSCODE || decoded.discriminator !== COMPILED_TEST_DISCRIMINATOR || !decoded.manualCodeMatches) return null;
  return { vendorId, productId, passcode: COMPILED_TEST_PASSCODE, discriminator: COMPILED_TEST_DISCRIMINATOR, qrPayload, manualCode };
}

const STARTUP_CHECKS = ["boot", "matter", "openthread", "version"] as const;

export interface FirmwareStage {
  id: string;
  label: string;
  status: "passed" | "failed" | "not_reached" | "unverified" | "not_applicable";
  detail: string;
}

export function firmwareStartupStages(input: {
  writeCompleted: boolean;
  checks?: Array<{ id: string; status: string }>;
  monitorLog: string;
}): FirmwareStage[] {
  const statusOf = (id: string) => input.checks?.find((item) => item.id === id)?.status;
  const boot = statusOf("boot");
  const matter = statusOf("matter");
  const rgbLog = /rgb_led:|rgb_matter:|Failed to register the RGB light/.test(input.monitorLog);
  const ledReady = input.monitorLog.includes("RGB LED initialised");
  const ledcFailed = /ledc_\w+ failed:/.test(input.monitorLog);
  const attributeMissing = input.monitorLog.includes("was not found on endpoint") || (ledReady && input.monitorLog.includes("Failed to register the RGB light"));
  const matterServer = /Server Listening|Fabric already commissioned|Existing Matter fabric count|SetupQRCode:|CHIPoBLE advertising started/i.test(input.monitorLog);
  const matterStack = /chip\[DL\]|OpenThread started/i.test(input.monitorLog);
  const matterFailed = /Failed to start Matter|Failed to prepare the Matter core|Failed to register the RGB light|Failed to init server/.test(input.monitorLog) || (matter === "failed" && !matterServer);
  const colourApplied = /Applied RGB:/.test(input.monitorLog) && !attributeMissing;
  return [
    {
      id: "usb",
      label: "USB installation",
      status: input.writeCompleted || statusOf("write") === "passed" ? "passed" : statusOf("write") === "failed" ? "failed" : "unverified",
      detail: input.writeCompleted ? "The USB write completed." : "The USB write is not recorded as complete.",
    },
    {
      id: "flash",
      label: "Flash integrity",
      status: input.writeCompleted || statusOf("write") === "passed" ? "passed" : "unverified",
      detail: "Hash verification is recorded with the USB write. A later boot does not repeat it.",
    },
    {
      id: "boot",
      label: "Application entry",
      status: boot === "passed" || /Calling app_main/.test(input.monitorLog) ? "passed" : boot === "failed" ? "failed" : "unverified",
      detail: boot === "passed" || /Calling app_main/.test(input.monitorLog) ? "app_main was reached." : "Application entry was not captured.",
    },
    {
      id: "rgb",
      label: "RGB LED initialisation",
      status: !rgbLog ? "not_applicable" : ledcFailed || (!ledReady && attributeMissing) ? "failed" : ledReady ? "passed" : "unverified",
      detail: !rgbLog ? "This log is not an RGB firmware boot." : ledReady ? "The LED driver logged initialisation. Physical light output has not been observed." : ledcFailed ? "An LEDC call logged a failure." : "The LED driver did not log initialisation.",
    },
    {
      id: "attributes",
      label: "Colour attribute setup",
      status: !rgbLog ? "not_applicable" : attributeMissing ? "failed" : colourApplied || matterServer ? "passed" : "not_reached",
      detail: attributeMissing ? "The host asked for a colour attribute that the endpoint had not created. Error 261 is ESP_ERR_NOT_FOUND." : "Colour attributes were not reported missing.",
    },
    {
      id: "matter",
      label: "Matter startup",
      status: matterServer ? "passed" : matterFailed ? "not_reached" : matterStack ? "unverified" : "unverified",
      detail: matterServer ? "The Matter server logged startup. This is not commissioning." : matterFailed ? "Matter startup was not reached." : matterStack ? "The Matter stack started. This capture ended before the server reported listening, a fabric, or an onboarding code." : "Matter startup was not observed.",
    },
    {
      id: "commissioning",
      label: "Commissioning",
      status: matterServer ? "unverified" : "not_reached",
      detail: matterServer ? "A Matter server log does not by itself open a commissioning window or prove a fabric." : "Commissioning is not available until the Matter server is observed.",
    },
  ];
}

export function startupCheckStatus(checks: Array<{ id: string; status: string }>, id: string): "passed" | "failed" | "unknown" {
  const status = checks.find((item) => item.id === id)?.status;
  return status === "passed" || status === "failed" ? status : "unknown";
}

export function commissioningChecksPassed(checks: Array<{ id: string; status: string }>): boolean {
  return STARTUP_CHECKS.every((id) => startupCheckStatus(checks, id) === "passed");
}

export function macFromDeviceLog(log: string): string | null {
  return identifyHardwareMac(log).mac;
}

const FACTORY_RESET_LOG = /Factory reset triggered|Starting factory reset|Performing factory reset|Factory reset requested/gi;

export function identifyHardwareMac(log: string): { mac: string | null; source: MacSource; conflict: boolean } {
  const entries: Array<{ mac: string; source: Exclude<MacSource, "unverified">; index: number }> = [];
  for (const match of log.matchAll(/BASE MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/gi)) {
    const mac = match[1]?.toLowerCase();
    if (mac) entries.push({ mac, source: "base_mac", index: match.index ?? 0 });
  }
  for (const match of log.matchAll(/Bluetooth MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/gi)) {
    const mac = match[1]?.toLowerCase();
    if (mac) entries.push({ mac, source: "bluetooth_mac", index: match.index ?? 0 });
  }
  if (!entries.length) return { mac: null, source: "unverified", conflict: false };
  const lastBoot = [...log.matchAll(/(?:^|\n)(?:rst:0x[0-9a-f]+|ESP-ROM:)/g)].at(-1)?.index ?? 0;
  const current = entries.filter((entry) => entry.index >= lastBoot);
  const relevant = current.length ? current : entries;
  const bases = [...new Set(relevant.filter((entry) => entry.source === "base_mac").map((entry) => entry.mac))];
  const radios = [...new Set(relevant.filter((entry) => entry.source === "bluetooth_mac").map((entry) => entry.mac))];
  const earlierRadios = [...new Set(entries.filter((entry) => entry.index < lastBoot && entry.source === "bluetooth_mac").map((entry) => entry.mac))];
  const radio = radios[0] ?? null;
  if (bases.length > 1 || radios.length > 1 || (radio != null && earlierRadios.some((mac) => mac !== radio))) {
    return { mac: null, source: "unverified", conflict: true };
  }
  const base = bases[0];
  if (base) return { mac: base, source: "base_mac", conflict: false };
  return { mac: radio, source: radio ? "bluetooth_mac" : "unverified", conflict: false };
}

export function installationIdentity(input: {
  log: string;
  storedMac: string | null;
  recordedAt: string | null;
}): { mac: string | null; source: MacSource; conflict: boolean; detail: string } {
  const logged = identifyHardwareMac(input.log);
  const chipMacs = [...input.log.matchAll(/(?:^|\n)\s*MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/gi)]
    .map((match) => match[1]?.toLowerCase())
    .filter((mac): mac is string => Boolean(mac));
  const chipMac = chipMacs.length === 1 ? chipMacs[0] : null;
  const chipConflict = chipMacs.length > 1 || Boolean(chipMac && logged.mac && chipMac !== logged.mac);
  if (logged.conflict || chipConflict) {
    return {
      mac: null,
      source: "unverified",
      conflict: true,
      detail: "The retained log names more than one MAC, so this session does not verify a device.",
    };
  }
  if (logged.mac && logged.source === "base_mac") {
    return { mac: logged.mac, source: "base_mac", conflict: false, detail: "BASE MAC is in the retained device log. This is not a new chip-id measurement." };
  }
  if (logged.mac && logged.source === "bluetooth_mac") {
    return { mac: logged.mac, source: "bluetooth_mac", conflict: false, detail: "Bluetooth MAC is in the retained UART log. This is not a chip-id measurement." };
  }
  if (chipMac && /Chip is ESP32-H2/i.test(input.log)) {
    return { mac: chipMac, source: "chip_id", conflict: false, detail: "esptool recorded this MAC in the retained installation log. This page has not run Identify Hardware again." };
  }
  const stored = input.storedMac?.toLowerCase() ?? null;
  if (stored && /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(stored)) {
    return {
      mac: stored,
      source: "stored_session",
      conflict: false,
      detail: `Previously recorded on this installation${input.recordedAt ? ` at ${input.recordedAt}` : ""}. The retained log no longer contains the MAC line, so this is not a new chip-id measurement.`,
    };
  }
  return { mac: null, source: "unverified", conflict: false, detail: "No chip-id or device-log MAC is recorded for this installation." };
}

export function currentCommissioningLog(log: string): { text: string; resetWithoutBoot: boolean; followedReset: boolean } {
  const reset = [...log.matchAll(FACTORY_RESET_LOG)].at(-1);
  const after = reset ? log.slice((reset.index ?? 0) + reset[0].length) : log;
  const boots = [...after.matchAll(/(?:^|\n)(?:rst:0x[0-9a-f]+|ESP-ROM:)/g)];
  const hasCommissioningText = /Server Listening|commissioning mode|Fabric already|was retrieved from storage|CHIPoBLE|Commissioning window/i.test(after);
  if (reset && boots.length === 0 && !hasCommissioningText) return { text: "", resetWithoutBoot: true, followedReset: true };
  const lastBoot = boots.at(-1);
  return { text: lastBoot ? after.slice(lastBoot.index ?? 0) : after, resetWithoutBoot: false, followedReset: Boolean(reset) };
}

export interface CommissioningObservation {
  state: CommissioningState;
  windowOpen: boolean | null;
  windowNow: WindowNow;
  lastWindowEvent: "ble_advertising_started" | "window_opened" | "window_closed" | "window_failed" | null;
  bleAdvertisingObserved: boolean;
  dnsSdWarning: string | null;
  appleHomeFabric: boolean;
  fabricVendors: string[];
  detail: string;
}

function dnsSdWarning(log: string): string | null {
  const match = log.match(/Failed to advertise commissionable node:\s*(\d+)/i);
  if (!match) return null;
  const code = match[1] ?? "";
  return `DNS-SD commissionable advertising failed with Matter error ${code}. BLE advertising is a separate channel. This does not by itself mean BLE commissioning failed, and it does not mean every discovery path is healthy. Error 3 is CHIP_ERROR_INCORRECT_STATE in this SDK. That often appears before the device has a network for mDNS.`;
}

export function commissioningFromLog(log: string): CommissioningObservation {
  const scoped = currentCommissioningLog(log);
  if (scoped.resetWithoutBoot) {
    return {
      state: "unknown",
      windowOpen: null,
      windowNow: "unknown",
      lastWindowEvent: null,
      bleAdvertisingObserved: false,
      dnsSdWarning: null,
      appleHomeFabric: false,
      fabricVendors: [],
      detail: "A factory reset was logged. No later boot was captured, so the current Matter fabric state is Unknown. Earlier fabric records are not current evidence.",
    };
  }
  const observation = interpretCommissioningLog(scoped.text);
  if (!scoped.followedReset || observation.state === "commissioned") return observation;
  return {
    ...observation,
    detail: `${observation.detail} A factory reset was logged before this evidence, so earlier fabric records are not current evidence.`,
  };
}

function interpretCommissioningLog(log: string): CommissioningObservation {
  const fabricVendors = [...new Set([...log.matchAll(/VendorId 0x([0-9A-Fa-f]+)/g)].flatMap((match) => match[1] ? [match[1].toUpperCase()] : []))];
  const appleHomeFabric = fabricVendors.includes("1349");
  const storedFabric = /Fabric already commissioned|was retrieved from storage|Existing Matter fabric count/i.test(log);
  const windowOpened = /Commissioning window opened|Basic commissioning window is now open/i.test(log);
  const windowFailed = /Failed to open commissioning window/i.test(log);
  const windowClosed = /commissioning window (?:is )?closed|commissioning window timeout|window timed out/i.test(log);
  const serverListening = /Server Listening/i.test(log);
  const bleStarted = /CHIPoBLE advertising started/i.test(log);
  const mode = [...log.matchAll(/commissioning mode (\d+)/gi)].at(-1);
  const modeOpen = mode ? Number(mode[1]) > 0 : null;
  const warning = dnsSdWarning(log);
  const base = { appleHomeFabric: false, fabricVendors, dnsSdWarning: warning, bleAdvertisingObserved: bleStarted };
  const conflicting = storedFabric && (bleStarted || modeOpen === true);
  if (conflicting) {
    return {
      ...base,
      state: "unknown",
      windowOpen: null,
      windowNow: "unknown",
      lastWindowEvent: bleStarted ? "ble_advertising_started" : null,
      detail: "The log contains both a stored fabric and first-time advertising. Those conflict, so commissioning state is Unknown.",
    };
  }
  if (storedFabric) {
    const vendors = fabricVendors.map((vendor) => `0x${vendor}`).join(", ");
    return {
      ...base,
      state: "commissioned",
      windowOpen: false,
      windowNow: modeOpen === true ? "unknown" : "closed",
      lastWindowEvent: null,
      appleHomeFabric,
      detail: appleHomeFabric
        ? "A stored fabric includes Apple Home vendor 0x1349. The first-time commissioning window is not open."
        : `A stored Matter fabric was retrieved${vendors ? ` (vendor ${vendors})` : ""}. The first-time commissioning window is not open.`,
    };
  }
  if (windowClosed) {
    return {
      ...base,
      state: serverListening && modeOpen === true ? "uncommissioned" : "unknown",
      windowOpen: false,
      windowNow: "closed",
      lastWindowEvent: "window_closed",
      detail: "A commissioning-window close or timeout was logged. This is not a claim that a window is open now.",
    };
  }
  if (windowFailed && !bleStarted) {
    return {
      ...base,
      state: "unknown",
      windowOpen: false,
      windowNow: "unknown",
      lastWindowEvent: "window_failed",
      detail: "The firmware failed to open a commissioning window. Fabric membership was not observed.",
    };
  }
  if (serverListening && modeOpen === true && bleStarted) {
    return {
      ...base,
      state: "uncommissioned",
      windowOpen: null,
      windowNow: "unknown",
      lastWindowEvent: "ble_advertising_started",
      detail: "Matter is listening and no stored fabric was retrieved. Commissioning mode was above 0 and CHIPoBLE advertising started. That shows first-time BLE advertising in this log. It does not show that the commissioning window is still open.",
    };
  }
  if (windowOpened && modeOpen !== false) {
    return {
      ...base,
      state: "uncommissioned",
      windowOpen: null,
      windowNow: "unknown",
      lastWindowEvent: "window_opened",
      detail: "The firmware logged an open commissioning window and no stored fabric was seen. The log time is the observation. It is not proof the window is still open.",
    };
  }
  const deviceCode = /SetupQRCode:/i.test(log);
  const noFabric = /Fabric count 0/i.test(log);
  if ((deviceCode || noFabric) && !storedFabric && (windowOpened || bleStarted || noFabric)) {
    return {
      ...base,
      state: "uncommissioned",
      windowOpen: windowOpened || bleStarted ? true : null,
      windowNow: windowOpened || bleStarted ? "open" : "unknown",
      lastWindowEvent: bleStarted ? "ble_advertising_started" : windowOpened ? "window_opened" : null,
      detail: deviceCode
        ? "The Matter server printed an onboarding code while the fabric count was zero. That is the provider's active code for this boot, including any preserved NVS value."
        : "The Matter server reported fabric count 0. No onboarding code was printed in this capture.",
    };
  }
  if (serverListening) {
    return {
      ...base,
      state: "unknown",
      windowOpen: null,
      windowNow: "unknown",
      lastWindowEvent: null,
      detail: "Matter is listening. The log does not contain enough commissioning-window evidence, so the window is Unknown rather than closed.",
    };
  }
  return {
    ...base,
    state: "unknown",
    windowOpen: null,
    windowNow: "unknown",
    lastWindowEvent: null,
    detail: "Commissioning state was not observed.",
  };
}

export function smartHomeCommissioningCopy(input: Pick<CommissioningObservation, "state" | "windowNow" | "detail" | "fabricVendors">): { headline: string; guidance: string } {
  if (/boot after factory reset retrieved a stored fabric/i.test(input.detail)) {
    return {
      headline: "Commissioned again after reset",
      guidance: "The boot after the factory-reset event loaded a stored fabric. The first-time QR stays hidden. This is not a successful return to factory-new.",
    };
  }
  if (/release that starts the factory reset was not observed/i.test(input.detail)) {
    return {
      headline: "Reset requested but not observed",
      guidance: "The long-press was recognised, but the console did not show the release that starts the Matter factory reset. Hold BOOT until the log says to release it, then release it while the watch is still running.",
    };
  }
  if (/restarted the board/i.test(input.detail) && /following boot was not captured/i.test(input.detail)) {
    return {
      headline: "Reboot pending",
      guidance: "The reset log includes the restart line, but the first boot after it was not captured. Run Prepare Matter Factory Reset again and leave the same console connected until that boot appears.",
    };
  }
  if (/Factory-reset event observed/i.test(input.detail)) {
    return {
      headline: "Factory-reset event observed",
      guidance: "The console showed the reset starting. That is not a completed reset until the following boot is captured and shows no stored fabric.",
    };
  }
  if (/boot after factory reset is incomplete|retrieved no stored fabric/i.test(input.detail) && input.state !== "uncommissioned") {
    return {
      headline: "Post-reset boot being verified",
      guidance: "A boot after the reset was captured. It is not yet enough to show the first-time QR. The window is not inferred from Matter startup. If the discriminator is missing, capture the UART advertisement again. Do not reflash.",
    };
  }
  if (input.state === "unknown" && /factory reset was logged/i.test(input.detail)) {
    return {
      headline: "Factory reset completed but current state not yet verified",
      guidance: "Capture the next boot before first-time commissioning. Earlier fabric records stay in history and are not current evidence. The first-time QR stays hidden until that boot shows no stored fabric and the onboarding checks pass.",
    };
  }
  if (input.state === "commissioned") {
    return {
      headline: input.fabricVendors.length ? "Existing fabric detected" : "Previously commissioned",
      guidance: "The latest boot loaded a stored Matter fabric and the first-time window is closed. Use the controller that already owns the fabric, or factory-reset the board and capture the following boot before using the first-time QR.",
    };
  }
  if (input.windowNow === "closed") {
    return {
      headline: "Commissioning window expired",
      guidance: "The latest log recorded a closed or timed-out window. Power-cycle the board and capture that boot before scanning the QR. A power cycle is not a Matter factory reset.",
    };
  }
  if (input.state === "uncommissioned") {
    if (/factory reset/i.test(input.detail)) {
      return {
        headline: "Factory-new and ready for commissioning",
        guidance: "The latest evidence shows no stored fabric. Use the first-time QR when this page shows it for the selected hardware. A missing discriminator line does not by itself make the payload invalid. The commissioning window is not inferred from Matter startup. Do not reuse an Apple Home multi-admin code.",
      };
    }
    if (input.windowNow === "open") {
      return {
        headline: "No stored fabric. The commissioning window was open in this capture.",
        guidance: "Use the first-time QR when this page shows it. The window was open when the log was captured. This page does not keep it open, and BLE advertising is not a permanent window.",
      };
    }
    return {
      headline: "No stored fabric in this boot",
      guidance: "The Matter server reported no stored fabric. The commissioning window is not verified as still open. BLE advertising in this capture is not a permanent window. Use the first-time QR only when this page shows it.",
    };
  }
  return {
    headline: "Current state unknown",
    guidance: "The latest evidence does not establish a fabric or a factory-new boot. IoT.Edu will not treat an older fabric record as current commissioning. Capture a fresh boot log before first-time commissioning.",
  };
}

const BASE38 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

function verhoeffValid(code: string): boolean {
  let checksum = 0;
  const digits = [...code].reverse().map((digit) => Number(digit));
  if (digits.some((digit) => !Number.isInteger(digit))) return false;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits[index] ?? 0;
    const row = VERHOEFF_P[index % 8]?.[digit];
    if (row == null) return false;
    checksum = VERHOEFF_D[checksum]?.[row] ?? 0;
  }
  return checksum === 0;
}

function readBits(bytes: number[], offset: number, count: number): number {
  let result = 0;
  for (let index = 0; index < count; index += 1) {
    const position = offset + index;
    const byte = bytes[position >> 3] ?? 0;
    if ((byte & (1 << (position & 7))) !== 0) result |= 1 << index;
  }
  return result;
}

export interface DecodedMatterPayload {
  version: number;
  vendorId: number;
  productId: number;
  discriminator: number;
  passcode: number;
  manualCodeMatches: boolean;
}

export function decodeMatterPayload(qrPayload: string, manualCode: string): DecodedMatterPayload | null {
  const body = qrPayload.replace(/^MT:/i, "");
  const bytes: number[] = [];
  for (let index = 0; index < body.length;) {
    const remaining = body.length - index;
    const chars = remaining >= 5 ? 5 : remaining === 4 ? 4 : remaining === 2 ? 2 : 0;
    const width = chars === 5 ? 3 : chars === 4 ? 2 : chars === 2 ? 1 : 0;
    if (!chars || !width) return null;
    let value = 0;
    let factor = 1;
    for (let cursor = 0; cursor < chars; cursor += 1) {
      const digit = BASE38.indexOf(body[index + cursor] ?? "");
      if (digit < 0) return null;
      value += digit * factor;
      factor *= 38;
    }
    for (let cursor = 0; cursor < width; cursor += 1) {
      bytes.push(value & 0xff);
      value >>= 8;
    }
    index += chars;
  }
  if (bytes.length < 11) return null;
  let offset = 0;
  const take = (count: number) => {
    const value = readBits(bytes, offset, count);
    offset += count;
    return value;
  };
  const version = take(3);
  const vendorId = take(16);
  const productId = take(16);
  take(2);
  take(8);
  const discriminator = take(12);
  const passcode = take(27);
  const digits = manualCode.replace(/-/g, "");
  if (!verhoeffValid(digits) || digits.length < 11) return { version, vendorId, productId, discriminator, passcode, manualCodeMatches: false };
  const chunk1 = Number(digits.slice(0, 1));
  const chunk2 = Number(digits.slice(1, 6));
  const chunk3 = Number(digits.slice(6, 10));
  const shortDiscriminator = ((chunk1 & 0x3) << 2) | ((chunk2 >> 14) & 0x3);
  const manualPasscode = (chunk2 & 0x3fff) | ((chunk3 & 0x1fff) << 14);
  const manualCodeMatches = manualPasscode === passcode && shortDiscriminator === (discriminator >> 8);
  return { version, vendorId, productId, discriminator, passcode, manualCodeMatches };
}

function payloadFromPrintedText(value: string): string | null {
  let text = value.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // A partly escaped log line is ignored rather than decoded into a different payload.
  }
  return text.match(/MT:[A-Z0-9.-]+/i)?.[0] ?? null;
}

export function readDeviceOnboarding(log: string): { qrPayload: string | null; manualCode: string | null } {
  const direct = [...log.matchAll(/SetupQRCode:\s*\[(MT:[A-Z0-9.-]+)\]/gi)].at(-1)?.[1] ?? null;
  const encoded = [...log.matchAll(/[?&]data=(MT(?:%3A|:)[A-Z0-9.%_-]+)/gi)].at(-1)?.[1] ?? null;
  const qrPayload = direct ?? (encoded ? payloadFromPrintedText(encoded) : null);
  const manual = [...log.matchAll(/Manual pairing code:\s*\[([0-9-]+)\]/gi)].at(-1)?.[1] ?? null;
  let manualCode = manual ? manual.replace(/-/g, "") : null;
  if (qrPayload && !manualCode) {
    const decoded = decodeMatterPayload(qrPayload, "");
    if (decoded) {
      const generated = manualPairingCode(decoded.passcode, decoded.discriminator);
      if (decodeMatterPayload(qrPayload, generated)?.manualCodeMatches) manualCode = generated;
    }
  }
  return { qrPayload, manualCode };
}

export function readAdvertisedOnboarding(log: string): {
  discriminator: number | null;
  vendorId: number | null;
  productId: number | null;
  redacted: boolean;
} {
  const redacted = /discriminator\s*[:=]\s*\[redacted\]/i.test(log);
  const field = redacted ? null : log.match(/discriminator\s*[:=]\s*(0x[0-9a-f]+|\d+)(?:\/\d+)?/i);
  const raw = field?.[1] ?? "";
  const discriminator = raw ? (/^0x/i.test(raw) ? Number.parseInt(raw, 16) : Number(raw)) : null;
  const vendor = log.match(/vendorID=(\d+)/i);
  const product = log.match(/productID=(\d+)/i);
  return {
    discriminator: Number.isInteger(discriminator) ? discriminator : null,
    vendorId: vendor?.[1] ? Number(vendor[1]) : null,
    productId: product?.[1] ? Number(product[1]) : null,
    redacted,
  };
}

export function missingFlashOffsets(images: Array<{ offset: number; hashVerified: boolean }>): number[] {
  return EXPECTED_FLASH_OFFSETS.filter((offset) => !images.some((image) => image.offset === offset && image.hashVerified));
}

export type OnboardingPayloadState = "consistent" | "invalid" | "unknown";
export type FirmwareImageIdentity = "verified" | "mismatch" | "unknown";
export type DiscriminatorEvidence = "live_match" | "live_mismatch" | "redacted" | "absent";

export function readElfSha256Prefix(log: string): string | null {
  const prefix = [...log.matchAll(/ELF file SHA256:\s*([0-9a-f]{8,64})/gi)].at(-1)?.[1]?.toLowerCase() ?? null;
  return prefix && /^[0-9a-f]{8,64}$/.test(prefix) ? prefix : null;
}

export function elfSha256Matches(prefix: string | null, full: string | null): FirmwareImageIdentity {
  if (!prefix || !full) return "unknown";
  const head = prefix.toLowerCase();
  const digest = full.toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(head) || !/^[0-9a-f]{64}$/.test(digest)) return "unknown";
  return digest.startsWith(head) ? "verified" : "mismatch";
}

/** True only when this sdkconfig selects the compiled CHIP development discriminator and no factory-data provider. */
export function usesCompiledTestDiscriminator(sdkconfig: string): boolean {
  const enabled = (key: string) => new RegExp(`^${key}=y$`, "m").test(sdkconfig);
  const disabled = (key: string) => new RegExp(`^# ${key} is not set$`, "m").test(sdkconfig);
  return enabled("CONFIG_ENABLE_TEST_SETUP_PARAMS")
    && enabled("CONFIG_EXAMPLE_COMMISSIONABLE_DATA_PROVIDER")
    && disabled("CONFIG_ENABLE_ESP32_FACTORY_DATA_PROVIDER")
    && disabled("CONFIG_SEC_CERT_COMMISSIONABLE_DATA_PROVIDER")
    && disabled("CONFIG_CUSTOM_COMMISSIONABLE_DATA_PROVIDER")
    && !enabled("CONFIG_FACTORY_COMMISSIONABLE_DATA_PROVIDER");
}

export interface OnboardingVerification {
  status: "verified" | "image_verified" | "not_verified" | "invalid";
  reason: string;
  discriminatorMatched: boolean | null;
  vendorMatched: boolean | null;
  productMatched: boolean | null;
  payloadConsistent: boolean | null;
  payload: OnboardingPayloadState;
  imageIdentity: FirmwareImageIdentity;
  discriminatorEvidence: DiscriminatorEvidence;
}

const IMAGE_VERIFIED_LABEL = "Verified from installed firmware — live BLE advertisement not confirmed.";

export function verifyOnboarding(input: {
  softwareVersion: number | null;
  softwareVersionString: string | null;
  vendorId: number | null;
  productId: number | null;
  advertisedDiscriminator: number | null;
  discriminatorRedacted: boolean;
  advertisedVendorId: number | null;
  advertisedProductId: number | null;
  imageSha256Prefix?: string | null;
  packageElfSha256?: string | null;
  usesCompiledTestDiscriminator?: boolean;
  qrPayload?: string;
  manualCode?: string;
}): OnboardingVerification {
  const imageIdentity = elfSha256Matches(input.imageSha256Prefix ?? null, input.packageElfSha256 ?? null);
  const vendorMatched = input.advertisedVendorId == null ? null : input.advertisedVendorId === DEVELOPMENT_ONBOARDING.vendorId;
  const productMatched = input.advertisedProductId == null ? null : input.advertisedProductId === DEVELOPMENT_ONBOARDING.productId;
  const packageMatches = input.softwareVersion === DEVELOPMENT_ONBOARDING.softwareVersion
    && input.softwareVersionString === DEVELOPMENT_ONBOARDING.softwareVersionString
    && input.vendorId === DEVELOPMENT_ONBOARDING.vendorId
    && input.productId === DEVELOPMENT_ONBOARDING.productId;
  const decoded = decodeMatterPayload(input.qrPayload ?? DEVELOPMENT_ONBOARDING.qrPayload, input.manualCode ?? DEVELOPMENT_ONBOARDING.manualCode);
  const payloadConsistent = Boolean(decoded
    && decoded.passcode === DEVELOPMENT_ONBOARDING.passcode
    && decoded.discriminator === DEVELOPMENT_ONBOARDING.discriminator
    && decoded.vendorId === DEVELOPMENT_ONBOARDING.vendorId
    && decoded.productId === DEVELOPMENT_ONBOARDING.productId
    && decoded.manualCodeMatches);
  const base = { vendorMatched, productMatched, imageIdentity };
  if (!decoded || !payloadConsistent) {
    return {
      ...base,
      status: "invalid",
      reason: "Onboarding Payload — Invalid. The QR and manual code do not decode to the development vendor, product, discriminator, and passcode.",
      discriminatorMatched: null,
      payloadConsistent: false,
      payload: "invalid",
      discriminatorEvidence: input.discriminatorRedacted ? "redacted" : input.advertisedDiscriminator == null ? "absent" : "live_mismatch",
    };
  }
  if (input.usesCompiledTestDiscriminator && input.vendorId === 0xfff1 && input.productId != null) {
    return verifyCompiledTestPackage(input, imageIdentity);
  }
  if (!packageMatches) {
    const compiled = compiledTestOnboarding(input.vendorId, input.productId);
    const advertisedMatch = compiled != null
      && input.advertisedDiscriminator === compiled.discriminator
      && (input.advertisedVendorId == null || input.advertisedVendorId === compiled.vendorId)
      && (input.advertisedProductId == null || input.advertisedProductId === compiled.productId);
    return {
      ...base,
      status: "not_verified",
      reason: advertisedMatch
        ? "The device advertised the development discriminator for this vendor and product, but the firmware did not print a setup passcode and the package configuration did not confirm the shared development provider. No QR is displayed."
        : "Onboarding Payload — Not Verified. This firmware package does not match the 1.3.0 / SoftwareVersion 4 metadata for vendor 0xFFF1 and product 0x8000, so its onboarding payload is not assumed.",
      discriminatorMatched: advertisedMatch ? true : null,
      payloadConsistent: null,
      payload: "unknown",
      discriminatorEvidence: input.discriminatorRedacted ? "redacted" : input.advertisedDiscriminator == null ? "absent" : advertisedMatch ? "live_match" : "absent",
    };
  }
  if (vendorMatched === false || productMatched === false) {
    return {
      ...base,
      status: "invalid",
      reason: "Onboarding Payload — Invalid. The device log's vendor or product does not match the package.",
      discriminatorMatched: null,
      payloadConsistent: true,
      payload: "consistent",
      discriminatorEvidence: input.advertisedDiscriminator == null ? (input.discriminatorRedacted ? "redacted" : "absent") : "live_mismatch",
    };
  }
  if (imageIdentity === "mismatch") {
    return {
      ...base,
      status: "invalid",
      reason: "Onboarding Payload — Invalid. The UART image hash does not match the selected firmware package, so that package's discriminator is not used.",
      discriminatorMatched: input.advertisedDiscriminator == null ? null : input.advertisedDiscriminator === DEVELOPMENT_ONBOARDING.discriminator,
      payloadConsistent: true,
      payload: "consistent",
      discriminatorEvidence: input.discriminatorRedacted ? "redacted" : input.advertisedDiscriminator == null ? "absent" : input.advertisedDiscriminator === DEVELOPMENT_ONBOARDING.discriminator ? "live_match" : "live_mismatch",
    };
  }
  if (input.advertisedDiscriminator != null) {
    const discriminatorMatched = input.advertisedDiscriminator === DEVELOPMENT_ONBOARDING.discriminator;
    if (!discriminatorMatched) {
      return {
        ...base,
        status: "invalid",
        reason: "Onboarding Payload — Invalid. The device log's discriminator does not match the package payload.",
        discriminatorMatched: false,
        payloadConsistent: true,
        payload: "consistent",
        discriminatorEvidence: "live_mismatch",
      };
    }
    return {
      ...base,
      status: "verified",
      reason: "The package payload matches the advertised discriminator, vendor, and product.",
      discriminatorMatched: true,
      payloadConsistent: true,
      payload: "consistent",
      discriminatorEvidence: "live_match",
    };
  }
  const discriminatorEvidence: DiscriminatorEvidence = input.discriminatorRedacted ? "redacted" : "absent";
  if (imageIdentity === "verified" && input.usesCompiledTestDiscriminator) {
    const removed = input.discriminatorRedacted
      ? " The device printed a discriminator and the saved log removed the number."
      : " This boot log has no discriminator line.";
    return {
      ...base,
      status: "image_verified",
      reason: `${IMAGE_VERIFIED_LABEL}${removed} The installed image matches the package that compiles the development discriminator 0xF00. This is not a live BLE advertisement observation.`,
      discriminatorMatched: null,
      payloadConsistent: true,
      payload: "consistent",
      discriminatorEvidence,
    };
  }
  const missingNumber = input.discriminatorRedacted
    ? "The device printed a discriminator and the saved log removed the number."
    : "The device log does not contain an advertised discriminator.";
  const next = imageIdentity === "unknown"
    ? " The running image has not been matched to a package binary. Capture the UART boot again. New logs keep the discriminator number. Do not reflash."
    : " The image was identified, but its build configuration does not select the compiled development discriminator. A numeric discriminator from the device is required. Do not reflash.";
  return {
    ...base,
    status: "not_verified",
    reason: `Onboarding Payload — Not Verified. ${missingNumber}${next}`,
    discriminatorMatched: null,
    payloadConsistent: true,
    payload: "consistent",
    discriminatorEvidence,
  };
}

export interface OnboardingDecision {
  show: boolean;
  payload: string | null;
  manualCode: string | null;
  reason: string;
  windowWarning: string | null;
}

function hidden(reason: string): OnboardingDecision {
  return { show: false, payload: null, manualCode: null, reason, windowWarning: null };
}

function verifyCompiledTestPackage(input: {
  vendorId: number | null;
  productId: number | null;
  advertisedDiscriminator: number | null;
  discriminatorRedacted: boolean;
  advertisedVendorId: number | null;
  advertisedProductId: number | null;
}, imageIdentity: FirmwareImageIdentity): OnboardingVerification {
  const compiled = compiledTestOnboarding(input.vendorId, input.productId);
  const vendorMatched = input.advertisedVendorId == null ? null : input.advertisedVendorId === input.vendorId;
  const productMatched = input.advertisedProductId == null ? null : input.advertisedProductId === input.productId;
  const base = { vendorMatched, productMatched, imageIdentity };
  if (!compiled) {
    return {
      ...base,
      status: "not_verified",
      reason: "Onboarding Payload — Not Verified. This package does not have a verified static onboarding payload.",
      discriminatorMatched: null,
      payloadConsistent: null,
      payload: "unknown",
      discriminatorEvidence: input.discriminatorRedacted ? "redacted" : "absent",
    };
  }
  if (vendorMatched === false || productMatched === false || imageIdentity === "mismatch") {
    return {
      ...base,
      status: "invalid",
      reason: "Onboarding Payload — Invalid. The device log does not match this package's vendor, product, or image.",
      discriminatorMatched: null,
      payloadConsistent: false,
      payload: "invalid",
      discriminatorEvidence: "live_mismatch",
    };
  }
  if (input.advertisedDiscriminator != null && input.advertisedDiscriminator !== compiled.discriminator) {
    return {
      ...base,
      status: "invalid",
      reason: "Onboarding Payload — Invalid. The device log's discriminator does not match the compiled test discriminator.",
      discriminatorMatched: false,
      payloadConsistent: false,
      payload: "invalid",
      discriminatorEvidence: "live_mismatch",
    };
  }
  if (input.advertisedDiscriminator === compiled.discriminator) {
    return {
      ...base,
      status: "verified",
      reason: "The advertised discriminator matches the compiled test discriminator for this package. This is not a factory-data or dynamic passcode.",
      discriminatorMatched: true,
      payloadConsistent: true,
      payload: "consistent",
      discriminatorEvidence: "live_match",
    };
  }
  if (imageIdentity === "verified") {
    return {
      ...base,
      status: "image_verified",
      reason: "Verified from installed firmware — live BLE advertisement not confirmed. The image matches a package that compiles the test discriminator. A preserved NVS passcode overrides that fallback.",
      discriminatorMatched: null,
      payloadConsistent: true,
      payload: "consistent",
      discriminatorEvidence: input.discriminatorRedacted ? "redacted" : "absent",
    };
  }
  return {
    ...base,
    status: "not_verified",
    reason: "Onboarding Payload — Not Verified. The package compiles the example provider, but this boot did not advertise a discriminator and the image hash was not matched. No pairing code is assumed.",
    discriminatorMatched: null,
    payloadConsistent: null,
    payload: "unknown",
    discriminatorEvidence: input.discriminatorRedacted ? "redacted" : "absent",
  };
}

const NO_STORED_ONBOARDING = "No stored Matter onboarding payload is available for this device. IoT.Edu does not invent a pairing code.";
export const COMMISSIONED_WITHOUT_ONBOARDING = "This device already has a Matter fabric, and no stored onboarding payload is available. Add IoT.Edu from Pair New Node with a new code from the existing administrator.";

export function onboardingDecision(input: {
  writeCompleted: boolean;
  bootVerified: boolean;
  matterReady: boolean;
  matterStartup?: "started" | "failed" | "unknown";
  nvsPreserved?: boolean;
  threadReady: boolean;
  versionVerified: boolean;
  softwareVersion: number | null;
  softwareVersionString: string | null;
  vendorId: number | null;
  productId: number | null;
  commissioningState: CommissioningState;
  commissioningWindowOpen: boolean | null;
  onboardingStatus?: "verified" | "image_verified" | "not_verified" | "invalid";
  onboardingReason?: string;
  windowNow?: WindowNow;
  deviceOnboarding?: { qrPayload: string; manualCode: string } | null;
}): OnboardingDecision {
  const reported = input.deviceOnboarding?.qrPayload && input.deviceOnboarding.manualCode
    ? decodeMatterPayload(input.deviceOnboarding.qrPayload, input.deviceOnboarding.manualCode)
    : null;
  if (input.deviceOnboarding?.qrPayload && !reported) {
    return hidden("The stored onboarding code did not decode. It is not displayed.");
  }
  if (reported && (
    (input.vendorId != null && reported.vendorId !== input.vendorId)
    || (input.productId != null && reported.productId !== input.productId)
    || !reported.manualCodeMatches
  )) {
    return hidden("The device onboarding code does not match this firmware's vendor and product. It is not displayed.");
  }
  if (reported && input.deviceOnboarding) {
    const windowNow = input.windowNow ?? (input.commissioningWindowOpen === true ? "open" : input.commissioningWindowOpen === false ? "closed" : "unknown");
    const windowWarning = input.commissioningState === "commissioned"
      ? "Original setup code. This device already has a Matter fabric. Additional pairing may require a new commissioning window from an existing administrator. Showing the stored code does not open a commissioning window."
      : windowNow === "closed"
        ? "The commissioning window is closed. Showing the stored code does not open a window."
        : windowNow === "open"
          ? null
          : "The commissioning window is not verified as open. Showing the stored code does not open a window.";
    const firmwareVerified = input.writeCompleted && input.bootVerified && input.versionVerified;
    const compiled = compiledTestOnboarding(input.vendorId, input.productId);
    const matchesCompiled = compiled != null && compiled.qrPayload === input.deviceOnboarding.qrPayload;
    return {
      show: true,
      payload: input.deviceOnboarding.qrPayload,
      manualCode: input.deviceOnboarding.manualCode,
      reason: firmwareVerified && matchesCompiled
        ? "This code matches the compiled development payload for this product. It is the shared development setup code, not a passcode unique to this physical device."
        : firmwareVerified
          ? "The Matter server printed this code from the active commissionable-data provider. Preserved NVS is included. This is not the compiled development fallback."
          : input.commissioningState === "commissioned"
            ? "Original setup code for the selected device. It does not depend on a firmware build record."
            : matchesCompiled
              ? "This is the shared development setup code compiled into this firmware. It is not unique to this physical device. It does not depend on a firmware build record."
              : "This is the stored Matter onboarding payload for the selected device. It does not depend on a firmware build record.",
      windowWarning,
    };
  }
  if (input.commissioningState === "commissioned") {
    return hidden(COMMISSIONED_WITHOUT_ONBOARDING);
  }
  if (!input.writeCompleted || !input.bootVerified || !input.versionVerified) {
    return hidden(NO_STORED_ONBOARDING);
  }
  const matterStartup = input.matterStartup ?? (input.matterReady ? "started" : "unknown");
  if (matterStartup === "failed") {
    return hidden("The onboarding QR is hidden because the application stopped before Matter started. The device is not ready to pair.");
  }
  if (!input.matterReady && matterStartup !== "started") {
    return hidden("Application boot is verified. The Matter server had not reported listening, a fabric, or an onboarding code when this capture ended. OpenThread or an earlier chip log is not that result. No QR is displayed. The compiled development code is not used while NVS may override it.");
  }
  if (input.nvsPreserved && !reported && input.onboardingStatus !== "verified") {
    const version = input.softwareVersionString ?? "This firmware";
    return hidden(input.onboardingReason || `${version} did not print the active setup code. Preserved NVS is read before the compiled development values, so those values are not displayed. The USB port on this image is a log console rather than a Matter command console.`);
  }
  const compiled = compiledTestOnboarding(input.vendorId, input.productId);
  const identityMatches = compiled != null && input.vendorId === compiled.vendorId;
  if (!identityMatches || !compiled) {
    return hidden("The onboarding QR is hidden because this verified firmware has no compiled test payload for its vendor and product.");
  }
  if (input.commissioningState !== "uncommissioned") {
    return hidden("The first-time QR is hidden because the current commissioning state is Unknown. An older fabric record is not current evidence, and the QR stays hidden until a boot confirms there is no stored fabric.");
  }
  if (input.onboardingStatus !== "verified" && input.onboardingStatus !== "image_verified") {
    return hidden(input.onboardingReason || "Onboarding Payload — Not Verified. The device advertisement has not been compared with the package payload.");
  }
  if (input.nvsPreserved && input.onboardingStatus !== "verified") {
    return hidden("The image compiles the example commissionable-data provider. NVS was preserved and is read before the compiled fallback, and this boot did not advertise the live discriminator. No QR is displayed.");
  }
  const windowNow = input.windowNow ?? (input.commissioningWindowOpen === true ? "open" : "unknown");
  const windowWarning = windowNow === "closed"
    ? "The commissioning window was closed in the captured log. Power-cycle the board and capture that boot before Apple Home can join. This page does not reset the board."
    : windowNow === "open"
      ? null
      : "The commissioning window is not verified as open now. It may need a power cycle before Apple Home can join. This page does not reset the board or open the window.";
  return {
    show: true,
    payload: compiled.qrPayload,
    manualCode: compiled.manualCode,
    reason: input.onboardingStatus === "image_verified"
      ? IMAGE_VERIFIED_LABEL
      : "The firmware package uses the shared development setup code, and the device advertised its discriminator. This passcode is not unique to the physical device.",
    windowWarning,
  };
}
