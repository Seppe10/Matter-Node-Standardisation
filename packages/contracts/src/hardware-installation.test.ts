import { describe, expect, it } from "vitest";
import { DEVELOPMENT_ONBOARDING, commissioningFromLog, compiledTestOnboarding, decodeMatterPayload, elfSha256Matches, firmwareStartupStages, identifyHardwareMac, installationIdentity, macFromDeviceLog, onboardingDecision, readAdvertisedOnboarding, readDeviceOnboarding, readElfSha256Prefix, smartHomeCommissioningCopy, usesCompiledTestDiscriminator, verifyOnboarding } from "./hardware-installation.js";

const verifiedIdentity = {
  writeCompleted: true,
  bootVerified: true,
  matterReady: true,
  threadReady: true,
  versionVerified: true,
  softwareVersion: 4,
  softwareVersionString: "1.3.0",
  vendorId: 0xfff1,
  productId: 0x8000,
};

function matchedFields() {
  return {
    softwareVersion: 4,
    softwareVersionString: "1.3.0",
    vendorId: 0xfff1,
    productId: 0x8000,
    advertisedDiscriminator: 3840,
    discriminatorRedacted: false,
    advertisedVendorId: 65521,
    advertisedProductId: 32768,
  };
}

describe("hardware installation evidence", () => {
  it("reads the Bluetooth MAC and a stored fabric without treating the QR as an open window", () => {
    const log = [
      "I (790) NimBLE: Bluetooth MAC: 48:31:b7:cf:3d:52",
      "I (860) chip[DL]: OpenThread started: OK",
      "I (1350) chip[FP]: Fabric index 0x2 was retrieved from storage. VendorId 0x1384",
      "I (1420) chip[SVR]: Fabric already commissioned. Disabling BLE advertisement",
      "I (1440) chip[SVR]: Server Listening...",
      "I (1450) chip[DIS]: Updating services using commissioning mode 0",
    ].join("\n");
    expect(macFromDeviceLog(log)).toBe("48:31:b7:cf:3d:52");
    const commissioning = commissioningFromLog(log);
    expect(commissioning.state).toBe("commissioned");
    expect(commissioning.windowOpen).toBe(false);
    expect(commissioning.appleHomeFabric).toBe(false);
    expect(commissioning.fabricVendors).toEqual(["1384"]);
    expect(onboardingDecision({ ...verifiedIdentity, commissioningState: "commissioned", commissioningWindowOpen: false }).show).toBe(false);
  });

  it("shows the development QR when the payload is verified and warns if the window is not proven open", () => {
    const open = onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: null,
      onboardingStatus: "verified",
      windowNow: "unknown",
    });
    expect(open.show).toBe(true);
    expect(open.payload).toBe("MT:Y.K9042C00KA0648G00");
    expect(open.manualCode).toBe("34970112332");
    expect(open.windowWarning).toMatch(/not verified as open now/);
    expect(onboardingDecision({ ...verifiedIdentity, commissioningState: "unknown", commissioningWindowOpen: null }).show).toBe(false);
    expect(onboardingDecision({ ...verifiedIdentity, softwareVersionString: "1.2.0", commissioningState: "uncommissioned", commissioningWindowOpen: true, onboardingStatus: "not_verified" }).show).toBe(false);
    expect(onboardingDecision({ ...verifiedIdentity, softwareVersionString: "1.5.0", softwareVersion: 6, commissioningState: "uncommissioned", commissioningWindowOpen: true, onboardingStatus: "verified" }).reason).toMatch(/shared development setup code/);
    expect(onboardingDecision({ ...verifiedIdentity, vendorId: null, commissioningState: "uncommissioned", commissioningWindowOpen: true, onboardingStatus: "verified" }).show).toBe(false);
    expect(onboardingDecision({
      ...verifiedIdentity,
      bootVerified: false,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: true,
      onboardingStatus: "verified",
    }).reason).toMatch(/No stored Matter onboarding payload/);
    expect(onboardingDecision({
      ...verifiedIdentity,
      bootVerified: false,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: true,
      onboardingStatus: "verified",
    }).reason).not.toMatch(/firmware/);
  });

  it("reads the 12:48 pm first-boot pattern without calling the window closed", () => {
    const log = [
      "App version: 1.3.0",
      "OpenThread started: OK",
      "DefaultAclStorage: 0 entries",
      "commissioning mode 1",
      "CHIPoBLE advertising started",
      "Failed to advertise commissionable node: 3",
      "Server Listening...",
    ].join("\n");
    const commissioning = commissioningFromLog(log);
    expect(commissioning.state).toBe("uncommissioned");
    expect(commissioning.windowNow).toBe("unknown");
    expect(commissioning.windowOpen).toBeNull();
    expect(commissioning.bleAdvertisingObserved).toBe(true);
    expect(commissioning.lastWindowEvent).toBe("ble_advertising_started");
    expect(commissioning.dnsSdWarning).toMatch(/error 3/);
    expect(commissioning.detail).toMatch(/does not show that the commissioning window is still open/);
  });

  it("keeps incomplete, conflicting, and closed logs from claiming an open window", () => {
    expect(commissioningFromLog("Server Listening...").state).toBe("unknown");
    expect(commissioningFromLog("App version: 1.3.0").state).toBe("unknown");
    const conflict = commissioningFromLog("Fabric already commissioned\nCHIPoBLE advertising started\ncommissioning mode 1\nServer Listening...");
    expect(conflict.state).toBe("unknown");
    const closed = commissioningFromLog("Server Listening...\ncommissioning mode 1\nCHIPoBLE advertising started\nCommissioning window timeout");
    expect(closed.windowNow).toBe("closed");
    expect(closed.windowOpen).toBe(false);
  });

  it("verifies the development payload only when the advertisement discriminator matches", () => {
    const decoded = decodeMatterPayload(DEVELOPMENT_ONBOARDING.qrPayload, DEVELOPMENT_ONBOARDING.manualCode);
    expect(decoded?.passcode).toBe(20202021);
    expect(decoded?.discriminator).toBe(0xf00);
    expect(decoded?.vendorId).toBe(0xfff1);
    expect(decoded?.productId).toBe(0x8000);
    expect(decoded?.manualCodeMatches).toBe(true);
    const raw = "Advertise commission parameter vendorID=65521 productID=32768 discriminator=3840/00";
    expect(readAdvertisedOnboarding(raw).discriminator).toBe(3840);
    const matched = verifyOnboarding({
      softwareVersion: 4,
      softwareVersionString: "1.3.0",
      vendorId: 0xfff1,
      productId: 0x8000,
      advertisedDiscriminator: 3840,
      discriminatorRedacted: false,
      advertisedVendorId: 65521,
      advertisedProductId: 32768,
    });
    expect(matched.status).toBe("verified");
    expect(JSON.stringify(matched)).not.toContain("20202021");
    expect(verifyOnboarding({
      ...matchedFields(),
      advertisedDiscriminator: 1,
    }).status).toBe("invalid");
    expect(verifyOnboarding({ ...matchedFields(), advertisedDiscriminator: null, discriminatorRedacted: true }).reason).toMatch(/removed the number/);
    expect(verifyOnboarding({ ...matchedFields(), advertisedDiscriminator: null, discriminatorRedacted: false }).reason).toMatch(/does not contain/);
    expect(verifyOnboarding({ ...matchedFields(), productId: 1 }).status).toBe("not_verified");
    expect(verifyOnboarding({ ...matchedFields(), softwareVersionString: "1.2.0" }).status).toBe("not_verified");
    const currentFirmware = verifyOnboarding({
      ...matchedFields(),
      softwareVersion: 6,
      softwareVersionString: "1.5.0",
      usesCompiledTestDiscriminator: true,
    });
    expect(currentFirmware.status).toBe("verified");
    expect(currentFirmware.reason).toMatch(/shared development|compiled test discriminator/);
    expect(JSON.stringify(currentFirmware)).not.toContain("20202021");
    const unconfirmed = verifyOnboarding({
      ...matchedFields(),
      softwareVersion: 6,
      softwareVersionString: "1.5.0",
    });
    expect(unconfirmed.status).toBe("not_verified");
    expect(unconfirmed.reason).toMatch(/did not print a setup passcode/);
    expect(unconfirmed.reason).not.toMatch(/20202021/);
  });

  it("keeps Apple Home distinct from another stored vendor", () => {
    const home = commissioningFromLog("Fabric index 0x1 was retrieved from storage. VendorId 0x1349\nFabric already commissioned");
    expect(commissioningFromLog("Existing Matter fabric count 1. The first-time onboarding code is not printed.").state).toBe("commissioned");
    expect(commissioningFromLog("Matter server is up. Fabric count 0.\nSetupQRCode: [MT:Y.K9042C00KA0648G00]").state).toBe("uncommissioned");
    expect(home.appleHomeFabric).toBe(true);
    expect(home.state).toBe("commissioned");
    const listening = commissioningFromLog("I (1440) chip[SVR]: Server Listening...");
    expect(listening.state).toBe("unknown");
    expect(listening.windowOpen).toBe(null);
  });

  it("drops an older stored fabric after a factory reset until a later boot is captured", () => {
    const log = [
      "rst:0x1 (POWERON)",
      "Bluetooth MAC: 48:31:b7:cf:37:b7",
      "Fabric index 0x2 was retrieved from storage. VendorId 0x1384",
      "Fabric already commissioned",
      "commissioning mode 0",
      "Starting factory reset",
    ].join("\n");
    const commissioning = commissioningFromLog(log);
    expect(commissioning.state).toBe("unknown");
    expect(commissioning.fabricVendors).toEqual([]);
    expect(commissioning.detail).toMatch(/factory reset was logged/i);
    expect(smartHomeCommissioningCopy(commissioning).headline).toBe("Factory reset completed but current state not yet verified");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: commissioning.state,
      commissioningWindowOpen: commissioning.windowOpen,
      onboardingStatus: "verified",
      windowNow: commissioning.windowNow,
    }).show).toBe(false);
  });

  it("treats a boot after factory reset as factory-new when that boot has no stored fabric", () => {
    const log = [
      "VendorId 0x1384",
      "Fabric already commissioned",
      "Starting factory reset",
      "rst:0x1 (POWERON)",
      "Bluetooth MAC: 48:31:b7:cf:37:b7",
      "Server Listening...",
      "commissioning mode 1",
      "CHIPoBLE advertising started",
    ].join("\n");
    const commissioning = commissioningFromLog(log);
    expect(commissioning.state).toBe("uncommissioned");
    expect(commissioning.fabricVendors).toEqual([]);
    expect(smartHomeCommissioningCopy(commissioning).headline).toBe("Factory-new and ready for commissioning");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: commissioning.state,
      commissioningWindowOpen: null,
      onboardingStatus: "verified",
      windowNow: commissioning.windowNow,
    }).show).toBe(true);
  });

  it("lets a fabric retrieved after reset and reflash supersede the reset", () => {
    const log = [
      "Starting factory reset",
      "rst:0x1 (POWERON)",
      "Bluetooth MAC: 48:31:b7:cf:37:b7",
      "App version: 1.3.0",
      "Fabric index 0x2 was retrieved from storage. VendorId 0x1384",
      "Fabric already commissioned",
      "commissioning mode 0",
    ].join("\n");
    const commissioning = commissioningFromLog(log);
    expect(commissioning.state).toBe("commissioned");
    expect(commissioning.fabricVendors).toEqual(["1384"]);
    expect(commissioning.windowNow).toBe("closed");
    expect(smartHomeCommissioningCopy(commissioning).headline).toBe("Existing fabric detected");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "commissioned",
      commissioningWindowOpen: false,
      onboardingStatus: "verified",
    }).show).toBe(false);
  });

  it("keeps Bluetooth identities for separate ESP32-H2 boards and does not treat a Bluetooth MAC as a chip-id probe", () => {
    expect(identifyHardwareMac("Bluetooth MAC: 48:31:b7:cf:37:b7").source).toBe("bluetooth_mac");
    expect(identifyHardwareMac("BASE MAC: 48:31:b7:cf:3d:52\nBluetooth MAC: 48:31:b7:cf:3d:54")).toEqual({
      mac: "48:31:b7:cf:3d:52",
      source: "base_mac",
      conflict: false,
    });
    const mixed = [
      "rst:0x1 (POWERON)",
      "Bluetooth MAC: 48:31:b7:cf:37:5f",
      "rst:0x1 (POWERON)",
      "Bluetooth MAC: 48:31:b7:cf:37:b7",
      "VendorId 0x1384",
      "Fabric already commissioned",
    ].join("\n");
    expect(identifyHardwareMac(mixed).conflict).toBe(true);
    expect(macFromDeviceLog(mixed)).toBeNull();
    expect(commissioningFromLog(mixed).state).toBe("commissioned");
  });

  it("names a closed window and insufficient evidence separately from a stored fabric", () => {
    expect(smartHomeCommissioningCopy(commissioningFromLog("commissioning window closed")).headline).toBe("Commissioning window expired");
    expect(smartHomeCommissioningCopy(commissioningFromLog("Server Listening...")).headline).toBe("Current state unknown");
  });
});

const PACKAGE_SHA = "a4a5dcfd3e8e7f6892251ba3bab87e8267161369ddcfe067d10aaf446f7d32a2";
const OTHER_SHA = "9959a23ed13ac411283003a8c8029b5875af75c64067149606a9abee06363e85";
const COMPILED_DISCRIMINATOR = [
  "CONFIG_ENABLE_TEST_SETUP_PARAMS=y",
  "CONFIG_EXAMPLE_COMMISSIONABLE_DATA_PROVIDER=y",
  "# CONFIG_ENABLE_ESP32_FACTORY_DATA_PROVIDER is not set",
  "# CONFIG_SEC_CERT_COMMISSIONABLE_DATA_PROVIDER is not set",
  "# CONFIG_CUSTOM_COMMISSIONABLE_DATA_PROVIDER is not set",
].join("\n");

function imageFields(prefix: string | null = "a4a5dcfd3") {
  return {
    ...matchedFields(),
    advertisedDiscriminator: null,
    discriminatorRedacted: false,
    advertisedVendorId: null,
    advertisedProductId: null,
    imageSha256Prefix: prefix,
    packageElfSha256: PACKAGE_SHA,
    usesCompiledTestDiscriminator: true,
  };
}

describe("onboarding verification levels", () => {
  it("accepts the compiled development discriminator only from the selected sdkconfig flags", () => {
    expect(usesCompiledTestDiscriminator(COMPILED_DISCRIMINATOR)).toBe(true);
    expect(usesCompiledTestDiscriminator(COMPILED_DISCRIMINATOR.replace("# CONFIG_ENABLE_ESP32_FACTORY_DATA_PROVIDER is not set", "CONFIG_ENABLE_ESP32_FACTORY_DATA_PROVIDER=y"))).toBe(false);
    expect(elfSha256Matches("a4a5dcfd3", PACKAGE_SHA)).toBe("verified");
    expect(elfSha256Matches("a4a5dcfd3", OTHER_SHA)).toBe("mismatch");
    expect(elfSha256Matches(null, PACKAGE_SHA)).toBe("unknown");
    expect(readElfSha256Prefix("ELF file SHA256:  a4a5dcfd3...")).toBe("a4a5dcfd3");
  });

  it("shows the QR for a factory-new device whose image matches when the UART discriminator was removed", () => {
    const redacted = verifyOnboarding({ ...imageFields(), discriminatorRedacted: true, advertisedVendorId: 65521, advertisedProductId: 32768 });
    expect(redacted.status).toBe("image_verified");
    expect(redacted.payload).toBe("consistent");
    expect(redacted.imageIdentity).toBe("verified");
    expect(redacted.discriminatorEvidence).toBe("redacted");
    expect(redacted.reason).toMatch(/Verified from installed firmware — live BLE advertisement not confirmed/);
    expect(redacted.reason).not.toMatch(/20202021/);
    const decision = onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: null,
      windowNow: "unknown",
      onboardingStatus: redacted.status,
      onboardingReason: redacted.reason,
    });
    expect(decision.show).toBe(true);
    expect(decision.payload).toBe(DEVELOPMENT_ONBOARDING.qrPayload);
    expect(decision.reason).toBe("Verified from installed firmware — live BLE advertisement not confirmed.");
    expect(decision.windowWarning).toMatch(/not verified as open now/);
  });

  it("shows the same firmware QR when the boot has no discriminator line and the image matches", () => {
    const missing = verifyOnboarding(imageFields());
    expect(missing.discriminatorEvidence).toBe("absent");
    expect(missing.status).toBe("image_verified");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: null,
      windowNow: "unknown",
      onboardingStatus: missing.status,
    }).show).toBe(true);
  });

  it("keeps the QR hidden when the image is unknown, mismatched, or the live discriminator disagrees", () => {
    expect(verifyOnboarding({ ...imageFields(), imageSha256Prefix: null, packageElfSha256: null }).status).toBe("not_verified");
    expect(verifyOnboarding({ ...imageFields(), imageSha256Prefix: "9959a23ed" }).status).toBe("invalid");
    expect(verifyOnboarding({ ...imageFields(), imageSha256Prefix: "9959a23ed", usesCompiledTestDiscriminator: false }).imageIdentity).toBe("mismatch");
    const mismatch = verifyOnboarding({ ...matchedFields(), advertisedDiscriminator: 1, imageSha256Prefix: "a4a5dcfd3", packageElfSha256: PACKAGE_SHA, usesCompiledTestDiscriminator: true });
    expect(mismatch.discriminatorEvidence).toBe("live_mismatch");
    expect(mismatch.status).toBe("invalid");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: true,
      windowNow: "open",
      onboardingStatus: "invalid",
      onboardingReason: mismatch.reason,
    }).show).toBe(false);
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "uncommissioned",
      commissioningWindowOpen: null,
      onboardingStatus: "not_verified",
    }).show).toBe(false);
  });

  it("rejects an invalid QR or manual code even when the image hash matches", () => {
    expect(decodeMatterPayload("MT:!!!!", DEVELOPMENT_ONBOARDING.manualCode)).toBeNull();
    const badManual = decodeMatterPayload(DEVELOPMENT_ONBOARDING.qrPayload, "00000000000");
    expect(badManual?.manualCodeMatches).toBe(false);
    expect(verifyOnboarding({ ...imageFields(), qrPayload: "MT:!!!!" }).status).toBe("invalid");
    expect(verifyOnboarding({ ...imageFields(), manualCode: "00000000000" }).payload).toBe("invalid");
  });

  it("does not let a stale fabric or another board's image show this board's QR", () => {
    const other = verifyOnboarding({ ...imageFields("9959a23ed"), packageElfSha256: OTHER_SHA });
    expect(other.imageIdentity).toBe("verified");
    expect(verifyOnboarding({ ...imageFields("a4a5dcfd3"), packageElfSha256: OTHER_SHA }).status).toBe("invalid");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: "commissioned",
      commissioningWindowOpen: false,
      onboardingStatus: "image_verified",
    }).show).toBe(false);
    const dns = commissioningFromLog([
      "Server Listening...",
      "commissioning mode 1",
      "CHIPoBLE advertising started",
      "Failed to advertise commissionable node: 3",
    ].join("\n"));
    expect(dns.bleAdvertisingObserved).toBe(true);
    expect(dns.dnsSdWarning).toMatch(/error 3/);
    expect(dns.windowNow).toBe("unknown");
    expect(onboardingDecision({
      ...verifiedIdentity,
      commissioningState: dns.state,
      commissioningWindowOpen: dns.windowOpen,
      windowNow: dns.windowNow,
      onboardingStatus: "image_verified",
    }).show).toBe(true);
  });

  it("encodes the compiled test payload per product and refuses an unverified RGB boot", () => {
    const dht = compiledTestOnboarding(0xfff1, 0x8000);
    expect(dht?.qrPayload).toBe(DEVELOPMENT_ONBOARDING.qrPayload);
    expect(dht?.manualCode).toBe(DEVELOPMENT_ONBOARDING.manualCode);
    const rgb = compiledTestOnboarding(0xfff1, 0x8002);
    expect(rgb).not.toBeNull();
    expect(rgb?.qrPayload).not.toBe(dht?.qrPayload);
    const decoded = decodeMatterPayload(rgb?.qrPayload ?? "", rgb?.manualCode ?? "");
    expect(decoded).toMatchObject({ version: 0, vendorId: 0xfff1, productId: 0x8002, discriminator: 0xf00, passcode: 20202021, manualCodeMatches: true });
    expect(compiledTestOnboarding(0x1349, 0x8002)).toBeNull();
    const staticPayload = verifyOnboarding({
      softwareVersion: 7,
      softwareVersionString: "1.6.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      advertisedDiscriminator: null,
      discriminatorRedacted: false,
      advertisedVendorId: null,
      advertisedProductId: null,
      usesCompiledTestDiscriminator: true,
      imageSha256Prefix: "6ec05f3d",
      packageElfSha256: "6ec05f3d1d10f0b232f356b5bfb316901f3b8b2811b405d1bf33ffddb25cb632",
    });
    expect(staticPayload.status).toBe("image_verified");
    const ready = {
      writeCompleted: true,
      bootVerified: true,
      matterReady: true,
      threadReady: true,
      versionVerified: true,
      softwareVersion: 7,
      softwareVersionString: "1.6.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      commissioningState: "uncommissioned" as const,
      commissioningWindowOpen: null,
      onboardingStatus: "image_verified" as const,
      windowNow: "unknown" as const,
      nvsPreserved: false,
    };
    const shown = onboardingDecision(ready);
    expect(shown.show).toBe(true);
    expect(shown.payload).toBe(rgb?.qrPayload);
    expect(shown.windowWarning).toMatch(/not verified as open/);
    expect(onboardingDecision({ ...ready, nvsPreserved: true }).show).toBe(false);
    expect(onboardingDecision({ ...ready, matterReady: false, matterStartup: "failed" }).show).toBe(false);
    expect(onboardingDecision({ ...ready, matterReady: false, matterStartup: "unknown" }).show).toBe(false);
    expect(onboardingDecision({ ...ready, commissioningState: "commissioned", commissioningWindowOpen: false }).show).toBe(false);
    expect(onboardingDecision({ ...ready, onboardingStatus: "not_verified" }).show).toBe(false);
    expect(onboardingDecision({ ...ready, productId: 0x8000, softwareVersion: 6, softwareVersionString: "1.5.0", onboardingStatus: "verified" }).show).toBe(true);
    expect(onboardingDecision({ ...ready, productId: 0x8000, softwareVersion: 6, softwareVersionString: "1.5.0", onboardingStatus: "verified", nvsPreserved: true }).reason).toMatch(/shared development setup code/);
    const mismatched = verifyOnboarding({
      ...ready,
      advertisedDiscriminator: 1,
      discriminatorRedacted: false,
      advertisedVendorId: 0xfff1,
      advertisedProductId: 0x8000,
      usesCompiledTestDiscriminator: true,
    });
    expect(mismatched.status).toBe("invalid");
    expect(verifyOnboarding({
      softwareVersion: 7,
      softwareVersionString: "1.6.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      advertisedDiscriminator: null,
      discriminatorRedacted: false,
      advertisedVendorId: null,
      advertisedProductId: null,
      usesCompiledTestDiscriminator: false,
    }).status).toBe("not_verified");
  });

  it("shows a device-printed onboarding code and hides the compiled fallback while NVS is preserved", () => {
    const compiled = compiledTestOnboarding(0xfff1, 0x8002);
    expect(compiled).not.toBeNull();
    const printed = readDeviceOnboarding(`SetupQRCode: [${compiled?.qrPayload}]\nManual pairing code: [${compiled?.manualCode}]`);
    expect(printed.qrPayload).toBe(compiled?.qrPayload);
    expect(printed.manualCode).toBe(compiled?.manualCode);
    const ready = {
      writeCompleted: true,
      bootVerified: true,
      matterReady: true,
      matterStartup: "started" as const,
      threadReady: true,
      versionVerified: true,
      softwareVersion: 10,
      softwareVersionString: "1.9.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      commissioningState: "uncommissioned" as const,
      commissioningWindowOpen: true,
      windowNow: "open" as const,
      onboardingStatus: "image_verified" as const,
      nvsPreserved: true,
    };
    const shown = onboardingDecision({ ...ready, deviceOnboarding: { qrPayload: printed.qrPayload ?? "", manualCode: printed.manualCode ?? "" } });
    expect(shown.show).toBe(true);
    expect(shown.payload).toBe(compiled?.qrPayload);
    expect(onboardingDecision({ ...ready, commissioningState: "commissioned" }).show).toBe(false);
    expect(onboardingDecision({ ...ready, commissioningState: "unknown", deviceOnboarding: null }).show).toBe(false);
    expect(onboardingDecision({ ...ready, matterReady: false, matterStartup: "unknown", deviceOnboarding: null }).reason).toMatch(/capture ended/);
    const encoded = `https://project-chip.github.io/connectedhomeip/qrcode.html?data=${encodeURIComponent(compiled?.qrPayload ?? "")}`;
    const fromUrl = readDeviceOnboarding(`SetupQRCode: [[redacted]]\n${encoded}\nManual pairing code: [redacted]\ndiscriminator=3840/15\nMatter server is up. Fabric count 0.`);
    expect(fromUrl.qrPayload).toBe(compiled?.qrPayload);
    expect(fromUrl.manualCode).toBe(compiled?.manualCode);
    const recovered = onboardingDecision({ ...ready, nvsPreserved: true, commissioningState: "uncommissioned", deviceOnboarding: { qrPayload: fromUrl.qrPayload ?? "", manualCode: fromUrl.manualCode ?? "" } });
    expect(recovered.show).toBe(true);
    expect(recovered.reason).toMatch(/compiled development payload/);
    expect(onboardingDecision({ ...ready, deviceOnboarding: { qrPayload: "MT:NOT-A-CODE", manualCode: "00000000000" } }).show).toBe(false);
    const withoutFirmware = onboardingDecision({
      ...ready,
      writeCompleted: false,
      bootVerified: false,
      matterReady: false,
      versionVerified: false,
      deviceOnboarding: { qrPayload: printed.qrPayload ?? "", manualCode: printed.manualCode ?? "" },
    });
    expect(withoutFirmware.show).toBe(true);
    expect(withoutFirmware.payload).toBe(compiled?.qrPayload);
    expect(withoutFirmware.reason).toMatch(/does not depend on a firmware build record/);
    const commissioned = onboardingDecision({
      ...ready,
      commissioningState: "commissioned",
      commissioningWindowOpen: false,
      windowNow: "closed",
      deviceOnboarding: { qrPayload: printed.qrPayload ?? "", manualCode: printed.manualCode ?? "" },
    });
    expect(commissioned.show).toBe(true);
    expect(commissioned.windowWarning).toMatch(/Original setup code/);
    expect(commissioned.windowWarning).toMatch(/does not open a commissioning window/);
    const commissionedWithoutFirmware = onboardingDecision({
      ...ready,
      writeCompleted: false,
      bootVerified: false,
      versionVerified: false,
      commissioningState: "commissioned",
      deviceOnboarding: null,
    });
    expect(commissionedWithoutFirmware.show).toBe(false);
    expect(commissionedWithoutFirmware.reason).toMatch(/already has a Matter fabric/);
    expect(commissionedWithoutFirmware.reason).not.toMatch(/firmware/);
  });

  it("keeps a stored installation MAC distinct from a live chip-id reading", () => {
    const stored = installationIdentity({
      log: "Chip is ESP32-H2 (revision v1.2)\nCalling app_main()",
      storedMac: "10:51:db:68:64:4c",
      recordedAt: "2026-10-25T00:18:00.581Z",
    });
    expect(stored.source).toBe("stored_session");
    expect(stored.mac).toBe("10:51:db:68:64:4c");
    expect(stored.detail).toMatch(/not a new chip-id measurement/);
    const chip = installationIdentity({
      log: "Chip is ESP32-H2 (revision v1.2)\nMAC: 10:51:db:68:64:4c",
      storedMac: null,
      recordedAt: null,
    });
    expect(chip.source).toBe("chip_id");
    expect(chip.mac).toBe("10:51:db:68:64:4c");
    const live = installationIdentity({
      log: "BASE MAC: 10:51:db:68:64:4c",
      storedMac: "10:51:db:68:64:4c",
      recordedAt: null,
    });
    expect(live.source).toBe("base_mac");
  });

  it("separates a successful RGB LED initialisation from the missing hue attribute", () => {
    const log = [
      "I (627) main_task: Calling app_main()",
      "I (647) rgb_led: RGB LED initialised on R=GPIO4 G=GPIO10 B=GPIO5",
      "I (657) rgb_led: Applied RGB: R=0 G=254 B=0 brightness=254 power=ON",
      "E (657) app_main: Failed to register the RGB light, err:261",
    ].join("\n");
    const stages = firmwareStartupStages({
      writeCompleted: true,
      checks: [
        { id: "write", status: "passed" },
        { id: "boot", status: "passed" },
        { id: "version", status: "passed" },
        { id: "matter", status: "failed" },
      ],
      monitorLog: log,
    });
    expect(stages.find((stage) => stage.id === "usb")?.status).toBe("passed");
    expect(stages.find((stage) => stage.id === "boot")?.status).toBe("passed");
    expect(stages.find((stage) => stage.id === "rgb")?.status).toBe("passed");
    expect(stages.find((stage) => stage.id === "attributes")?.status).toBe("failed");
    expect(stages.find((stage) => stage.id === "matter")?.status).toBe("not_reached");
    expect(stages.find((stage) => stage.id === "commissioning")?.status).toBe("not_reached");
    expect(firmwareStartupStages({ writeCompleted: true, monitorLog: "Calling app_main()\nDHT11 Temperature" }).find((stage) => stage.id === "rgb")?.status).toBe("not_applicable");
  });

  it("reads a numeric discriminator that is no longer removed from a saved advertisement", () => {
    const raw = "Advertise commission parameter vendorID=65521 productID=32768 discriminator=3840/15 cm=1";
    expect(readAdvertisedOnboarding(raw)).toMatchObject({ discriminator: 3840, vendorId: 65521, productId: 32768, redacted: false });
    expect(readAdvertisedOnboarding("discriminator: [redacted] vendorID=65521 productID=32768").redacted).toBe(true);
  });
});
