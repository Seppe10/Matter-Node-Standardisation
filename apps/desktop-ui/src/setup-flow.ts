import type { SetupRecord } from "./setup";

export const SETUP_STEP_LABELS = [
  "Step 1 — Identify Hardware",
  "Step 2 — Configure & Install Firmware",
  "Step 3 — Connect to Smart Home",
] as const;

export const INSTALL_STAGES = ["Validating", "Preparing", "Flashing", "Verifying", "Complete"] as const;

export type InstallStage = (typeof INSTALL_STAGES)[number];

export interface PackageChoice {
  id: string;
  softwareVersion: number;
  createdAt: string;
  compatible: boolean;
}

export function currentSetupStep(input: { identified: boolean; bootVerified: boolean }): 1 | 2 | 3 {
  if (!input.identified) return 1;
  if (!input.bootVerified) return 2;
  return 3;
}

export function chooseFirmwarePackage(packages: PackageChoice[], selectedId: string | null): string | null {
  const compatible = packages.filter((item) => item.compatible);
  if (selectedId && compatible.some((item) => item.id === selectedId)) return selectedId;
  return [...compatible].sort((left, right) => right.softwareVersion - left.softwareVersion || right.createdAt.localeCompare(left.createdAt))[0]?.id ?? null;
}

export function activeInstallStage(input: {
  validating: boolean;
  confirming: boolean;
  sessionStatus: "running" | "succeeded" | "failed" | null;
  sessionStage: "writing" | "monitoring" | "idle" | null;
  boot: "passed" | "failed" | "unknown" | null;
  verified?: boolean;
}): InstallStage | null {
  if (input.verified && input.sessionStatus === "succeeded") return "Complete";
  if (input.sessionStage === "monitoring") return "Verifying";
  if (input.sessionStage === "writing" || input.sessionStatus === "running") return "Flashing";
  if (input.confirming) return "Preparing";
  if (input.validating) return "Validating";
  return null;
}

export function firmwareReady(checks: Array<{ id: string; status: string }>): boolean {
  return ["boot", "matter", "openthread", "version"].every((id) => checks.find((item) => item.id === id)?.status === "passed");
}

/** Reflect a Matter failure that is in the saved log when the stored check is still unknown. */
export function displayedStartupChecks<T extends { id: string; status: string; detail: string }>(checks: T[], monitorLog: string): T[] {
  const failure = Math.max(
    monitorLog.lastIndexOf("Failed to register the RGB light"),
    monitorLog.lastIndexOf("Failed to start Matter"),
    monitorLog.lastIndexOf("Failed to create Matter node"),
    monitorLog.lastIndexOf("Failed to prepare the Matter core"),
  );
  const server = Math.max(
    monitorLog.lastIndexOf("Server Listening"),
    monitorLog.lastIndexOf("Fabric already commissioned"),
    monitorLog.lastIndexOf("Existing Matter fabric count"),
    monitorLog.lastIndexOf("SetupQRCode:"),
    monitorLog.lastIndexOf("CHIPoBLE advertising started"),
    monitorLog.lastIndexOf("Commissioning window opened"),
  );
  if (failure >= 0 && failure > server) {
    const detail = monitorLog.includes("Failed to register the RGB light")
      ? "The application stopped while registering the RGB light, before Matter started. This is not a BLE or fabric result."
      : "The firmware logged a Matter startup failure.";
    return checks.map((item) => item.id === "matter" ? { ...item, status: "failed", detail } : item);
  }
  if (server < 0 && monitorLog.trim()) {
    return checks.map((item) => item.id === "matter" && item.status === "passed"
      ? { ...item, status: "unknown", detail: "The Matter stack started. This capture ended before the server reported listening, a fabric, or an onboarding code." }
      : item);
  }
  return checks;
}

/** Application boot and version match. Matter, Thread, and commissioning stay separate. */
export function applicationInstallReady(checks: Array<{ id: string; status: string }>): boolean {
  return checks.find((item) => item.id === "boot")?.status === "passed"
    && checks.find((item) => item.id === "version")?.status === "passed";
}

export function installationHeadline(checks: Array<{ id: string; status: string }>, writeStatus: "running" | "succeeded" | "failed" | "interrupted" | null, message: string | null = null): string | null {
  if (message?.startsWith("Flash verification timed out")) return "Flash verification timed out. The result is unknown. Review the diagnostic log before retrying.";
  if (message?.startsWith("The console shows ROM download mode")) return message;
  if (message?.startsWith("No application output was captured")) return message;
  if (message?.startsWith("Firmware boot failed.")) return message;
  if (message?.startsWith("The USB port did not reappear")) return message;
  if (message?.startsWith("The bootloader started from SPI flash")) return message;
  if (message?.startsWith("The USB console did not open")) return message;
  if (writeStatus === "failed" || writeStatus === "interrupted") return "Firmware Installation Failed.";
  if (writeStatus !== "succeeded") return null;
  const required = ["boot", "matter", "openthread", "version"].map((id) => checks.find((item) => item.id === id)?.status);
  const boot = checks.find((item) => item.id === "boot")?.status;
  if (required.every((item) => item === "passed")) return "Firmware Installed and Verified.";
  if (boot === "passed" && checks.find((item) => item.id === "version")?.status === "passed" && checks.find((item) => item.id === "matter")?.status === "failed") {
    return "Application boot verified. Matter startup was not reached.";
  }
  if (required.some((item) => item === "failed")) return "Firmware Installed — Verification Failed.";
  if (boot === "passed") return "Firmware installation succeeded. Matter commissioning has not yet been performed.";
  if (message?.startsWith("Unable to verify firmware boot")) return message;
  return "Flash contents were verified. Application startup has not been captured yet.";
}

export function bootCaptureReport(monitorLog: string, port: string | null): Array<{ label: string; value: string }> {
  const lines = monitorLog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const notes = lines.filter((line) => line.startsWith("note:"));
  const device = lines.filter((line) => !line.startsWith("note:"));
  const bytes = notes.find((line) => line.startsWith("note: bytes received "));
  const received = bytes ? bytes.slice("note: bytes received ".length) : String(device.join("\n").length);
  const timeout = notes.find((line) => line.includes("capture ended before"))
    ? "The listen ended before application startup was settled"
    : notes.some((line) => line.includes("capture ended"))
      ? "The listen settled"
      : monitorLog.trim() ? "Not recorded" : "No capture yet";
  return [
    { label: "Serial port", value: port ?? "Not selected" },
    { label: "Port opened", value: notes.some((line) => line.includes("console opened")) || /uart console open/i.test(monitorLog) ? "Yes" : /could not open port/i.test(monitorLog) ? "No" : "Not observed" },
    { label: "Reset requested", value: notes.some((line) => line.includes("reset requested")) ? "Yes" : "Not observed" },
    { label: "USB disconnected", value: notes.some((line) => line.includes("usb interface disconnected")) ? "Yes" : notes.some((line) => line.includes("usb interface remained present")) ? "No" : "Not observed" },
    { label: "USB reappeared", value: notes.some((line) => line.includes("usb interface reappeared")) ? "Yes" : "Not observed" },
    { label: "Characters received", value: received },
    { label: "ROM boot", value: /ESP-ROM:esp32h2/i.test(monitorLog) ? "Captured" : "Not captured" },
    { label: "ESP-IDF startup", value: /2nd stage bootloader|cpu_start:/i.test(monitorLog) ? "Captured" : "Not captured" },
    { label: "Application startup", value: /cpu_start:|app_init:|Calling app_main|App version:|App "sensors"|Extended colour light endpoint/i.test(monitorLog) ? "Captured" : "Not captured" },
    { label: "Panic or crash", value: /Guru Meditation|panic'ed|abort\(\)/i.test(monitorLog) ? "Captured" : "Not captured" },
    { label: "Timeout", value: timeout },
  ];
}

export function preferredProgramSession<T extends {
  id: string;
  mac: string | null;
  status: string;
  updatedAt: string;
  checks: Array<{ id: string; status: string }>;
}>(sessions: T[], rememberedId: string | null, activeMac: string | null): T | null {
  if (!activeMac) return null;
  const mine = sessions.filter((item) => item.mac === activeMac);
  const newest = [...mine].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((item) => item.status === "succeeded" || item.status === "failed" || item.status === "interrupted");
  const verified = mine
    .filter((item) => item.status === "succeeded" && applicationInstallReady(item.checks))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (verified[0] && (!newest || verified[0].updatedAt >= newest.updatedAt)) return verified[0];
  if (newest && verified[0] && newest.updatedAt > verified[0].updatedAt) return newest;
  const remembered = mine.find((item) => item.id === rememberedId);
  if (remembered) return remembered;
  return [...mine]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((item) => item.status === "succeeded" || item.status === "failed" || item.status === "interrupted") ?? null;
}

export function historicalDeviceSeed<T extends {
  mac: string | null;
  updatedAt: string;
  status?: string;
  bootVerified?: boolean;
  matterReady?: boolean;
  threadReady?: boolean;
  versionVerified?: boolean;
  checks?: Array<{ id: string; status: string }>;
}>(records: T[]): T | null {
  return records
    .filter((item) => {
      if (!item.mac) return false;
      if (item.checks) return item.status === "succeeded" && applicationInstallReady(item.checks);
      return Boolean(item.bootVerified && item.versionVerified);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function identifiedHardware(input: { probeAccepted: boolean; mac?: string | null; port: string | null; connected: boolean }): boolean {
  return Boolean(input.connected && input.port && input.probeAccepted && input.mac);
}

export function identityLabel(status: "verified" | "historical" | "unknown"): string {
  if (status === "verified") return "Connected Device — Verified";
  if (status === "historical") return "Previously Identified Device";
  return "Device Identity Unknown";
}

function installationForMac<T extends { mac: string | null; updatedAt?: string }>(items: T[], mac: string | null): T | null {
  if (!mac) return null;
  return items
    .filter((item) => item.mac === mac)
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0] ?? null;
}

export function selectSmartHomeInstallation<T extends { mac: string | null; updatedAt?: string }>(input: {
  installations: T[];
  activeMac: string | null;
  urlMac: string | null;
  history: boolean;
}): { displayed: T | null; active: T | null; mode: "current" | "historical" | "mismatch" | "unresolved" } {
  const active = installationForMac(input.installations, input.activeMac);
  const addressed = installationForMac(input.installations, input.urlMac);
  if (input.history && input.urlMac) return { displayed: addressed, active, mode: "historical" };
  if (input.activeMac) {
    return { displayed: active, active, mode: input.urlMac && input.urlMac !== input.activeMac ? "mismatch" : "current" };
  }
  return { displayed: null, active: null, mode: "unresolved" };
}

export function applyLiveIdentity(current: SetupRecord, probe: {
  accepted: boolean;
  mac: string | null;
  model: string | null;
  revision: string | null;
  flash: string | null;
  at: string;
}, sessionMac: string | null): SetupRecord {
  if (!probe.accepted || !probe.mac) {
    return {
      ...current,
      deviceIdentity: current.deviceMac && current.deviceIdentity === "verified" ? "historical" : current.deviceIdentity,
      hardware: current.deviceMac ? "not_verified" : "not_started",
    };
  }
  const replaced = current.deviceMac != null && current.deviceMac !== probe.mac;
  return {
    ...current,
    deviceMac: probe.mac,
    deviceModel: probe.model,
    deviceRevision: probe.revision,
    deviceFlash: probe.flash,
    deviceProbeAt: probe.at,
    deviceProbeSource: "chip_id",
    deviceIdentity: "verified",
    deviceSessionId: sessionMac === probe.mac ? current.deviceSessionId ?? current.programSessionId : null,
    programSessionId: replaced && sessionMac !== probe.mac ? null : current.programSessionId,
    hardware: "ready",
    hardwareEvidence: null,
    lastHardwareEvidenceAt: probe.at,
    appleHomeConfirmedAt: replaced ? null : current.appleHomeConfirmedAt,
    smartHome: replaced ? "not_started" : current.smartHome,
  };
}

export function eraseControl(identified: boolean): { label: string; enabled: boolean } {
  return identified
    ? { label: "Full Flash Erase — Selectable", enabled: true }
    : { label: "Full Flash Erase — Disabled", enabled: false };
}

export function nextEraseAction(assessment: {
  enabled: boolean;
  device: { mac: string | null } | null;
  security: { reflashable: boolean } | null;
  backup: { verified: boolean; complete: boolean } | null;
} | null): "assess" | "backup" | "verify" | "ready" | "blocked" {
  if (!assessment) return "assess";
  if (!assessment.security?.reflashable || !assessment.device?.mac) return "blocked";
  if (!assessment.backup) return "backup";
  if (!assessment.backup.verified || !assessment.backup.complete) return "verify";
  if (!assessment.enabled) return "blocked";
  return "ready";
}

export function smartHomeTarget(input: { name: string; firmware: string | null; softwareVersion: number | null; mac: string | null }): string {
  const params = new URLSearchParams();
  if (input.name.trim()) params.set("name", input.name.trim());
  if (input.firmware) params.set("firmware", input.firmware);
  if (input.softwareVersion != null) params.set("softwareVersion", String(input.softwareVersion));
  if (input.mac && input.mac !== "Not Verified") params.set("mac", input.mac);
  params.set("source", "setup");
  const query = params.toString();
  return query ? `/smart-home?${query}` : "/smart-home";
}
