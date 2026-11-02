import { describe, expect, it } from "vitest";
import { EMPTY_SETUP } from "./setup.js";
import {
  INSTALL_STAGES,
  activeInstallStage,
  applyLiveIdentity,
  chooseFirmwarePackage,
  currentSetupStep,
  eraseControl,
  firmwareReady,
  historicalDeviceSeed,
  identifiedHardware,
  applicationInstallReady,
  displayedStartupChecks,
  bootCaptureReport,
  installationHeadline,
  nextEraseAction,
  preferredProgramSession,
  selectSmartHomeInstallation,
  smartHomeTarget,
} from "./setup-flow.js";

const older = { id: "older", softwareVersion: 3, createdAt: "2026-10-01T00:00:00.000Z", compatible: true };
const current = { id: "current", softwareVersion: 4, createdAt: "2026-10-20T00:00:00.000Z", compatible: true };
const incompatible = { id: "other", softwareVersion: 9, createdAt: "2026-10-21T00:00:00.000Z", compatible: false };

describe("three-step setup", () => {
  it("keeps installation closed until the chip answers, then smart home until boot is verified", () => {
    expect(currentSetupStep({ identified: false, bootVerified: false })).toBe(1);
    expect(currentSetupStep({ identified: true, bootVerified: false })).toBe(2);
    expect(currentSetupStep({ identified: true, bootVerified: true })).toBe(3);
  });

  it("selects the latest compatible package and keeps an explicit compatible choice", () => {
    expect(chooseFirmwarePackage([older, incompatible, current], null)).toBe("current");
    expect(chooseFirmwarePackage([older, current], "older")).toBe("older");
    expect(chooseFirmwarePackage([incompatible], "other")).toBeNull();
  });

  it("moves installation progress from validation to completion without skipping confirmation", () => {
    expect(INSTALL_STAGES).toEqual(["Validating", "Preparing", "Flashing", "Verifying", "Complete"]);
    expect(activeInstallStage({ validating: true, confirming: false, sessionStatus: null, sessionStage: null, boot: null })).toBe("Validating");
    expect(activeInstallStage({ validating: false, confirming: true, sessionStatus: null, sessionStage: null, boot: null })).toBe("Preparing");
    expect(activeInstallStage({ validating: false, confirming: false, sessionStatus: "running", sessionStage: "writing", boot: null })).toBe("Flashing");
    expect(activeInstallStage({ validating: false, confirming: false, sessionStatus: "succeeded", sessionStage: "monitoring", boot: "unknown" })).toBe("Verifying");
    expect(activeInstallStage({ validating: false, confirming: false, sessionStatus: "succeeded", sessionStage: "idle", boot: "unknown" })).toBeNull();
    expect(activeInstallStage({ validating: false, confirming: false, sessionStatus: "succeeded", sessionStage: "idle", boot: "passed", verified: true })).toBe("Complete");
    expect(activeInstallStage({ validating: false, confirming: false, sessionStatus: "failed", sessionStage: "idle", boot: null })).toBeNull();
  });

  it("carries the selected node to Smart Home Connection", () => {
    expect(smartHomeTarget({ name: "Kitchen", firmware: "1.3.0", softwareVersion: 4, mac: "48:31:b7:cf:3d:52" }))
      .toBe("/smart-home?name=Kitchen&firmware=1.3.0&softwareVersion=4&mac=48%3A31%3Ab7%3Acf%3A3d%3A52&source=setup");
  });
});

describe("boot verification outcome", () => {
  const passed = ["boot", "matter", "openthread", "dht11", "version"].map((id) => ({ id, status: "passed" }));

  it("keeps a missing serial log pending and unlocks smart home only after the startup checks pass", () => {
    expect(installationHeadline([{ id: "write", status: "passed" }, { id: "boot", status: "unknown" }], "succeeded")).toBe("Flash contents were verified. Application startup has not been captured yet.");
    expect(installationHeadline([{ id: "write", status: "passed" }, { id: "boot", status: "unknown" }], "succeeded", "Unable to verify firmware boot. Flash contents were verified, but no application startup was observed.")).toBe("Unable to verify firmware boot. Flash contents were verified, but no application startup was observed.");
    expect(installationHeadline([{ id: "boot", status: "passed" }, { id: "matter", status: "unknown" }], "succeeded")).toBe("Firmware installation succeeded. Matter commissioning has not yet been performed.");
    expect(installationHeadline([], "interrupted", "Flash verification timed out. The result is unknown. Review the diagnostic log before retrying.")).toMatch(/result is unknown/);
    expect(installationHeadline([{ id: "boot", status: "unknown" }], "succeeded", "The console shows ROM download mode. Application startup was not observed. Flash was not rewritten.")).toMatch(/ROM download mode/);
    expect(installationHeadline([{ id: "boot", status: "unknown" }], "succeeded", "No application output was captured. A silent console is not proof that the firmware crashed. Flash was not rewritten.")).toMatch(/silent console/);
    expect(installationHeadline([{ id: "boot", status: "unknown" }], "succeeded", "The bootloader started from SPI flash. Application startup was not captured. Flash was not rewritten.")).toMatch(/bootloader started/i);
    const report = bootCaptureReport("note: console port /dev/cu.usbmodem14301\nnote: console opened\nnote: reset requested\nnote: usb interface disconnected\nnote: usb interface reappeared\nESP-ROM:esp32h2-eco5-20240613\nI (23) boot: ESP-IDF v5.4.1 2nd stage bootloader\nnote: bytes received 42\nnote: capture ended before application startup was settled", "/dev/cu.usbmodem14301");
    expect(report.find((item) => item.label === "Port opened")?.value).toBe("Yes");
    expect(report.find((item) => item.label === "Reset requested")?.value).toBe("Yes");
    expect(report.find((item) => item.label === "USB disconnected")?.value).toBe("Yes");
    expect(report.find((item) => item.label === "Characters received")?.value).toBe("42");
    expect(report.find((item) => item.label === "ROM boot")?.value).toBe("Captured");
    expect(report.find((item) => item.label === "Application startup")?.value).toBe("Not captured");
    expect(installationHeadline([{ id: "boot", status: "passed" }, { id: "matter", status: "failed" }], "succeeded")).toBe("Firmware Installed — Verification Failed.");
    expect(installationHeadline(passed, "succeeded")).toBe("Firmware Installed and Verified.");
    expect(installationHeadline(passed.filter((item) => item.id !== "dht11"), "succeeded")).toBe("Firmware Installed and Verified.");
    expect(installationHeadline([], "failed")).toBe("Firmware Installation Failed.");
    expect(firmwareReady(passed)).toBe(true);
    expect(firmwareReady(passed.filter((item) => item.id !== "dht11"))).toBe(true);
    expect(firmwareReady([{ id: "boot", status: "passed" }])).toBe(false);
    expect(currentSetupStep({ identified: true, bootVerified: firmwareReady(passed) })).toBe(3);
    const pending = { id: "old", mac: "48:31:b7:cf:37:5f", port: "/dev/cu.usbmodem1", status: "succeeded", updatedAt: "2026-10-24T00:00:00.000Z", checks: [{ id: "boot", status: "unknown" }] };
    const verified = { id: "new", mac: "48:31:b7:cf:37:5f", port: "/dev/cu.usbmodem1", status: "succeeded", updatedAt: "2026-10-24T01:00:00.000Z", checks: passed };
    const otherBoard = { id: "previous", mac: "48:31:b7:cf:3d:52", port: "/dev/cu.usbmodem1", status: "succeeded", updatedAt: "2026-10-24T00:30:00.000Z", checks: passed };
    expect(preferredProgramSession([pending, verified, otherBoard], "old", "48:31:b7:cf:37:5f")?.id).toBe("new");
    expect(preferredProgramSession([pending], "old", "48:31:b7:cf:37:5f")?.id).toBe("old");
    expect(preferredProgramSession([otherBoard], "previous", null)).toBeNull();
    expect(historicalDeviceSeed([otherBoard, verified])?.id).toBe("new");
  });

  it("does not treat a chip model or a saved port as a live identity", () => {
    expect(identifiedHardware({ probeAccepted: false, mac: "48:31:b7:cf:3d:52", port: "/dev/cu.usbmodem1", connected: true })).toBe(false);
    expect(identifiedHardware({ probeAccepted: true, mac: null, port: "/dev/cu.usbmodem1", connected: true })).toBe(false);
    expect(identifiedHardware({ probeAccepted: true, mac: "48:31:b7:cf:37:5f", port: "/dev/cu.usbmodem1", connected: false })).toBe(false);
    expect(identifiedHardware({ probeAccepted: true, mac: "48:31:b7:cf:37:5f", port: "/dev/cu.usbmodem1", connected: true })).toBe(true);
    expect(eraseControl(false).enabled).toBe(false);
    expect(eraseControl(true).enabled).toBe(true);
  });
});

describe("physical device selection", () => {
  const probe = { accepted: true, mac: "48:31:b7:cf:37:5f", model: "ESP32-H2", revision: "v0.1", flash: "4MB", at: "2026-10-24T01:48:19.000Z" };

  it("replaces the active device when a live probe reads a different MAC and keeps the old record out of that selection", () => {
    const previous = { ...EMPTY_SETUP, deviceMac: "48:31:b7:cf:3d:52", deviceIdentity: "historical" as const, programSessionId: "old-session", appleHomeConfirmedAt: "2026-10-24T01:00:00.000Z" };
    const next = applyLiveIdentity(previous, probe, "48:31:b7:cf:3d:52");
    expect(next.deviceMac).toBe("48:31:b7:cf:37:5f");
    expect(next.deviceIdentity).toBe("verified");
    expect(next.deviceProbeSource).toBe("chip_id");
    expect(next.programSessionId).toBeNull();
    expect(next.appleHomeConfirmedAt).toBeNull();
    const failed = applyLiveIdentity(EMPTY_SETUP, { ...probe, accepted: false, mac: null }, "48:31:b7:cf:3d:52");
    expect(failed.deviceMac).toBeNull();
    expect(failed.deviceIdentity).toBe("unknown");
  });

  it("keeps a stale URL from selecting another board while an explicit history view stays separate", () => {
    const records = [
      { mac: "48:31:b7:cf:3d:52", sessionId: "old" },
      { mac: "48:31:b7:cf:37:5f", sessionId: "new" },
    ];
    const current = selectSmartHomeInstallation({ installations: records, activeMac: "48:31:b7:cf:37:5f", urlMac: "48:31:b7:cf:3d:52", history: false });
    expect(current.mode).toBe("mismatch");
    expect(current.displayed?.sessionId).toBe("new");
    const history = selectSmartHomeInstallation({ installations: records, activeMac: "48:31:b7:cf:37:5f", urlMac: "48:31:b7:cf:3d:52", history: true });
    expect(history.mode).toBe("historical");
    expect(history.displayed?.sessionId).toBe("old");
    expect(history.active?.sessionId).toBe("new");
    expect(selectSmartHomeInstallation({ installations: records, activeMac: null, urlMac: "48:31:b7:cf:3d:52", history: false }).mode).toBe("unresolved");
    const duplicates = [
      { mac: "48:31:b7:cf:37:b7", sessionId: "older-fabric", updatedAt: "2026-10-24T04:30:00.000Z" },
      { mac: "48:31:b7:cf:37:b7", sessionId: "later-reset", updatedAt: "2026-10-24T04:43:00.000Z" },
    ];
    expect(selectSmartHomeInstallation({ installations: duplicates, activeMac: "48:31:b7:cf:37:b7", urlMac: null, history: false }).displayed?.sessionId).toBe("later-reset");
  });
});

describe("smart home navigation after a verified boot", () => {
  const checks = (statuses: Record<string, string>) => Object.entries(statuses).map(([id, status]) => ({ id, status }));

  it("opens after boot and version without Matter, and rejects a stale or mismatched session", () => {
    const booted = checks({ boot: "passed", version: "passed", matter: "unknown", openthread: "unknown" });
    expect(applicationInstallReady(booted)).toBe(true);
    expect(firmwareReady(booted)).toBe(false);
    expect(installationHeadline(checks({ boot: "passed", version: "passed", matter: "failed", openthread: "unknown" }), "succeeded")).toBe("Application boot verified. Matter startup was not reached.");
    expect(applicationInstallReady(checks({ boot: "passed", version: "failed" }))).toBe(false);
    expect(applicationInstallReady(checks({ boot: "unknown", version: "passed" }))).toBe(false);
    const sessions = [
      { id: "old", mac: "10:51:db:68:64:4c", status: "succeeded", updatedAt: "2026-10-24T13:00:00.000Z", checks: checks({ boot: "passed", matter: "passed", openthread: "passed", version: "passed" }) },
      { id: "current", mac: "10:51:db:68:64:4c", status: "succeeded", updatedAt: "2026-10-25T00:18:00.000Z", checks: booted },
      { id: "other", mac: "48:31:b7:cf:37:b7", status: "succeeded", updatedAt: "2026-10-25T01:00:00.000Z", checks: booted },
    ];
    expect(preferredProgramSession(sessions, "old", "10:51:db:68:64:4c")?.id).toBe("current");
    expect(preferredProgramSession(sessions, "current", "48:31:b7:cf:37:b7")?.id).toBe("other");
    const reflashed = [
      ...sessions,
      { id: "newer-flash", mac: "10:51:db:68:64:4c", status: "succeeded", updatedAt: "2026-10-25T02:00:00.000Z", checks: checks({ boot: "unknown", version: "unknown" }) },
    ];
    expect(preferredProgramSession(reflashed, "current", "10:51:db:68:64:4c")?.id).toBe("newer-flash");
    expect(historicalDeviceSeed([{ mac: "10:51:db:68:64:4c", status: "succeeded", updatedAt: "2026-10-25T00:18:00.000Z", checks: booted }])?.mac).toBe("10:51:db:68:64:4c");
    expect(historicalDeviceSeed([{ mac: "10:51:db:68:64:4c", status: "succeeded", updatedAt: "2026-10-25T00:18:00.000Z", checks: checks({ boot: "passed", version: "unknown" }) }])).toBeNull();
    const shown = displayedStartupChecks(
      [{ id: "matter", status: "unknown", detail: "Not yet performed." }],
      "Failed to register the RGB light, err:261",
    );
    expect(shown[0]?.status).toBe("failed");
    expect(displayedStartupChecks([{ id: "matter", status: "unknown", detail: "Not yet performed." }], "Failed to register the RGB light\nServer Listening...")[0]?.status).toBe("unknown");
    expect(displayedStartupChecks([{ id: "matter", status: "passed", detail: "Verified." }], "chip[DL]: OpenThread started: OK\nCHIP task running")[0]?.status).toBe("unknown");
    expect(displayedStartupChecks([{ id: "matter", status: "passed", detail: "Verified." }], "Server Listening...")[0]?.status).toBe("passed");
  });
});

describe("full flash erase availability", () => {
  it("can be opened after identification and still cannot execute until preparation is ready", () => {
    expect(eraseControl(false)).toEqual({ label: "Full Flash Erase — Disabled", enabled: false });
    expect(eraseControl(true).enabled).toBe(true);
    expect(nextEraseAction(null)).toBe("assess");
    expect(nextEraseAction({ enabled: false, device: { mac: "48:31:b7:cf:3d:52" }, security: { reflashable: false }, backup: null })).toBe("blocked");
    expect(nextEraseAction({ enabled: false, device: { mac: "48:31:b7:cf:3d:52" }, security: { reflashable: true }, backup: null })).toBe("backup");
    expect(nextEraseAction({ enabled: false, device: { mac: "48:31:b7:cf:3d:52" }, security: { reflashable: true }, backup: { verified: false, complete: true } })).toBe("verify");
    expect(nextEraseAction({ enabled: false, device: { mac: "48:31:b7:cf:3d:52" }, security: { reflashable: true }, backup: { verified: true, complete: true } })).toBe("blocked");
    expect(nextEraseAction({ enabled: true, device: { mac: "48:31:b7:cf:3d:52" }, security: { reflashable: true }, backup: { verified: true, complete: true } })).toBe("ready");
  });
});
