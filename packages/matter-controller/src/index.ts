import { randomUUID } from "node:crypto";
import {
  APP_VERSION,
  FABRIC_LABEL,
  type CapabilityReport,
  type CommissionRequest,
  type ControllerStatus,
  type ManagedNode,
  type MatterManagementService,
  type NodeRepository,
} from "@iotedu/contracts";
import { BACKUP_INSTRUCTIONS } from "./errors.js";

export { MatterOperationError } from "./errors.js";
export { projectPresence } from "./presence.js";
export { LiveMatterManagementService, normalizePairingCode } from "./service.js";
export { redactSecrets } from "./redact.js";

/**
 * Phase 1 stand-in. It records a local node and never opens a Matter session,
 * loads a fabric key, or invents a Matter node id.
 */
export class MockMatterManagementService implements MatterManagementService {
  constructor(private readonly nodes: NodeRepository) {}

  async getCapabilities(): Promise<CapabilityReport> {
    return {
      applicationVersion: APP_VERSION,
      matterCommissioning: "mock_only",
      bleCommissioning: "unsupported",
      threadDataset: "needs_setup",
      firmwareBuild: "mock_only",
      otaProvider: "unsupported",
      usbFlash: "needs_setup",
      ai: "needs_setup",
      notes: [
        "No matter.js controller is running. Commissioning records are simulated local notes.",
        "Bluetooth commissioning is not implemented on this host.",
        "No Thread operational dataset is stored.",
        "USB flashing instructions are documented; no board flash has been run from this app.",
        "AI drafting is disabled until a provider is configured. The key, if any, stays on the server.",
        "A missing controller credential file will not be replaced with a new identity.",
      ],
    };
  }

  async getControllerStatus(): Promise<ControllerStatus> {
    return {
      identityLoaded: false,
      persisted: false,
      fabricLabel: FABRIC_LABEL,
      fabricId: null,
      credentialId: null,
      controllerNodeId: null,
      matterJsVersion: null,
      regenerationBlocked: true,
      message: "Controller storage has not been created. IoT.Edu will not generate a replacement identity in this release.",
      backup: BACKUP_INSTRUCTIONS,
    };
  }

  async createIdentity(): Promise<ControllerStatus> {
    return {
      ...(await this.getControllerStatus()),
      message: "Mock mode does not create Matter credentials. Live mode creates the management identity only when you ask.",
    };
  }

  async restore(): Promise<void> {}

  async close(): Promise<void> {}

  async commission(input: CommissionRequest) {
    if (input.acknowledgeSimulation !== true) {
      throw new Error("Mock commissioning requires acknowledgement that the record is simulated.");
    }
    const now = new Date().toISOString();
    const limitation =
      input.path === "new_device"
        ? "Bluetooth commissioning and a Thread operational dataset are not available. Use the smart-home sharing path when a real controller is added. This record is simulated."
        : "The smart-home commissioning window was not contacted. This record is a local placeholder only.";
    const node: ManagedNode = {
      id: randomUUID(),
      name: input.name,
      simulated: true,
      matterNodeId: null,
      vendorId: null,
      productId: null,
      softwareVersion: null,
      softwareVersionString: null,
      hardware: "ESP32-H2 (declared, not read)",
      reachable: null,
      fabricLabel: FABRIC_LABEL,
      commissionedFabricCount: null,
      otherFabricCount: null,
      partitionLayoutId: null,
      installedComponents: [],
      history: [
        {
          at: now,
          kind: "simulated_commission",
          detail: limitation,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.nodes.save(node);
    return {
      simulated: true as const,
      matterSessionOpened: false as const,
      node,
      message: "No Matter commissioning was performed.",
      limitation,
    };
  }

  async listUnsavedPeers() {
    return [];
  }

  async recoverExisting(): Promise<never> {
    throw new Error("Mock mode has no Matter fabric to recover.");
  }

  async reconciliationPlan() {
    return {
      controllerIdentityPreserved: true,
      identityReady: false,
      executed: false as const,
      credentialStoreEdited: false as const,
      peers: [],
      retireAfterFactoryReset: "Mock mode has no Matter peers. ClientNode.delete() was not called.",
      notUsed: ["ClientNode.decommission()", "Peers.erase()"],
      blocker: "Mock mode has no persistent controller peers. The physical factory-reset test is not started from mock mode.",
    };
  }

  async retireUnsavedPeer(input: import("@iotedu/contracts").RetirePeerRequest): Promise<import("@iotedu/contracts").RetirePeerResult> {
    void input;
    throw new Error("Mock mode has no persistent controller peers. Nothing was removed.");
  }

  async removeNode(nodeId: string, input: import("@iotedu/contracts").RemoveNodeRequest) {
    const node = await this.nodes.getById(nodeId);
    if (!node) throw new Error("Node not found");
    if (input.phrase !== node.name) throw new Error("The confirmation phrase does not match the node name. Nothing was removed.");
    if (input.mode === "decommission") {
      throw new Error("Mock mode cannot remove a fabric from a device. Nothing was removed.");
    }
    await this.nodes.delete(node.id);
    return {
      mode: "forget" as const,
      physicalFabricRemoved: false,
      localRecordRemoved: true,
      message: "The local record was removed. Mock mode did not contact a device.",
    };
  }

  async refreshNode(nodeId: string) {
    const node = await this.nodes.getById(nodeId);
    if (!node) throw new Error("Node not found");
    return {
      node,
      liveRead: "unavailable" as const,
      message: "Basic Information was not read. The Matter controller is not running, so stored fields were left unchanged.",
    };
  }

  async openCommissioningWindow(_nodeId: string) {
    return {
      opened: false,
      message:
        "AdministratorCommissioning was not invoked. A commissioning window can be opened only after a real management session exists.",
    };
  }

  async readInstalledSoftwareVersion(_matterNodeId: string): Promise<number | null> {
    return null;
  }
}

export class MemoryNodeRepository implements NodeRepository {
  private readonly nodes = new Map<string, ManagedNode>();

  async list() {
    return [...this.nodes.values()];
  }

  async getById(id: string) {
    return this.nodes.get(id) ?? null;
  }

  async save(node: ManagedNode) {
    this.nodes.set(node.id, node);
  }

  async delete(id: string) {
    this.nodes.delete(id);
  }
}
