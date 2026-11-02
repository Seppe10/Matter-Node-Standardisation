import { readFileSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MatterOperationError } from "./errors.js";
import { controllerStorageDir } from "./identity.js";
import { mapCommissionError, openMatterTransport } from "./live.js";
import { redactSecrets } from "./redact.js";
import { MemoryNodeRepository } from "./index.js";
import { LiveMatterManagementService } from "./service.js";
import type { ManagementTransport, ObservedNode } from "./session.js";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

const observed: ObservedNode = {
  matterNodeId: "42",
  vendorId: 0xfff1,
  productId: 0x8000,
  hardwareVersion: 1,
  hardwareVersionString: "ESP32-H2",
  softwareVersion: 3,
  softwareVersionString: "1.2.0",
  serialNumber: null,
  commissionedFabricCount: 2,
  firmwareUpdateEligible: true,
  connection: "reachable",
  lastCommunicationAt: "2026-10-22T00:00:00.000Z",
};

class FakeTransport implements ManagementTransport {
  createCalls = 0;
  commissionCalls = 0;
  reconnectCalls = 0;
  refreshIds: string[] = [];
  refreshError: MatterOperationError | null = null;
  refreshSoftwareVersion: number | null = 4;
  refreshSoftwareVersionString: string | null = "1.3.0";
  serialNumber: string | null = null;
  lastCode = "";
  fail: "none" | "discovery" | "fabric" | "case" | "identity" = "none";
  refreshFail = false;
  storedPeers: Array<{ matterNodeId: string; commissionedAt: number | null }> = [];
  node: ObservedNode = { ...observed };

  async ensureStarted(options: { create: boolean }) {
    if (options.create) this.createCalls += 1;
    if (!options.create && this.createCalls === 0) {
      throw new MatterOperationError("identity_corrupt", "Stored credentials are missing and were not replaced.");
    }
    return { fabricId: "fabric-1", credentialId: "root-1", controllerNodeId: "7001", matterJsVersion: "0.18.0" };
  }

  async commissionOnExistingNetwork(
    pairingCode: string,
    onProgress?: (event: { stage: "validating_code" | "discovering" | "verifying_firmware" | "ready" | "failed"; message: string }) => void,
  ) {
    this.commissionCalls += 1;
    this.lastCode = pairingCode;
    onProgress?.({ stage: "discovering", message: "discover" });
    if (this.fail === "discovery") throw new MatterOperationError("discovery_failed", `device not found for ${pairingCode}`);
    if (this.fail === "fabric") throw new MatterOperationError("fabric_limit", "The fabric table is full.");
    if (this.fail === "case") throw new Error("CASE session failed");
    onProgress?.({ stage: "verifying_firmware", message: "verify" });
    if (this.fail === "identity") return { ...this.node, connection: "reachable" as const, softwareVersion: null, softwareVersionString: null };
    return this.node;
  }

  async listCommissionedPeers() {
    return this.storedPeers;
  }

  decommissionIds: string[] = [];
  forgetIds: string[] = [];

  async decommissionPeer(matterNodeId: string) {
    this.decommissionIds.push(matterNodeId);
    this.storedPeers = this.storedPeers.filter((peer) => peer.matterNodeId !== matterNodeId);
    return { removedOnDevice: true, detail: `IoT.Edu fabric for ${matterNodeId} was removed in the test double.` };
  }

  async forgetPeer(matterNodeId: string) {
    this.forgetIds.push(matterNodeId);
    this.storedPeers = this.storedPeers.filter((peer) => peer.matterNodeId !== matterNodeId);
  }

  async refresh(matterNodeId: string) {
    this.refreshIds.push(matterNodeId);
    if (this.refreshError) throw this.refreshError;
    if (this.refreshFail) throw new MatterOperationError("connection_failed", "timed out");
    return {
      ...this.node,
      matterNodeId,
      softwareVersion: this.refreshSoftwareVersion,
      softwareVersionString: this.refreshSoftwareVersionString,
      serialNumber: this.serialNumber,
    };
  }

  async reconnect() {
    this.reconnectCalls += 1;
    return [{ ...this.node, connection: "reachable" as const }];
  }

  async openSharingWindow() {
    return { manualPairingCode: "3497-011-2332", qrPairingCode: "MT:Y.ABCDEF", durationSeconds: 180 };
  }

  async close() {}
}

async function service() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-matter-"));
  const transport = new FakeTransport();
  const nodes = new MemoryNodeRepository();
  return { dataDir, transport, nodes, matter: new LiveMatterManagementService(nodes, dataDir, transport) };
}

describe("management controller", () => {
  it("keeps one controller identity across a restart and refuses to regenerate it", async () => {
    const { dataDir, transport, nodes, matter } = await service();
    const created = await matter.createIdentity();
    expect(created.identityLoaded).toBe(true);
    expect(created.fabricId).toBe("fabric-1");
    expect(created.credentialId).toBe("root-1");
    expect(created.persisted).toBe(true);
    expect(transport.createCalls).toBe(1);

    const directory = controllerStorageDir(dataDir);
    const directoryMode = (await stat(directory)).mode & 0o777;
    const identityPath = path.join(directory, "identity.json");
    const identityMode = (await stat(identityPath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(identityMode).toBe(0o600);
    const stored = await readFile(identityPath, "utf8");
    expect(stored).not.toMatch(/PRIVATE KEY|pairingCode|MT:/);

    const again = await matter.createIdentity();
    expect(again.fabricId).toBe(created.fabricId);
    expect(transport.createCalls).toBe(1);

    const restarted = new LiveMatterManagementService(nodes, dataDir, transport);
    await restarted.restore();
    expect(transport.reconnectCalls).toBe(0);
    const status = await restarted.getControllerStatus();
    expect(status.controllerNodeId).toBe("7001");
    expect(status.regenerationBlocked).toBe(true);
  });

  it("does not replace a corrupt identity or stray credential files", async () => {
    const { dataDir, transport, matter } = await service();
    const directory = controllerStorageDir(dataDir);
    await matter.createIdentity();
    await writeFile(path.join(directory, "identity.json"), "{", { mode: 0o600 });
    await expect(matter.createIdentity()).rejects.toMatchObject({ code: "identity_corrupt" });
    expect(await readFile(path.join(directory, "identity.json"), "utf8")).toBe("{");

    const blockedDir = await mkdtemp(path.join(tmpdir(), "iotedu-matter-"));
    const blocked = new LiveMatterManagementService(new MemoryNodeRepository(), blockedDir, transport);
    const storage = controllerStorageDir(blockedDir);
    await writeFile(path.join(await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(storage, { recursive: true, mode: 0o700 });
      return storage;
    }), "credentials"), "secret");
    const calls = transport.createCalls;
    await expect(blocked.createIdentity()).rejects.toMatchObject({ code: "regeneration_refused" });
    expect(transport.createCalls).toBe(calls);
  });

  it("validates commissioning codes and redacts them from failures", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    await expect(matter.commission({ path: "smart_home", name: "Bench", confirm: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(matter.commission({ path: "smart_home", name: "Bench", pairingCode: "not-a-code", confirm: true })).rejects.toMatchObject({ code: "invalid_input" });
    expect(transport.commissionCalls).toBe(0);

    transport.fail = "discovery";
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "3497-011-2332",
      confirm: true,
    })).rejects.toThrow(/\[redacted\]/);
    expect(await nodes.list()).toHaveLength(0);
    expect(redactSecrets("failed MT:Y.ABCDEF and 3497-011-2332")).not.toContain("MT:Y");
    expect(redactSecrets("failed MT:Y.ABCDEF and 3497-011-2332")).not.toContain("3497");
  });

  it("stores only administrative identity returned by the device", async () => {
    const { dataDir, matter, transport, nodes } = await service();
    await matter.createIdentity();
    const result = await matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    });
    expect(result.simulated).toBe(false);
    expect(result.matterSessionOpened).toBe(true);
    expect(result.node.matterNodeId).toBe("42");
    expect(result.node.vendorId).toBe(0xfff1);
    expect(result.node.productId).toBe(0x8000);
    expect(result.node.softwareVersionString).toBe("1.2.0");
    expect(result.node.hardwareVersion).toBe(1);
    expect(result.node.commissionedFabricCount).toBe(2);
    expect(result.node.otherFabricCount).toBe(1);
    expect(result.node.firmwareUpdateEligible).toBe(true);
    expect(result.node.connection).toBe("reachable");
    expect(result.node.managementFabricId).toBe("fabric-1");
    expect(JSON.stringify(result.node)).not.toContain("MT:");
    expect(JSON.stringify(result.node)).not.toContain("Apple");
    expect(transport.lastCode).toBe("MT:Y.ABCDEF");

    const refreshed = await matter.refreshNode(result.node.id);
    expect(refreshed.liveRead).toBe("read");
    expect(refreshed.node.softwareVersionString).toBe("1.3.0");
    const saved = await nodes.getById(result.node.id);
    expect(saved?.softwareVersion).toBe(4);

    transport.storedPeers = [
      { matterNodeId: "1", commissionedAt: 1 },
      { matterNodeId: "42", commissionedAt: 2 },
    ];
    const restarted = new LiveMatterManagementService(nodes, dataDir, transport);
    await restarted.restore();
    expect(transport.reconnectCalls).toBe(0);
    expect(transport.refreshIds).toEqual(["42", "42"]);
    expect(transport.refreshIds).not.toContain("1");
    expect((await nodes.list())[0]?.matterNodeId).toBe("42");
  });

  it("opens a sharing window without rewriting the management fabric or storing the code", async () => {
    const { matter, nodes } = await service();
    await matter.createIdentity();
    const result = await matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    });
    const before = JSON.stringify(await nodes.getById(result.node.id));
    const window = await matter.openCommissioningWindow(result.node.id);
    expect(window.opened).toBe(true);
    expect(window.durationSeconds).toBe(180);
    expect(window.openedAt).toBeTruthy();
    expect(window.manualPairingCode).toBe("3497-011-2332");
    const after = await nodes.getById(result.node.id);
    expect(after?.managementFabricId).toBe("fabric-1");
    expect(after?.matterNodeId).toBe("42");
    expect(JSON.stringify(after)).toBe(before);
    expect(before).not.toContain("3497-011-2332");
  });

  it("keeps the last firmware read when a fresh read fails", async () => {
    const { matter, transport } = await service();
    await matter.createIdentity();
    const result = await matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    });
    const ok = await matter.refreshNode(result.node.id);
    expect(ok.liveRead).toBe("read");
    expect(ok.node.presence).toBe("online");
    expect(ok.node.softwareVersion).toBe(4);
    transport.refreshFail = true;
    const failed = await matter.refreshNode(result.node.id);
    expect(failed.liveRead).toBe("failed");
    expect(failed.node.presence).toBe("unreachable");
    expect(failed.node.reachable).toBe(false);
    expect(failed.node.softwareVersion).toBe(4);
    expect(failed.node.softwareVersionString).toBe("1.3.0");
    expect(failed.node.matterNodeId).toBe("42");
    expect(failed.node.lastSuccessfulCommunicationAt).toBeTruthy();
    expect(failed.node.lastFailedCommunicationAt).toBeTruthy();
    const plan = await matter.reconciliationPlan();
    expect(plan.executed).toBe(false);
    expect(plan.credentialStoreEdited).toBe(false);
    expect(plan.blocker).toBeNull();
  });

  it("refuses device decommission when a fresh read fails and forgets only the local record", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    const result = await matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    });
    transport.refreshFail = true;
    await expect(matter.removeNode(result.node.id, { mode: "decommission", confirm: true, phrase: "Bench" })).rejects.toThrow(/RemoveFabric was not sent/);
    expect(transport.decommissionIds).toEqual([]);
    expect(await nodes.getById(result.node.id)).not.toBeNull();

    await matter.removeNode(result.node.id, { mode: "forget", confirm: true, phrase: "Bench" });
    expect(transport.decommissionIds).toEqual([]);
    expect(transport.forgetIds).toEqual(["42"]);
    expect(await nodes.getById(result.node.id)).toBeNull();
    expect(await matter.getControllerStatus()).toMatchObject({ identityLoaded: true, persisted: true });
  });

  it("removes only the IoT.Edu peer after a fresh read confirms the node", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    const result = await matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    });
    await expect(matter.removeNode(result.node.id, { mode: "decommission", confirm: true, phrase: "other" })).rejects.toThrow(/confirmation phrase/);
    const removed = await matter.removeNode(result.node.id, { mode: "decommission", confirm: true, phrase: "Bench" });
    expect(removed.physicalFabricRemoved).toBe(true);
    expect(transport.decommissionIds).toEqual(["42"]);
    expect(transport.forgetIds).toEqual([]);
    expect(await nodes.getById(result.node.id)).toBeNull();
  });

  it("reports discovery, fabric limit, missing Bluetooth, and missing Thread credentials without commissioning", async () => {
    const { matter, transport, nodes } = await service();
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "34970112332",
      confirm: true,
    })).rejects.toMatchObject({ code: "identity_missing" });
    expect(transport.commissionCalls).toBe(0);

    await matter.createIdentity();
    transport.fail = "fabric";
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "12345678901",
      confirm: true,
    })).rejects.toThrow(/did not factory reset/);
    expect(await nodes.list()).toHaveLength(0);

    transport.fail = "none";
    await expect(matter.commission({
      path: "new_device",
      name: "New board",
      confirm: true,
    })).rejects.toThrow(/Bluetooth commissioning is not part of the installed Matter\.js build/);
    await expect(matter.commission({
      path: "new_device",
      name: "New board",
      pairingCode: "3497-011-2332",
      confirm: true,
    })).rejects.toThrow(/no Thread operational dataset is available/);
    expect(transport.commissionCalls).toBe(1);
    const caps = await matter.getCapabilities();
    expect(caps.bleCommissioning).toBe("unsupported");
    expect(caps.threadDataset).toBe("needs_setup");
    expect(caps.notes.join(" ")).toMatch(/Sensor measurements and actuator commands are not requested/);
    expect(caps.notes.join(" ")).toMatch(/5 fabrics/);
  });

  it("refuses to open Matter.js when credential files are missing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-matter-"));
    await expect(openMatterTransport(dataDir, { create: false })).rejects.toMatchObject({ code: "identity_corrupt" });
  });

  it("reports commissioning progress and reconnects the same node after a new service", async () => {
    const { dataDir, matter, transport, nodes } = await service();
    await matter.createIdentity();
    const stages: string[] = [];
    const result = await matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "3497-011-2332",
      confirm: true,
    }, (event) => stages.push(event.stage));
    expect(stages).toEqual(["validating_code", "discovering", "verifying_firmware", "ready"]);
    expect(result.node.commissionedFabricCount).toBe(2);
    expect(result.node.otherFabricCount).toBe(1);
    expect(result.node.softwareVersion).toBe(3);
    expect(transport.createCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("3497");

    const restarted = new LiveMatterManagementService(nodes, dataDir, transport);
    await restarted.restore();
    const listed = await nodes.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.matterNodeId).toBe("42");
    expect(transport.reconnectCalls).toBe(0);
    expect(transport.refreshIds).toEqual(["42"]);
    expect(transport.createCalls).toBe(1);
  });

  it("does not store a node when CASE verification fails", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    transport.node = { ...observed, connection: "offline", softwareVersion: null, softwareVersionString: null };
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "34970112332",
      confirm: true,
    })).rejects.toThrow(/no node record was stored/);
    expect(await nodes.list()).toHaveLength(0);

    transport.fail = "case";
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    })).rejects.toThrow(/Apple Home fabric/);
    expect(await nodes.list()).toHaveLength(0);
  });

  it("keeps a successful CASE read separate from a missing SoftwareVersion", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    transport.fail = "identity";
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "34970112332",
      confirm: true,
    })).rejects.toMatchObject({ code: "identity_read_failed" });
    expect(await nodes.list()).toHaveLength(0);
  });

  it("recovers a stored IoT.Edu peer instead of adding another fabric", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    transport.storedPeers = [{ matterNodeId: "1", commissionedAt: 1 }, { matterNodeId: "2", commissionedAt: 2 }];
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "3497-011-2332",
      confirm: true,
    })).rejects.toMatchObject({ code: "existing_fabric" });
    expect(transport.commissionCalls).toBe(0);
    await expect(matter.recoverExisting("Bench H2")).rejects.toMatchObject({ code: "peer_selection_required" });
    expect(await nodes.list()).toHaveLength(0);

    transport.node = { ...observed, matterNodeId: "2", softwareVersion: 4, softwareVersionString: "1.3.0", commissionedFabricCount: 4 };
    const recovered = await matter.recoverExisting({ name: "Bench H2", confirm: true, matterNodeId: "2" });
    expect(recovered.node.matterNodeId).toBe("2");
    expect(recovered.node.softwareVersion).toBe(4);
    expect(recovered.node.otherFabricCount).toBe(3);
    expect(recovered.message).toMatch(/Apple Home fabric was not removed/);
    expect(transport.commissionCalls).toBe(0);
    expect(transport.createCalls).toBe(1);
    expect(await nodes.list()).toHaveLength(1);
    await expect(matter.commission({
      path: "smart_home",
      name: "Bench",
      pairingCode: "34970112332",
      confirm: true,
    })).rejects.toMatchObject({ code: "existing_fabric" });
    expect(transport.commissionCalls).toBe(0);
  });

  it("adds another device after confirmation and keeps the unresolved peer", async () => {
    const { dataDir, matter, transport, nodes } = await service();
    await matter.createIdentity();
    const identityPath = path.join(controllerStorageDir(dataDir), "identity.json");
    const before = await readFile(identityPath, "utf8");
    transport.storedPeers = [{ matterNodeId: "1", commissionedAt: 1 }];
    transport.node = { ...observed, matterNodeId: "8", softwareVersion: 4, softwareVersionString: "1.3.0", serialNumber: "4831B7CF375F" };
    await expect(matter.commission({
      path: "smart_home",
      name: "New H2",
      pairingCode: "3497-011-2332",
      confirm: true,
    })).rejects.toMatchObject({ code: "existing_fabric" });
    expect(transport.commissionCalls).toBe(0);
    const added = await matter.commission({
      path: "smart_home",
      name: "New H2",
      pairingCode: "3497-011-2332",
      confirm: true,
      preserveUnresolvedPeers: true,
      expectedHardwareMac: "48:31:b7:cf:37:5f",
    });
    expect(transport.commissionCalls).toBe(1);
    expect(transport.forgetIds).toEqual([]);
    expect(transport.decommissionIds).toEqual([]);
    expect(added.node.matterNodeId).toBe("8");
    expect(added.node.hardwareMac).toBe("48:31:B7:CF:37:5F");
    expect(added.limitation).toMatch(/unverified peer was kept/);
    expect((await transport.listCommissionedPeers()).map((peer) => peer.matterNodeId)).toEqual(["1"]);
    expect(await nodes.list()).toHaveLength(1);
    const again = await matter.commission({
      path: "smart_home",
      name: "New H2",
      pairingCode: "3497-011-2332",
      confirm: true,
      preserveUnresolvedPeers: true,
    });
    expect(again.node.id).toBe(added.node.id);
    expect(await nodes.list()).toHaveLength(1);
    expect(await readFile(identityPath, "utf8")).toBe(before);
  });

  it("maps an expired commissioning window to a recovery message", () => {
    const expired = mapCommissionError(new Error("PASE timeout"));
    expect(expired.code).toBe("commissioning_window_expired");
    expect(expired.message).toMatch(/turn pairing mode on again/);
    expect(expired.message).not.toMatch(/MT:|3497/);
    const failedCase = mapCommissionError(new Error("CASE session failed"));
    expect(failedCase.code).toBe("connection_failed");
    expect(failedCase.message).toMatch(/Open pairing mode again/);
  });

  it("pins Matter.js 0.18.0 and keeps management reads separate from sensor and actuator clusters", async () => {
    const declared = JSON.parse(readFileSync(path.join(sourceRoot, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    const installed = JSON.parse(readFileSync(path.resolve(sourceRoot, "../../../node_modules/@matter/main/package.json"), "utf8")) as { version: string };
    expect(declared.dependencies["@matter/main"]).toBe("0.18.0");
    expect(installed.version).toBe("0.18.0");
    const live = await readFile(path.join(sourceRoot, "live.ts"), "utf8");
    const pages = path.resolve(sourceRoot, "../../../apps/desktop-ui/src");
    expect(live).toContain("autoSubscribe: false");
    expect(live).toContain("ble: false");
    expect(live).not.toMatch(/TemperatureMeasurement|RelativeHumidityMeasurement|OnOff|LevelControl/);
    const ui = await readFile(path.join(pages, "pages/NodePage.tsx"), "utf8");
    expect(ui).not.toMatch(/TemperatureMeasurement|RelativeHumidityMeasurement|actuator control/);
  });

  it("retires one unsaved peer and leaves the saved management record in place", async () => {
    const { matter, transport, nodes } = await service();
    await matter.createIdentity();
    const commissioned = await matter.commission({
      path: "smart_home",
      name: "ESP32-H2",
      pairingCode: "MT:Y.ABCDEF",
      confirm: true,
    });
    expect(commissioned.node.matterNodeId).toBe("42");
    transport.storedPeers = [
      { matterNodeId: "1", commissionedAt: 1 },
      { matterNodeId: "42", commissionedAt: 2 },
    ];
    const retired = await matter.retireUnsavedPeer({ matterNodeId: "1", confirm: true, phrase: "1" });
    expect(retired.physicalFabricRemoved).toBe(false);
    expect(retired.savedRecordRemoved).toBe(false);
    expect(transport.forgetIds).toEqual(["1"]);
    expect(transport.decommissionIds).toEqual([]);
    expect(transport.storedPeers.map((peer) => peer.matterNodeId)).toEqual(["42"]);
    await expect(matter.retireUnsavedPeer({ matterNodeId: "42", confirm: true, phrase: "42" })).rejects.toThrow(/Forget Local Record Only/);
    expect(transport.forgetIds).toEqual(["1"]);
    expect((await nodes.list()).map((node) => node.matterNodeId)).toEqual(["42"]);
    await expect(matter.retireUnsavedPeer({ matterNodeId: "9", confirm: true, phrase: "8" })).rejects.toThrow(/confirmation/);
    expect(await nodes.list()).toHaveLength(1);
  });

  it("keeps the previous board separate and registers the matching peer once", async () => {
    const { dataDir, matter, transport, nodes } = await service();
    await matter.createIdentity();
    const identityPath = path.join(controllerStorageDir(dataDir), "identity.json");
    const before = await readFile(identityPath, "utf8");
    transport.storedPeers = [{ matterNodeId: "1", commissionedAt: 1 }];
    transport.node = { ...observed, vendorId: 0xfff1, productId: 0x8000, softwareVersion: 4, softwareVersionString: "1.3.0", commissionedFabricCount: 2 };
    transport.serialNumber = "4831B7CF3D52";
    const request = {
      name: "New H2",
      confirm: true as const,
      expectedHardwareMac: "48:31:b7:cf:37:5f",
      expectedVendorId: 0xfff1,
      expectedProductId: 0x8000,
      expectedSoftwareVersion: 4,
      expectedSoftwareVersionString: "1.3.0",
    };
    const separated = await matter.recoverExisting(request);
    expect(separated.node.matterNodeId).toBe("1");
    expect(separated.node.hardwareMac).toBe("48:31:B7:CF:3D:52");
    expect(separated.message).toMatch(/48:31:B7:CF:37:5F was not linked/);
    expect(await nodes.list()).toHaveLength(1);
    expect(transport.decommissionIds).toEqual([]);
    expect(transport.forgetIds).toEqual([]);
    const added = await matter.commission({
      path: "smart_home",
      name: "Selected H2",
      pairingCode: "3497-011-2332",
      confirm: true,
    });
    expect(transport.commissionCalls).toBe(1);
    expect(added.node.matterNodeId).toBe("42");
    expect((await nodes.list()).map((node) => node.hardwareMac)).toContain("48:31:B7:CF:3D:52");
    expect(await readFile(identityPath, "utf8")).toBe(before);
  });

  it("does not register an unproven or mismatched firmware peer", async () => {
    const { dataDir, matter, transport, nodes } = await service();
    await matter.createIdentity();
    const identityPath = path.join(controllerStorageDir(dataDir), "identity.json");
    const before = await readFile(identityPath, "utf8");
    transport.storedPeers = [{ matterNodeId: "1", commissionedAt: 1 }];
    transport.node = { ...observed, vendorId: 0xfff1, productId: 0x8000, softwareVersion: 4, softwareVersionString: "1.3.0", commissionedFabricCount: 2 };
    const request = {
      name: "New H2",
      confirm: true as const,
      expectedHardwareMac: "48:31:b7:cf:37:5f",
      expectedVendorId: 0xfff1,
      expectedProductId: 0x8000,
      expectedSoftwareVersion: 4,
      expectedSoftwareVersionString: "1.3.0",
    };
    transport.serialNumber = null;
    await expect(matter.recoverExisting(request)).rejects.toMatchObject({ code: "identity_unproven" });
    expect(await nodes.list()).toHaveLength(0);

    transport.refreshSoftwareVersion = 3;
    transport.refreshSoftwareVersionString = "1.2.0";
    await expect(matter.recoverExisting({ ...request, matterNodeId: "1" })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(await nodes.list()).toHaveLength(0);

    await expect(matter.recoverExisting({ ...request, matterNodeId: "9" })).rejects.toMatchObject({ code: "peer_selection_required" });
    transport.refreshError = new MatterOperationError("identity_read_failed", "Basic Information was aborted", 400, {
      stage: "read_basic_information",
      completed: ["discover_operational", "case_session"],
      matterNodeId: "1",
      endpointId: 0,
      clusterId: 0x28,
      attributeId: 0x9,
      errorClass: "aborted",
      status: null,
      elapsedMs: 40,
      attempts: 3,
    });
    await expect(matter.recoverExisting({ ...request, matterNodeId: "1" })).rejects.toMatchObject({
      code: "identity_read_failed",
      detail: { stage: "read_basic_information", completed: ["locate_peer", "discover_operational", "case_session"] },
    });
    expect(await nodes.list()).toHaveLength(0);
    transport.refreshError = null;
    transport.refreshSoftwareVersion = 4;
    transport.refreshSoftwareVersionString = "1.3.0";
    transport.serialNumber = "4831B7CF375F";
    const stages: string[] = [];
    const saved = await matter.recoverExisting({ ...request, matterNodeId: "1" }, (event) => stages.push(event.stage));
    expect(saved.node.matterNodeId).toBe("1");
    expect(saved.node.softwareVersion).toBe(4);
    expect(saved.node.hardwareMac).toBe("48:31:B7:CF:37:5F");
    expect(stages).toEqual([
      "locate_peer",
      "discover_operational",
      "case_session",
      "read_basic_information",
      "verify_identity",
      "management_ready",
      "register_node",
      "ready",
    ]);
    const again = await matter.recoverExisting({ ...request, matterNodeId: "1" });
    expect(again.node.id).toBe(saved.node.id);
    expect(await nodes.list()).toHaveLength(1);
    expect(transport.decommissionIds).toEqual([]);
    expect(transport.forgetIds).toEqual([]);
    expect(await readFile(identityPath, "utf8")).toBe(before);
  });
});
