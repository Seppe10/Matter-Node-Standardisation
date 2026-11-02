import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import {
  APP_VERSION,
  FABRIC_LABEL,
  type CapabilityReport,
  type CommissionProgress,
  type CommissionRequest,
  type CommissioningWindowResult,
  type ControllerStatus,
  type ManagedNode,
  managedNodeAfterResetDecision,
  type MatterManagementService,
  type NodeRepository,
  type RecoverExistingRequest,
  type ControllerReconciliationPlan,
  type RefreshResult,
  type RemoveNodeRequest,
  type RemoveNodeResult,
} from "@iotedu/contracts";
import { BACKUP_INSTRUCTIONS, FABRIC_LIMIT, MatterOperationError, type IdentityDiagnostic, type IdentityStage } from "./errors.js";
import { compareFirmwareIdentity, formatMac, linkHardware, serialHardwareMac } from "./identity-read.js";
import { assertCreateAllowed, controllerStorageDir, inspectIdentity, writeIdentity, type StoredIdentity } from "./identity.js";
import { redactSecrets } from "./redact.js";
import type { ManagementTransport, ObservedNode } from "./session.js";

const NEW_DEVICE_LIMITATION =
  "A new ESP32-H2 cannot be commissioned from this host. Bluetooth commissioning is not part of the installed Matter.js build, and no Thread operational dataset is available. IoT.Edu did not invent a dataset, did not create a second Thread network, and did not record the node as commissioned. Flash the initial firmware over USB first, then commission the node from the existing smart-home controller and add IoT.Edu with a pairing code.";

/**
 * Persistent management fabric. The transport is Matter.js in the live process and a fake in tests.
 * Mock mode never reaches this class.
 */
export class LiveMatterManagementService implements MatterManagementService {
  private startupError: string | null = null;
  private transportPromise: Promise<ManagementTransport> | null = null;
  private restoreTask: Promise<void> | null = null;
  private restoreState: "pending" | "starting" | "ready" | "failed" = "pending";
  private stopRefresh = false;

  constructor(
    private readonly nodes: NodeRepository,
    private readonly dataDir: string,
    private readonly injected?: ManagementTransport,
  ) {}

  async getCapabilities(): Promise<CapabilityReport> {
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    const ready = inspection.state === "ready" && this.restoreState !== "starting" && !this.startupError;
    return {
      applicationVersion: APP_VERSION,
      matterCommissioning: ready ? "available" : "needs_setup",
      bleCommissioning: "unsupported",
      threadDataset: "needs_setup",
      firmwareBuild: "mock_only",
      otaProvider: "unsupported",
      usbFlash: "needs_setup",
      ai: "needs_setup",
      notes: [
        `Matter.js ${inspection.state === "ready" ? inspection.identity.matterJsVersion : "0.18.0"} is the management controller. The fabric label is ${FABRIC_LABEL}. It is not a second Thread network.`,
        "Smart-home-first commissioning adds this controller to a device that is already on the existing Thread network. Use the pairing code from that controller.",
        NEW_DEVICE_LIMITATION,
        "Controller keys stay in the data directory and are not written to Git. A stored identity is not replaced when it fails to load.",
        BACKUP_INSTRUCTIONS,
        "Administrative reads use Basic Information, Descriptor, and Operational Credentials. Sensor measurements and actuator commands are not requested.",
        `The firmware accepts at most ${FABRIC_LIMIT} fabrics. A fabric-table rejection does not factory reset the node.`,
        "Hardware verification of commissioning has not been recorded.",
      ],
    };
  }

  async getControllerStatus(): Promise<ControllerStatus> {
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    if (inspection.state === "ready") {
      return {
        identityLoaded: this.restoreState !== "starting" && this.startupError == null,
        persisted: true,
        fabricLabel: inspection.identity.fabricLabel,
        fabricId: inspection.identity.fabricId,
        credentialId: inspection.identity.credentialId,
        controllerNodeId: inspection.identity.controllerNodeId,
        matterJsVersion: inspection.identity.matterJsVersion,
        regenerationBlocked: true,
        message: this.restoreState === "starting"
          ? "The management controller is opening its stored identity. The API remains available. IoT.Edu will not generate a replacement identity."
          : this.startupError
            ?? "The management identity is stored and will be reused. IoT.Edu will not generate a replacement.",
        backup: BACKUP_INSTRUCTIONS,
      };
    }
    if (inspection.state === "corrupt" || inspection.state === "blocked") {
      return {
        identityLoaded: false,
        persisted: true,
        fabricLabel: FABRIC_LABEL,
        fabricId: null,
        credentialId: null,
        controllerNodeId: null,
        matterJsVersion: null,
        regenerationBlocked: true,
        message: inspection.message,
        backup: BACKUP_INSTRUCTIONS,
      };
    }
    return {
      identityLoaded: false,
      persisted: false,
      fabricLabel: FABRIC_LABEL,
      fabricId: null,
      credentialId: null,
      controllerNodeId: null,
      matterJsVersion: null,
      regenerationBlocked: true,
      message: "No management identity is stored. Create one explicitly. Commissioning will not generate one.",
      backup: BACKUP_INSTRUCTIONS,
    };
  }

  async createIdentity(): Promise<ControllerStatus> {
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    if (inspection.state === "ready") return this.getControllerStatus();
    assertCreateAllowed(inspection);
    await mkdir(inspection.directory, { recursive: true, mode: 0o700 });
    await chmod(inspection.directory, 0o700);
    const transport = await this.transport({ create: true });
    const info = await transport.ensureStarted({ create: true });
    const identity: StoredIdentity = {
      version: 1,
      createdAt: new Date().toISOString(),
      fabricLabel: FABRIC_LABEL,
      matterJsVersion: info.matterJsVersion,
      fabricId: info.fabricId,
      credentialId: info.credentialId,
      controllerNodeId: info.controllerNodeId,
    };
    await writeIdentity(inspection.directory, identity);
    this.startupError = null;
    return this.getControllerStatus();
  }

  async restore(): Promise<void> {
    this.restoreTask ??= this.restoreStored();
    return this.restoreTask;
  }

  private async restoreStored(): Promise<void> {
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    if (inspection.state !== "ready") {
      this.restoreState = "ready";
      return;
    }
    this.restoreState = "starting";
    try {
      const transport = await this.transport({ create: false });
      this.restoreState = "ready";
      console.log(JSON.stringify({ source: "iotedu-api", event: "matter-controller", state: "ready" }));
      const saved = (await this.nodes.list()).filter((node) => node.matterNodeId && !node.simulated);
      const observations: ObservedNode[] = [];
      for (const node of saved) {
        if (this.stopRefresh) break;
        const matterNodeId = node.matterNodeId;
        if (!matterNodeId) continue;
        try {
          observations.push(await transport.refresh(matterNodeId));
        } catch {
          observations.push(offlineObservation(matterNodeId));
        }
      }
      if (!this.stopRefresh) await this.applyObservations(observations);
    } catch (error) {
      this.restoreState = "failed";
      this.startupError = error instanceof Error ? redactSecrets(error.message) : "The stored controller identity could not be opened.";
    }
  }

  async close(): Promise<void> {
    this.stopRefresh = true;
    if (this.restoreTask) await this.restoreTask.catch(() => undefined);
    if (!this.transportPromise) return;
    try {
      const transport = await this.transportPromise;
      await transport.close();
    } catch {
      return;
    }
    this.transportPromise = null;
  }

  async readApplicationModel(matterNodeId: string) {
    if (!this.transportPromise) return null;
    const transport = await this.transportPromise;
    if (!transport.readApplicationModel) return null;
    return transport.readApplicationModel(matterNodeId);
  }

  async readInstalledSoftwareVersion(matterNodeId: string) {
    const node = (await this.nodes.list()).find((item) => item.matterNodeId === matterNodeId);
    if (!node) return null;
    const result = await this.refreshNode(node.id);
    if (result.liveRead !== "read") return null;
    return result.node.softwareVersion;
  }

  async commission(input: CommissionRequest, onProgress?: (event: CommissionProgress) => void) {
    if (input.path === "new_device") {
      throw new MatterOperationError("new_device_unavailable", NEW_DEVICE_LIMITATION);
    }
    onProgress?.({
      stage: "validating_code",
      message: "Checking the Apple Home pairing code format. The code is not written to the log.",
    });
    const pairingCode = normalizePairingCode(input.pairingCode);
    if (!pairingCode) {
      throw new MatterOperationError("invalid_input", "A commissioning code from the existing smart-home controller is required.");
    }
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    if (inspection.state !== "ready") {
      throw new MatterOperationError("identity_missing", "Create the management controller identity before commissioning. A missing identity is not generated automatically.");
    }
    if (this.startupError) {
      throw new MatterOperationError("identity_corrupt", this.startupError);
    }
    const transport = await this.transport({ create: false });
    const unsaved = await this.unsavedPeers(transport);
    if (unsaved.length > 0 && input.preserveUnresolvedPeers !== true) {
      throw new MatterOperationError(
        "existing_fabric",
        "An unverified Matter peer is still stored. Confirm that this Apple Home code is for a different device before continuing. The stored peer was not deleted, and a timeout does not show that it belongs to another board. The Apple Home fabric was not removed.",
      );
    }
    let observed: ObservedNode;
    try {
      observed = await transport.commissionOnExistingNetwork(pairingCode, onProgress);
    } catch (error) {
      if (error instanceof MatterOperationError && error.code === "fabric_limit") {
        throw new MatterOperationError(
          "fabric_limit",
          `The device cannot accept another fabric (the firmware allows ${FABRIC_LIMIT}). IoT.Edu did not factory reset it and did not remove the Apple Home fabric. An existing smart-home administrator can remove a different fabric or open a new commissioning window.`,
        );
      }
      if (error instanceof MatterOperationError) throw new MatterOperationError(error.code, redactSecrets(error.message), error.statusCode);
      throw new MatterOperationError(
        "connection_failed",
        redactSecrets(`${error instanceof Error ? error.message : "Commissioning failed."} Open pairing mode again if the window closed. IoT.Edu did not remove the Apple Home fabric or factory-reset the accessory.`),
      );
    }
    if (observed.connection !== "reachable") {
      throw new MatterOperationError(
        "connection_failed",
        "The operational CASE session was not established, so Basic Information was not read and no node record was stored. The Apple Home fabric was not removed.",
      );
    }
    if (observed.softwareVersion == null) {
      throw new MatterOperationError(
        "identity_read_failed",
        "The operational CASE session was established, but Basic Information did not include SoftwareVersion. No node record was stored. The Apple Home fabric was not removed.",
      );
    }
    const node = await this.saveCommissionedNode(input.name, observed, inspection.identity.fabricId);
    const link = linkHardware(observed.serialNumber, input.expectedHardwareMac);
    const limitation = link.result === "mismatched"
      ? `This record belongs to hardware MAC ${formatMac(link.reportedMac)}. It does not represent ${formatMac(link.expectedMac)}. No stored peer was deleted.`
      : input.preserveUnresolvedPeers === true
        ? "The unverified peer was kept. No stored peer was deleted."
        : null;
    onProgress?.({
      stage: "ready",
      message: `Basic Information was read. SoftwareVersion ${observed.softwareVersion}${observed.softwareVersionString ? ` (${observed.softwareVersionString})` : ""}. The node record was stored after that read.`,
    });
    return {
      simulated: false as const,
      matterSessionOpened: true as const,
      node,
      message: "The node is on the IoT.Edu management fabric. A CASE session read Basic Information before the record was stored.",
      limitation,
    };
  }

  async listUnsavedPeers() {
    if (!this.transportPromise && this.startupError) return [];
    try {
      const transport = await this.transport({ create: false });
      return this.unsavedPeers(transport);
    } catch {
      return [];
    }
  }

  async recoverExisting(input: RecoverExistingRequest | string, onProgress?: (event: CommissionProgress) => void) {
    const request: RecoverExistingRequest = typeof input === "string" ? { name: input, confirm: true } : input;
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    if (inspection.state !== "ready") {
      throw new MatterOperationError("identity_missing", "Create the management controller identity before recovery. A missing identity is not generated automatically.");
    }
    const transport = await this.transport({ create: false });
    const peer = await this.selectRecoveryPeer(transport, request.matterNodeId);
    onProgress?.({
      stage: "locate_peer",
      message: `Located Matter node ${peer.matterNodeId}. A Matter node id is not a hardware MAC. No new fabric will be added.`,
    });
    let observed: ObservedNode;
    try {
      observed = await transport.refresh(peer.matterNodeId);
    } catch (error) {
      if (error instanceof MatterOperationError) throw withLocatedPeer(error);
      throw withLocatedPeer(new MatterOperationError(
        "connection_failed",
        redactSecrets(error instanceof Error ? error.message : "The stored IoT.Edu fabric did not answer. The Apple Home fabric was not removed."),
        400,
        diagnostic("case_session", ["locate_peer"], peer.matterNodeId, "connection_failed"),
      ));
    }
    if (observed.connection !== "reachable" || observed.softwareVersion == null) {
      throw new MatterOperationError(
        "identity_read_failed",
        `Matter node ${peer.matterNodeId} did not return SoftwareVersion. No node record was stored. The Apple Home fabric was not removed.`,
        400,
        diagnostic("read_basic_information", ["locate_peer", "discover_operational", "case_session"], peer.matterNodeId, "attribute_missing"),
      );
    }
    onProgress?.({ stage: "discover_operational", message: `Matter node ${peer.matterNodeId} answered on the operational network.` });
    onProgress?.({ stage: "case_session", message: `The CASE session for Matter node ${peer.matterNodeId} supported an attribute read.` });
    onProgress?.({
      stage: "read_basic_information",
      message: `Basic Information returned SoftwareVersion ${observed.softwareVersion}${observed.softwareVersionString ? ` (${observed.softwareVersionString})` : ""}.`,
    });
    const compared = compareFirmwareIdentity(observed, {
      vendorId: request.expectedVendorId,
      productId: request.expectedProductId,
      softwareVersion: request.expectedSoftwareVersion,
      softwareVersionString: request.expectedSoftwareVersionString,
    });
    if (!compared.match) {
      throw new MatterOperationError(
        "identity_mismatch",
        `${compared.message} The Apple Home fabric was not removed.`,
        400,
        diagnostic("verify_identity", ["locate_peer", "discover_operational", "case_session", "read_basic_information"], peer.matterNodeId, "unexpected_value"),
      );
    }
    const link = linkHardware(observed.serialNumber, request.expectedHardwareMac);
    if (link.result === "mismatched") {
      const reportedMac = formatMac(link.reportedMac);
      const selectedMac = formatMac(link.expectedMac);
      onProgress?.({
        stage: "verify_identity",
        message: `Matter node ${peer.matterNodeId} reported hardware MAC ${reportedMac}. It is not the selected board ${selectedMac}.`,
      });
      onProgress?.({ stage: "management_ready", message: `The peer can be stored for ${reportedMac}. The selected board is not linked and no fabric will be removed.` });
      const node = await this.saveVerifiedNode(request.name, observed, inspection.identity.fabricId, reportedMac, true);
      onProgress?.({ stage: "register_node", message: `Stored Matter node ${peer.matterNodeId} for hardware MAC ${reportedMac}.` });
      onProgress?.({
        stage: "ready",
        message: `Matter node ${peer.matterNodeId} belongs to ${reportedMac}. ${selectedMac} was not linked. A new Apple Home pairing code can be used for the selected board.`,
      });
      return {
        simulated: false as const,
        matterSessionOpened: true as const,
        node,
        message: `Matter node ${peer.matterNodeId} reported serial number ${reportedMac}, which is not the selected hardware MAC ${selectedMac}. It was stored for ${reportedMac}. ${selectedMac} was not linked. A new Apple Home pairing code can be used for the selected board. The stored peer was not deleted and the Apple Home fabric was not removed.`,
        limitation: `This record belongs to hardware MAC ${reportedMac}. It does not represent ${selectedMac}.`,
      };
    }
    if (link.result === "unproven" && !request.registerWithoutHardwareLink) {
      throw new MatterOperationError(
        "identity_unproven",
        `Matter node ${peer.matterNodeId} reported SoftwareVersion ${observed.softwareVersion}${observed.softwareVersionString ? ` (${observed.softwareVersionString})` : ""}. ${link.reason} It was not linked to ${request.expectedHardwareMac} and it was not registered. The Apple Home fabric was not removed.`,
        400,
        diagnostic("verify_identity", ["locate_peer", "discover_operational", "case_session", "read_basic_information"], peer.matterNodeId, "hardware_unproven"),
      );
    }
    const hardwareMac = link.result === "matched" ? formatMac(link.mac) : null;
    onProgress?.({
      stage: "verify_identity",
      message: hardwareMac
        ? `Firmware identity matched and the serial number matches hardware MAC ${hardwareMac}.`
        : "Firmware identity was read. No hardware MAC was associated.",
    });
    onProgress?.({ stage: "management_ready", message: "The existing IoT.Edu fabric can be stored. No fabric will be removed." });
    const node = await this.saveVerifiedNode(request.name, observed, inspection.identity.fabricId, hardwareMac, link.result === "matched");
    onProgress?.({
      stage: "register_node",
      message: `Stored Matter node ${peer.matterNodeId} as ${node.id}.`,
    });
    onProgress?.({
      stage: "ready",
      message: `Recovered node ${peer.matterNodeId}. SoftwareVersion ${observed.softwareVersion}${observed.softwareVersionString ? ` (${observed.softwareVersionString})` : ""}. No new fabric was added.`,
    });
    return {
      simulated: false as const,
      matterSessionOpened: true as const,
      node,
      message: "The existing IoT.Edu fabric answered Basic Information. No new fabric was added, and the Apple Home fabric was not removed.",
      limitation: hardwareMac
        ? `Linked to hardware MAC ${hardwareMac} because the Basic Information serial number matched. Other fabrics were left in place.`
        : link.result === "unproven"
          ? "This Matter node was stored without a hardware MAC. Basic Information did not prove which board it is."
          : observed.serialNumber
            ? "No selected hardware MAC was supplied, so the serial number was not used to link a board."
            : "No hardware MAC was associated because Basic Information did not include a serial number.",
    };
  }

  async refreshNode(nodeId: string): Promise<RefreshResult> {
    const node = await this.nodes.getById(nodeId);
    if (!node) throw new MatterOperationError("invalid_input", "Node not found", 404);
    if (node.simulated || !node.matterNodeId) {
      return {
        node,
        liveRead: "unavailable",
        message: "Basic Information was not read. This record has no management-fabric node id.",
      };
    }
    try {
      const transport = await this.transport({ create: false });
      const observed = await transport.refresh(node.matterNodeId);
      const updated = this.mergeObservation(node, observed, "refreshed");
      await this.nodes.save(updated);
      return {
        node: updated,
        liveRead: observed.connection === "reachable" ? "read" : "failed",
        message: observed.connection === "reachable"
          ? "Administrative clusters were read from a new endpoint 0 response. Sensor measurements were not requested."
          : "The node is still registered, but it did not answer a fresh Basic Information read. Stored credentials were not removed.",
      };
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : "The management session could not read the node.");
      const updated = this.recordUnreachable(node, message);
      await this.nodes.save(updated);
      return {
        node: updated,
        liveRead: "failed",
        message,
      };
    }
  }

  async removeNode(nodeId: string, input: RemoveNodeRequest): Promise<RemoveNodeResult> {
    const node = await this.nodes.getById(nodeId);
    if (!node) throw new MatterOperationError("invalid_input", "Node not found", 404);
    if (input.phrase !== node.name) {
      throw new MatterOperationError("invalid_input", "The confirmation phrase does not match the node name. Nothing was removed.");
    }
    if (input.mode === "decommission") {
      if (node.simulated || !node.matterNodeId) {
        throw new MatterOperationError("invalid_input", "This record has no IoT.Edu fabric on a device. Nothing was removed.");
      }
      const refreshed = await this.refreshNode(node.id);
      if (refreshed.liveRead !== "read" || refreshed.node.presence !== "online") {
        throw new MatterOperationError(
          "connection_failed",
          "The node did not answer a fresh Basic Information read, so RemoveFabric was not sent. The local record was kept.",
        );
      }
      const transport = await this.transport({ create: false });
      const removed = await transport.decommissionPeer(node.matterNodeId);
      if (!removed.removedOnDevice) {
        throw new MatterOperationError("connection_failed", `${removed.detail} The local record was kept.`);
      }
      await this.nodes.delete(node.id);
      return {
        mode: "decommission",
        physicalFabricRemoved: true,
        localRecordRemoved: true,
        message: removed.detail,
      };
    }
    if (node.matterNodeId && !node.simulated) {
      const transport = await this.transport({ create: false });
      await transport.forgetPeer(node.matterNodeId);
    }
    await this.nodes.delete(node.id);
    return {
      mode: "forget",
      physicalFabricRemoved: false,
      localRecordRemoved: true,
      message: "The local managed-node record was removed. RemoveFabric was not sent. Matter credentials may still be on the device.",
    };
  }

  async retireUnsavedPeer(input: import("@iotedu/contracts").RetirePeerRequest) {
    if (input.phrase !== input.matterNodeId) {
      throw new MatterOperationError("invalid_input", "The confirmation does not match the selected Matter node. No peer was removed.");
    }
    const saved = (await this.nodes.list()).find((node) => node.matterNodeId === input.matterNodeId);
    if (saved) {
      throw new MatterOperationError(
        "invalid_input",
        "This Matter node is a saved management record. Use Forget Local Record Only from Overview and type the node name. Nothing was removed.",
      );
    }
    const transport = await this.transport({ create: false });
    const peers = await transport.listCommissionedPeers();
    if (!peers.some((peer) => peer.matterNodeId === input.matterNodeId)) {
      throw new MatterOperationError("invalid_input", "That peer is not stored. Nothing was removed.");
    }
    await transport.forgetPeer(input.matterNodeId);
    return {
      matterNodeId: input.matterNodeId,
      localPeerRemoved: true,
      savedRecordRemoved: false as const,
      physicalFabricRemoved: false as const,
      message: "The unsaved local peer was removed. RemoveFabric was not sent. Other peers and the controller identity were kept. Apple Home was not changed.",
    };
  }

  async reconciliationPlan(): Promise<ControllerReconciliationPlan> {
    const inspection = await inspectIdentity(this.dataDir, FABRIC_LABEL);
    const identityReady = inspection.state === "ready" && this.startupError == null;
    const notUsed = [
      "ClientNode.decommission() asks the device to remove the fabric. It is not used while the fabric still works, and it fails after a factory reset because the device no longer accepts those credentials.",
      "Peers.erase() deletes every known peer, including the controller's commissioned set. It is not used.",
      "Credential files for the controller identity are not deleted.",
    ];
    if (!identityReady) {
      return {
        controllerIdentityPreserved: true,
        identityReady: false,
        executed: false,
        credentialStoreEdited: false,
        peers: [],
        retireAfterFactoryReset: "ClientNode.delete() is the supported local-only retire method. It was not called.",
        notUsed,
        blocker: inspection.state === "ready"
          ? this.startupError
          : "message" in inspection
            ? inspection.message
            : "No management identity is stored. Local peers were not deleted.",
      };
    }
    try {
      const transport = await this.transport({ create: false });
      const peers = await transport.listCommissionedPeers();
      const saved = await this.nodes.list();
      return {
        controllerIdentityPreserved: true,
        identityReady: true,
        executed: false,
        credentialStoreEdited: false,
        peers: peers.map((peer) => {
          const savedNode = saved.find((node) => node.matterNodeId === peer.matterNodeId);
          return {
            matterNodeId: peer.matterNodeId,
            commissionedAt: peer.commissionedAt,
            savedNodeId: savedNode?.id ?? null,
            role: savedNode ? "saved-managed-node" as const : "unsaved-stale-peer" as const,
          };
        }),
        retireAfterFactoryReset: "After a confirmed physical factory reset, ClientNode.delete() can drop the local peer without sending RemoveFabric. That call has not been made.",
        notUsed,
        blocker: null,
      };
    } catch (error) {
      return {
        controllerIdentityPreserved: true,
        identityReady: false,
        executed: false,
        credentialStoreEdited: false,
        peers: [],
        retireAfterFactoryReset: "ClientNode.delete() was not called.",
        notUsed,
        blocker: redactSecrets(error instanceof Error ? error.message : "The controller storage could not be inspected."),
      };
    }
  }

  async openCommissioningWindow(nodeId: string): Promise<CommissioningWindowResult> {
    const node = await this.nodes.getById(nodeId);
    if (!node) throw new MatterOperationError("invalid_input", "Node not found", 404);
    if (node.simulated || !node.matterNodeId) {
      return {
        opened: false,
        message: "AdministratorCommissioning was not invoked. This record has no live management session.",
      };
    }
    try {
      const transport = await this.transport({ create: false });
      const window = await transport.openSharingWindow(node.matterNodeId);
      return {
        opened: true,
        message: "An enhanced commissioning window was opened for a second administrator. The code is shown once and is redacted from logs.",
        manualPairingCode: window.manualPairingCode || undefined,
        qrPairingCode: window.qrPairingCode || undefined,
        durationSeconds: window.durationSeconds,
        openedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        opened: false,
        message: redactSecrets(error instanceof Error ? error.message : "The commissioning window was not opened. The node was not factory reset."),
      };
    }
  }

  private async transport(options: { create: boolean }): Promise<ManagementTransport> {
    if (!this.transportPromise) {
      this.transportPromise = this.injected
        ? Promise.resolve(this.injected)
        : import("./live.js").then((module) => module.openMatterTransport(this.directory(), options));
    }
    const transport = await this.transportPromise;
    return transport;
  }

  private async selectRecoveryPeer(transport: ManagementTransport, matterNodeId?: string) {
    const commissioned = [...await transport.listCommissionedPeers()].sort((left, right) => (right.commissionedAt ?? 0) - (left.commissionedAt ?? 0));
    const savedIds = new Set((await this.nodes.list()).map((node) => node.matterNodeId).filter((id): id is string => Boolean(id)));
    if (matterNodeId) {
      const selected = commissioned.find((peer) => peer.matterNodeId === matterNodeId);
      if (!selected) {
        throw new MatterOperationError(
          "peer_selection_required",
          `Matter node ${matterNodeId} is not a commissioned peer of this controller. Nothing was registered and no peer was deleted.`,
          400,
          diagnostic("locate_peer", [], matterNodeId, "peer_not_stored"),
        );
      }
      return selected;
    }
    const unsaved = commissioned.filter((peer) => !savedIds.has(peer.matterNodeId));
    if (unsaved.length === 1 && unsaved[0]) return unsaved[0];
    if (unsaved.length > 1) {
      throw new MatterOperationError(
        "peer_selection_required",
        `This controller has ${unsaved.length} unsaved commissioned peers (${unsaved.map((peer) => peer.matterNodeId).join(", ")}). Choose one. A stored peer was not assumed to be the selected ESP32-H2. No peer was deleted.`,
        400,
        diagnostic("locate_peer", [], null, "peer_selection_required"),
      );
    }
    const savedPeers = commissioned.filter((peer) => savedIds.has(peer.matterNodeId));
    if (savedPeers.length === 1 && savedPeers[0]) return savedPeers[0];
    if (savedPeers.length > 1) {
      throw new MatterOperationError(
        "peer_selection_required",
        `Choose which saved Matter node to verify (${savedPeers.map((peer) => peer.matterNodeId).join(", ")}). No peer was deleted.`,
        400,
        diagnostic("locate_peer", [], null, "peer_selection_required"),
      );
    }
    throw new MatterOperationError(
      "connection_failed",
      "No unsaved IoT.Edu fabric peer is stored. A new Apple Home pairing code is required to add one. The Apple Home fabric was not removed.",
      400,
      diagnostic("locate_peer", [], null, "peer_missing"),
    );
  }

  private async saveVerifiedNode(name: string, observed: ObservedNode, managementFabricId: string | null, hardwareMac: string | null, matched: boolean): Promise<ManagedNode> {
    const existing = (await this.nodes.list()).find((node) => node.matterNodeId === observed.matterNodeId);
    if (existing) {
      const merged = this.mergeObservation(existing, observed, "recovered");
      const node = hardwareMac ? { ...merged, hardwareMac } : merged;
      await this.nodes.save(node);
      return node;
    }
    const node = this.recordFromObservation(name, observed, "recovered", managementFabricId, hardwareMac, matched);
    await this.nodes.save(node);
    return node;
  }

  private async saveCommissionedNode(name: string, observed: ObservedNode, managementFabricId: string | null): Promise<ManagedNode> {
    const reportedMac = serialHardwareMac(observed.serialNumber);
    const saved = await this.nodes.list();
    const decision = managedNodeAfterResetDecision({
      nodes: saved,
      reportedMac,
      matterNodeId: observed.matterNodeId,
    });
    if (decision.action === "reject") {
      const sameBoard = saved.find((node) => node.id === decision.nodeId);
      throw new MatterOperationError(
        "peer_mismatch",
        `Basic Information serial number ${reportedMac} is already stored on ${sameBoard?.name ?? "another record"}. A second managed record was not created. No stored peer was deleted and the Apple Home fabric was not removed.`,
      );
    }
    if (decision.action === "relink") {
      const sameBoard = saved.find((node) => node.id === decision.nodeId);
      if (!sameBoard) {
        throw new MatterOperationError("peer_mismatch", "The reset record could not be found. No second managed record was created and no peer was deleted.");
      }
      const now = new Date().toISOString();
      const merged = this.mergeObservation(sameBoard, observed, "recommissioned");
      const node: ManagedNode = {
        ...merged,
        hardwareMac: reportedMac,
        operationalReverification: undefined,
        history: [...merged.history, { at: now, kind: "recommissioned", detail: "The same hardware was commissioned again after a factory reset. The previous controller peer was kept." }],
      };
      await this.nodes.save(node);
      return node;
    }
    const sameNode = saved.find((node) => node.matterNodeId === observed.matterNodeId);
    if (sameNode) {
      const merged = this.mergeObservation(sameNode, observed, "commissioned");
      const node = reportedMac ? { ...merged, hardwareMac: reportedMac } : merged;
      await this.nodes.save(node);
      return node;
    }
    const node = this.recordFromObservation(name, observed, "commissioned", managementFabricId, reportedMac, Boolean(reportedMac));
    await this.nodes.save(node);
    return node;
  }

  private async unsavedPeers(transport: ManagementTransport) {
    const peers = [...await transport.listCommissionedPeers()].sort((left, right) => (right.commissionedAt ?? 0) - (left.commissionedAt ?? 0));
    const saved = new Set((await this.nodes.list()).map((node) => node.matterNodeId).filter((id): id is string => Boolean(id)));
    return peers.filter((peer) => !saved.has(peer.matterNodeId));
  }

  private directory(): string {
    return controllerStorageDir(this.dataDir);
  }

  private async applyObservations(observations: ObservedNode[]): Promise<void> {
    const nodes = await this.nodes.list();
    for (const observed of observations) {
      const existing = nodes.find((node) => node.matterNodeId === observed.matterNodeId);
      if (!existing) continue;
      await this.nodes.save(this.mergeObservation(existing, observed, "reconnected"));
    }
  }

  private recordFromObservation(name: string, observed: ObservedNode, kind: string, managementFabricId: string | null, hardwareMac: string | null = null, matched = false): ManagedNode {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      name,
      simulated: false,
      matterNodeId: observed.matterNodeId,
      vendorId: observed.vendorId,
      productId: observed.productId,
      softwareVersion: observed.softwareVersion,
      softwareVersionString: observed.softwareVersionString,
      hardwareMac,
      hardware: observed.hardwareVersionString ?? "Not returned by the device",
      hardwareVersion: observed.hardwareVersion,
      hardwareVersionString: observed.hardwareVersionString,
      reachable: observed.connection === "reachable" ? true : observed.connection === "offline" ? false : null,
      connection: observed.connection,
      presence: observed.connection === "reachable" ? "online" : observed.connection === "offline" ? "unreachable" : "unknown",
      lastCommunicationAt: observed.lastCommunicationAt,
      lastSuccessfulCommunicationAt: observed.connection === "reachable" ? observed.lastCommunicationAt : null,
      lastFailedCommunicationAt: null,
      lastReachabilityCheckAt: new Date().toISOString(),
      reachabilityError: null,
      firmwareUpdateEligible: observed.firmwareUpdateEligible,
      fabricLabel: FABRIC_LABEL,
      managementFabricId,
      commissionedFabricCount: observed.commissionedFabricCount,
      otherFabricCount: otherFabricCount(observed.commissionedFabricCount),
      partitionLayoutId: null,
      installedComponents: [],
      history: [{ at: now, kind, detail: historyDetail(observed, hardwareMac, matched) }],
      createdAt: now,
      updatedAt: now,
    };
  }

  private mergeObservation(node: ManagedNode, observed: ObservedNode, kind: string): ManagedNode {
    const now = new Date().toISOString();
    const online = observed.connection === "reachable";
    const failed = observed.connection === "offline";
    const presence = online ? "online" as const : failed ? "unreachable" as const : node.presence ?? "unknown";
    const versionChanged = observed.softwareVersion != null && observed.softwareVersion !== node.softwareVersion;
    const changed = presence !== node.presence || versionChanged;
    return {
      ...node,
      simulated: false,
      matterNodeId: observed.matterNodeId,
      vendorId: observed.vendorId ?? node.vendorId,
      productId: observed.productId ?? node.productId,
      softwareVersion: observed.softwareVersion ?? node.softwareVersion,
      softwareVersionString: observed.softwareVersionString ?? node.softwareVersionString,
      hardware: observed.hardwareVersionString ?? node.hardware,
      hardwareVersion: observed.hardwareVersion ?? node.hardwareVersion,
      hardwareVersionString: observed.hardwareVersionString ?? node.hardwareVersionString,
      reachable: online ? true : failed ? false : null,
      connection: observed.connection,
      presence,
      lastCommunicationAt: online ? (observed.lastCommunicationAt ?? now) : node.lastCommunicationAt,
      lastSuccessfulCommunicationAt: online
        ? (observed.lastCommunicationAt ?? now)
        : (node.lastSuccessfulCommunicationAt ?? node.lastCommunicationAt ?? null),
      lastFailedCommunicationAt: failed ? now : node.lastFailedCommunicationAt ?? null,
      lastReachabilityCheckAt: now,
      reachabilityError: failed ? "The node did not answer a fresh Basic Information read. Stored credentials were not removed." : null,
      firmwareUpdateEligible: observed.firmwareUpdateEligible ?? node.firmwareUpdateEligible,
      commissionedFabricCount: observed.commissionedFabricCount ?? node.commissionedFabricCount,
      otherFabricCount: otherFabricCount(observed.commissionedFabricCount ?? node.commissionedFabricCount ?? null),
      updatedAt: now,
      history: changed ? [...node.history, { at: now, kind, detail: historyDetail(observed) }] : node.history,
    };
  }

  private recordUnreachable(node: ManagedNode, message: string): ManagedNode {
    const now = new Date().toISOString();
    const changed = node.presence !== "unreachable";
    return {
      ...node,
      reachable: false,
      connection: "offline",
      presence: "unreachable",
      lastSuccessfulCommunicationAt: node.lastSuccessfulCommunicationAt ?? node.lastCommunicationAt ?? null,
      lastFailedCommunicationAt: now,
      lastReachabilityCheckAt: now,
      reachabilityError: message,
      updatedAt: now,
      history: changed ? [...node.history, { at: now, kind: "reachability_failed", detail: message }] : node.history,
    };
  }
}

export function normalizePairingCode(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value.trim().replace(/\s+/g, "");
  if (/^MT:[A-Z0-9.-]+$/i.test(compact) && compact.length <= 512) return compact;
  if (/^\d{11}$/.test(compact) || /^\d{21}$/.test(compact)) return compact;
  if (/^\d{4}-\d{3}-\d{4}$/.test(compact)) return compact;
  throw new MatterOperationError("invalid_input", "The commissioning code is not a Matter QR code or manual pairing code.");
}

function offlineObservation(matterNodeId: string): ObservedNode {
  return {
    matterNodeId,
    vendorId: null,
    productId: null,
    hardwareVersion: null,
    hardwareVersionString: null,
    softwareVersion: null,
    softwareVersionString: null,
    serialNumber: null,
    commissionedFabricCount: null,
    firmwareUpdateEligible: null,
    connection: "offline",
    lastCommunicationAt: null,
  };
}

function otherFabricCount(count: number | null): number | null {
  if (count == null) return null;
  return Math.max(0, count - 1);
}

function historyDetail(observed: ObservedNode, hardwareMac: string | null = null, matched = false): string {
  const version = observed.softwareVersionString ?? (observed.softwareVersion == null ? "not returned" : String(observed.softwareVersion));
  const hardware = matched && hardwareMac
    ? ` Hardware MAC ${hardwareMac} matched the Basic Information serial number.`
    : " No hardware MAC was associated.";
  return `Management connection ${observed.connection}. SoftwareVersion ${version}.${hardware}`;
}

function diagnostic(stage: IdentityStage, completed: IdentityStage[], matterNodeId: string | null, errorClass: string): IdentityDiagnostic {
  return {
    stage,
    completed,
    matterNodeId,
    endpointId: stage === "read_basic_information" ? 0 : null,
    clusterId: stage === "read_basic_information" ? 0x0028 : null,
    attributeId: stage === "read_basic_information" ? 0x0009 : null,
    errorClass,
    status: null,
    elapsedMs: null,
    attempts: 1,
  };
}

function withLocatedPeer(error: MatterOperationError): MatterOperationError {
  if (!error.detail) return error;
  if (error.detail.completed.includes("locate_peer")) return error;
  return new MatterOperationError(error.code, error.message, error.statusCode, {
    ...error.detail,
    completed: ["locate_peer", ...error.detail.completed],
  });
}
