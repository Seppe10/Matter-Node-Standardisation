import type { HardwareInstallation, ManagedNode } from "@iotedu/contracts";
import { compiledTestOnboarding } from "@iotedu/contracts";
import { describe, expect, it } from "vitest";
import { decisionForChoice, smartHomeChoices } from "./smart-home-devices";

function node(overrides: Partial<ManagedNode> = {}): ManagedNode {
  return {
    id: "node-rgb",
    name: "RGB node",
    simulated: false,
    matterNodeId: "42",
    hardwareMac: "10:51:db:68:64:4c",
    commissionedFabricCount: 3,
    productId: 0x8002,
    ...overrides,
  } as ManagedNode;
}

function installation(overrides: Partial<HardwareInstallation> = {}): HardwareInstallation {
  const compiled = compiledTestOnboarding(0xfff1, 0x8002);
  return {
    mac: "10:51:db:68:64:4c",
    updatedAt: "2026-10-01T00:00:00.000Z",
    commissioningState: "uncommissioned",
    windowNow: "unknown",
    vendorId: 0xfff1,
    productId: 0x8002,
    writeCompleted: false,
    bootVerified: false,
    versionVerified: false,
    deviceOnboarding: { qrPayload: compiled?.qrPayload ?? "", manualCode: compiled?.manualCode ?? "" },
    ...overrides,
  } as HardwareInstallation;
}

describe("smart home device matching", () => {
  it("shows a stored payload for the matching device and keeps a commissioned fabric visible", () => {
    const choices = smartHomeChoices([installation()], [node()]);
    expect(choices).toHaveLength(1);
    const decision = decisionForChoice(choices[0]!, false);
    expect(decision.show).toBe(true);
    expect(decision.reason).toMatch(/Original setup code/);
    expect(choices[0]?.installation?.commissioningState).toBe("commissioned");
    expect(choices[0]?.installation?.managedNodeId).toBe("node-rgb");
  });

  it("does not give one device another device's payload", () => {
    const sensor = installation({
      mac: "48:31:b7:cf:37:b7",
      productId: 0x8000,
      vendorId: 0xfff1,
      commissioningState: "commissioned",
      windowNow: "closed",
      writeCompleted: true,
      bootVerified: true,
      versionVerified: true,
      deviceOnboarding: null,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const choices = smartHomeChoices(
      [sensor, installation()],
      [node(), node({ id: "node-sensor", name: "Sensor", hardwareMac: "48:31:b7:cf:37:5f", productId: 0x8000, matterNodeId: null, commissionedFabricCount: null })],
    );
    const selected = choices.find((item) => item.mac === "48:31:b7:cf:37:b7");
    const stored = choices.find((item) => item.mac === "10:51:db:68:64:4c");
    const unrelated = choices.find((item) => item.mac === "48:31:b7:cf:37:5f");
    expect(decisionForChoice(selected!, false).show).toBe(false);
    expect(decisionForChoice(selected!, false).reason).toMatch(/already has a Matter fabric/);
    expect(decisionForChoice(stored!, false).show).toBe(true);
    expect(decisionForChoice(unrelated!, false).show).toBe(false);
    expect(decisionForChoice(unrelated!, false).reason).toMatch(/No stored Matter onboarding payload/);
    expect(selected?.installation?.deviceOnboarding).toBeNull();
  });

  it("keeps a managed node that has no hardware MAC out of the device list", () => {
    const choices = smartHomeChoices([], [node({ hardwareMac: null })]);
    expect(choices).toEqual([]);
    expect(decisionForChoice(null, true).reason).toBe("Select or Identify Device");
  });
});
