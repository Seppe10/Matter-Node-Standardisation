import path from "node:path";
import { config } from "@matter/nodejs/config";
import { FABRIC_LABEL } from "@iotedu/contracts";
import { MatterOperationError } from "./errors.js";
import {
  basicInformationAttributePaths,
  classifyIdentityThrown,
  interpretBasicInformation,
  logIdentityDiagnostic,
  normaliseAttributeReport,
  type AttributeObservation,
  type AttributePath,
} from "./identity-read.js";
import { IDENTITY_FILE, protectStorage } from "./identity.js";
import { redactSecrets } from "./redact.js";
import type { ControllerRuntimeInfo, ManagementTransport, ObservedNode, SharingWindow } from "./session.js";
import { interpretApplicationModel, partsFrom, DESCRIPTOR_CLUSTER_ID, DEVICE_TYPE_LIST_ATTRIBUTE_ID, PARTS_LIST_ATTRIBUTE_ID, SERVER_LIST_ATTRIBUTE_ID } from "./application-model.js";

const MATTER_JS_VERSION = "0.18.0";
const CONTROLLER_ID = "iotedu-management";

let platformReady = false;
let active: { directory: string; node: MatterControllerNode; transport: MatterJsTransport } | null = null;

interface MatterControllerNode {
  start(): Promise<void>;
  close(): Promise<void>;
  add(definition: unknown): Promise<{ number: number; act<T>(actor: (agent: { get(type: unknown): never }) => Promise<T>): Promise<T> }>;
  state: { basicInformation?: { uniqueId?: string } };
  env: { get(type: unknown): { fabrics?: Array<{ fabricId?: unknown; nodeId?: unknown }>; config?: { rootKeyIdentifier?: unknown } } };
  peers: {
    commissioned: RemotePeer[];
    commission(options: Record<string, unknown>): Promise<RemotePeer>;
  };
}

interface RemotePeer {
  id: string;
  peerAddress?: { nodeId?: unknown };
  lifecycle: { isConnected?: boolean; isOnline?: boolean };
  state?: { commissioning?: { commissionedAt?: number; addresses?: unknown[] } };
  interaction?: { read(request: unknown): AsyncIterable<AsyncIterable<unknown>> };
  start(): Promise<void>;
  decommission?(): Promise<void>;
  delete?(): Promise<void>;
  act(purpose: string, actor: (agent: Record<string, unknown>) => Promise<ObservedFacts>): Promise<ObservedFacts>;
  openEnhancedCommissioningWindow(timeout?: unknown): Promise<{ manualPairingCode?: string; qrPairingCode?: string }>;
}

interface ObservedFacts {
  vendorId: number | null;
  productId: number | null;
  hardwareVersion: number | null;
  hardwareVersionString: string | null;
  softwareVersion: number | null;
  softwareVersionString: string | null;
  serialNumber: string | null;
  commissionedFabricCount: number | null;
  firmwareUpdateEligible: boolean | null;
}

/**
 * Matter.js installs process signal handlers when its platform loads.
 * Configure that platform before the first import, and keep storage inside the data directory.
 */
export function armMatterPlatform(storageDir: string): void {
  const directory = path.resolve(storageDir);
  process.env.MATTER_PATH_ROOT = directory;
  process.env.MATTER_STORAGE_PATH = directory;
  process.env.MATTER_PATH_CONFIG = path.join(directory, "matter-config.json");
  if (platformReady) return;
  config.trapProcessSignals = false;
  config.trapUnhandledErrors = false;
  config.setProcessExitCodeOnError = false;
  config.loadProcessArgv = false;
  config.defaultEnvironmentName = "iotedu";
  config.defaultStoragePath = directory;
  config.defaultConfigFilePath = "matter-config.json";
  process.env.MATTER_DCL_OFFLINE = "true";
  platformReady = true;
}

export async function openMatterTransport(storageDir: string, options: { create: boolean }): Promise<ManagementTransport> {
  const directory = path.resolve(storageDir);
  if (active?.directory === directory) return active.transport;
  if (active) {
    throw new MatterOperationError("connection_failed", "A Matter controller is already open for another data directory.");
  }
  if (!options.create && !(await storageHasKeys(directory))) {
    throw new MatterOperationError(
      "identity_corrupt",
      "The controller identity record is present but its credential files are missing. IoT.Edu did not generate a replacement identity.",
    );
  }
  armMatterPlatform(directory);
  const { ServerNode, Logger, LogLevel, Seconds } = await import("@matter/main");
  const { ControllerBehavior } = await import("@matter/node/behaviors/system/controller");
  const { Read, FabricAuthority, CertificateAuthority } = await import("@matter/protocol");
  installRedactingLog(Logger, LogLevel.WARN);
  const root = ServerNode.RootEndpoint.with(ControllerBehavior);
  const node = await ServerNode.create(root, {
    id: CONTROLLER_ID,
    controller: {
      adminFabricLabel: FABRIC_LABEL,
      ble: false,
      ip: true,
    },
    basicInformation: {
      nodeLabel: FABRIC_LABEL,
      productName: "Management Hub",
      vendorName: "IoT.Edu",
    },
  }) as unknown as MatterControllerNode;
  await node.start();
  await protectStorage(directory);
  const read = Read as unknown as ReadApi;
  const transport = new MatterJsTransport(node, FabricAuthority, CertificateAuthority, read, Seconds, directory);
  active = { directory, node, transport };
  return transport;
}

interface ReadApi {
  (options: { fabricFilter?: boolean; attributes?: AttributePath[] }, ...selectors: unknown[]): Record<string, unknown>;
  (...selectors: unknown[]): unknown;
  Attribute(selector: { endpoint: number }): unknown;
}

class MatterJsTransport implements ManagementTransport {
  constructor(
    private readonly node: MatterControllerNode,
    private readonly fabricAuthority: unknown,
    private readonly certificateAuthority: unknown,
    private readonly read: ReadApi,
    private readonly seconds: (value: number) => unknown,
    private readonly directory: string,
  ) {}

  async ensureStarted(_options: { create: boolean }): Promise<ControllerRuntimeInfo> {
    const authority = this.node.env.get(this.fabricAuthority);
    const fabric = authority.fabrics?.[0];
    const certificate = this.node.env.get(this.certificateAuthority) as {
      construction?: PromiseLike<unknown>;
      config?: { rootKeyIdentifier?: unknown };
    };
    if (certificate.construction) await certificate.construction;
    return {
      fabricId: idText(fabric?.fabricId),
      credentialId: bytesToHex(certificate.config?.rootKeyIdentifier) ?? idText(this.node.state.basicInformation?.uniqueId),
      controllerNodeId: idText(fabric?.nodeId) ?? this.node.state.basicInformation?.uniqueId ?? null,
      matterJsVersion: MATTER_JS_VERSION,
    };
  }

  async commissionOnExistingNetwork(
    pairingCode: string,
    onProgress?: (event: import("@iotedu/contracts").CommissionProgress) => void,
  ): Promise<ObservedNode> {
    onProgress?.({
      stage: "discovering",
      message: "Looking for the commissioned device on the local IPv6 network. The pairing session and IoT.Edu fabric are added in this step. Bluetooth is not used, and the Thread dataset is not changed.",
    });
    let peer: RemotePeer;
    try {
      peer = await withTimeout(this.node.peers.commission({
        pairingCode,
        autoSubscribe: false,
        autoStateInitialize: true,
        defaultSubscription: this.read(this.read.Attribute({ endpoint: 0 })),
        discoveryCapabilities: { onIpNetwork: true, ble: false },
        timeout: this.seconds(60),
      }), 90_000, "Commissioning");
    } catch (error) {
      throw mapCommissionError(error);
    }
    onProgress?.({
      stage: "operational_case",
      message: "The controller finished PASE, NOC installation, operational discovery, CASE, and CommissioningComplete. No second commissioning session will be opened.",
    });
    onProgress?.({
      stage: "verifying_firmware",
      message: "Reading Basic Information on endpoint 0, including SoftwareVersion. A missing optional attribute is not a failure.",
    });
    return this.describe(peer, true);
  }

  async listCommissionedPeers() {
    const peers = this.node.peers.commissioned.flatMap((peer) => {
      const matterNodeId = idText(peer.peerAddress?.nodeId);
      if (!matterNodeId) return [];
      const commissionedAt = peer.state?.commissioning?.commissionedAt;
      return [{ matterNodeId, commissionedAt: typeof commissionedAt === "number" ? commissionedAt : null }];
    });
    peers.sort((left, right) => (right.commissionedAt ?? 0) - (left.commissionedAt ?? 0));
    return peers;
  }

  async decommissionPeer(matterNodeId: string): Promise<{ removedOnDevice: boolean; detail: string }> {
    const peer = this.find(matterNodeId);
    if (!peer.decommission) {
      throw new MatterOperationError("connection_failed", "This Matter.js controller cannot remove its own fabric. Nothing was removed.");
    }
    await withTimeout(peer.decommission(), 45_000, "IoT.Edu fabric removal");
    const stillThere = (await this.listCommissionedPeers()).some((item) => item.matterNodeId === matterNodeId);
    if (stillThere) {
      throw new MatterOperationError(
        "connection_failed",
        "The device still has this IoT.Edu node. The local record was kept. Apple Home fabrics were not targeted.",
      );
    }
    if (peer.delete) await peer.delete();
    return {
      removedOnDevice: true,
      detail: `IoT.Edu's own fabric for Matter node ${matterNodeId} was removed after the device confirmed it. Other fabrics were not targeted.`,
    };
  }

  async forgetPeer(matterNodeId: string): Promise<void> {
    const peer = this.node.peers.commissioned.find((item) => idText(item.peerAddress?.nodeId) === matterNodeId);
    if (!peer) return;
    if (!peer.delete) {
      throw new MatterOperationError("connection_failed", "The local peer could not be forgotten. The managed-node record was kept.");
    }
    await peer.delete();
  }

  async refresh(matterNodeId: string): Promise<ObservedNode> {
    const peer = this.find(matterNodeId);
    try {
      return await this.describe(peer, true, { timeoutMs: 45_000 });
    } catch (first) {
      try {
        return await this.describe(peer, true, { forceStart: true, timeoutMs: 45_000 });
      } catch {
        throw first;
      }
    }
  }

  async reconnect(): Promise<ObservedNode[]> {
    const nodes: ObservedNode[] = [];
    for (const peer of this.node.peers.commissioned) {
      const id = idText(peer.peerAddress?.nodeId);
      if (!id) continue;
      try {
        nodes.push(await this.describe(peer, true));
      } catch {
        nodes.push(emptyObservation(id, "offline"));
      }
    }
    return nodes;
  }

  async openSharingWindow(matterNodeId: string): Promise<SharingWindow> {
    const peer = this.find(matterNodeId);
    try {
      await withTimeout(peer.start(), 20_000, "CASE session");
      const durationSeconds = 180;
      const window = await withTimeout(peer.openEnhancedCommissioningWindow(this.seconds(durationSeconds)), 20_000, "Commissioning window");
      if (!window.manualPairingCode && !window.qrPairingCode) {
        throw new MatterOperationError("connection_failed", "The device did not return a commissioning code.");
      }
      return {
        manualPairingCode: window.manualPairingCode ?? "",
        qrPairingCode: window.qrPairingCode ?? "",
        durationSeconds,
      };
    } catch (error) {
      if (error instanceof MatterOperationError) throw error;
      throw new MatterOperationError("connection_failed", `The commissioning window was not opened. ${safeMessage(error)} The node was not factory reset.`);
    }
  }

  async close(): Promise<void> {
    await this.node.close();
    if (active?.node === this.node) active = null;
  }

  async readApplicationModel(matterNodeId: string) {
    const peer = this.find(matterNodeId);
    await withTimeout(peer.start(), 45_000, "CASE session");
    const partReports = await this.collectReports(peer, [{
      endpointId: 0,
      clusterId: DESCRIPTOR_CLUSTER_ID,
      attributeId: PARTS_LIST_ATTRIBUTE_ID,
    }], matterNodeId, 1, 0);
    const parts = [0, ...partsFrom(partReports)];
    const paths = [...new Set(parts)].slice(0, 16).flatMap((endpointId) => [
      { endpointId, clusterId: DESCRIPTOR_CLUSTER_ID, attributeId: DEVICE_TYPE_LIST_ATTRIBUTE_ID },
      { endpointId, clusterId: DESCRIPTOR_CLUSTER_ID, attributeId: SERVER_LIST_ATTRIBUTE_ID },
    ]);
    const reports = await this.collectReports(peer, paths, matterNodeId, 1, 0);
    return interpretApplicationModel([...new Set(parts)], reports);
  }

  private async readFacts(peer: RemotePeer, matterNodeId: string): Promise<ObservedFacts> {
    const started = Date.now();
    let attempts = 0;
    let lastError: MatterOperationError | null = null;
    while (attempts < 3) {
      attempts += 1;
      const elapsedMs = () => Date.now() - started;
      try {
        const reports = await this.collectReports(peer, basicInformationAttributePaths(), matterNodeId, attempts, elapsedMs());
        const interpreted = interpretBasicInformation(reports, {
          matterNodeId,
          elapsedMs: elapsedMs(),
          attempts,
          sessionOnline: sessionReady(peer) || reports.length > 0,
        });
        if (!interpreted.ok) {
          lastError = interpreted.error;
          if (attempts < 3 && interpreted.error.detail?.errorClass === "timeout") {
            logIdentityDiagnostic(interpreted.error.detail, interpreted.error.message);
            continue;
          }
          logIdentityDiagnostic(interpreted.error.detail, interpreted.error.message);
          throw interpreted.error;
        }
        const optional = await this.readOptionalFacts(peer);
        return {
          vendorId: interpreted.facts.vendorId,
          productId: interpreted.facts.productId,
          hardwareVersion: interpreted.facts.hardwareVersion,
          hardwareVersionString: interpreted.facts.hardwareVersionString,
          softwareVersion: interpreted.facts.softwareVersion,
          softwareVersionString: interpreted.facts.softwareVersionString,
          serialNumber: interpreted.facts.serialNumber,
          commissionedFabricCount: optional.commissionedFabricCount,
          firmwareUpdateEligible: optional.firmwareUpdateEligible,
        };
      } catch (error) {
        const classified = classifyIdentityThrown(error, {
          stageHint: sessionReady(peer) ? "read_basic_information" : "discover_operational",
          sessionOnline: sessionReady(peer),
          matterNodeId,
          elapsedMs: elapsedMs(),
          attempts,
          phase: "read",
          storedAddress: hasStoredAddress(peer),
        });
        lastError = classified;
        const attributeRetry = classified.detail?.stage === "read_basic_information"
          && (classified.detail.errorClass === "aborted" || classified.detail.errorClass === "timeout");
        if (attempts < 3 && attributeRetry) {
          logIdentityDiagnostic(classified.detail, classified.message);
          continue;
        }
        logIdentityDiagnostic(classified.detail, classified.message);
        throw classified;
      }
    }
    throw lastError ?? new MatterOperationError(
      "identity_read_failed",
      `Basic Information on endpoint 0 was not read for Matter node ${matterNodeId}. No node record was stored.`,
    );
  }

  private async collectReports(
    peer: RemotePeer,
    attributes: AttributePath[],
    matterNodeId: string,
    attempts: number,
    elapsedMs: number,
  ): Promise<AttributeObservation[]> {
    if (!peer.interaction?.read) {
      throw new MatterOperationError(
        "identity_read_failed",
        `This Matter.js controller did not expose an attribute read for Matter node ${matterNodeId}. Cached endpoint state was not used. No node record was stored.`,
        400,
        {
          stage: "read_basic_information",
          completed: sessionReady(peer) ? ["discover_operational", "case_session"] : [],
          matterNodeId,
          endpointId: 0,
          clusterId: 0x0028,
          attributeId: 0x0009,
          errorClass: "unsupported_api",
          status: null,
          elapsedMs,
          attempts,
        },
      );
    }
    const request = {
      ...this.read({ fabricFilter: true, attributes }),
      includeKnownVersions: true,
    };
    const found: AttributeObservation[] = [];
    for await (const chunk of peer.interaction.read(request)) {
      for await (const report of asReports(chunk)) {
        const normalised = normaliseAttributeReport(report);
        if (normalised) found.push(normalised);
      }
    }
    return found;
  }

  private async readOptionalFacts(peer: RemotePeer): Promise<{ commissionedFabricCount: number | null; firmwareUpdateEligible: boolean | null }> {
    try {
      const reports = await this.collectReports(peer, [
        { endpointId: 0, clusterId: 0x003e, attributeId: 0x0003 },
      ], "optional", 1, 0);
      const fabrics = reports.find((report) => report.kind === "value" && report.clusterId === 0x003e && report.attributeId === 0x0003);
      return {
        commissionedFabricCount: numberOrNull(fabrics?.value),
        firmwareUpdateEligible: null,
      };
    } catch {
      return { commissionedFabricCount: null, firmwareUpdateEligible: null };
    }
  }

  private find(matterNodeId: string): RemotePeer {
    const peer = this.node.peers.commissioned.find((item) => idText(item.peerAddress?.nodeId) === matterNodeId);
    if (!peer) throw new MatterOperationError("connection_failed", "That node is not on the IoT.Edu management fabric.");
    return peer;
  }

  private async describe(peer: RemotePeer, attemptSession: boolean, options?: { forceStart?: boolean; timeoutMs?: number }): Promise<ObservedNode> {
    const timeoutMs = options?.timeoutMs ?? 100_000;
    const matterNodeId = idText(peer.peerAddress?.nodeId);
    if (!matterNodeId) {
      throw new MatterOperationError("connection_failed", "The controller did not receive a Matter node id. No node record was stored.");
    }
    if (!attemptSession) {
      return emptyObservation(matterNodeId, "commissioned");
    }
    const started = Date.now();
    if (options?.forceStart || peer.lifecycle.isOnline !== true) {
      try {
        await withTimeout(peer.start(), 20_000, "Stored peer preparation");
      } catch (error) {
        throw classifyIdentityThrown(error, {
          stageHint: "locate_peer",
          sessionOnline: false,
          matterNodeId,
          elapsedMs: Date.now() - started,
          attempts: 1,
          phase: "prepare",
        });
      }
    }
    let facts: ObservedFacts;
    try {
      facts = await withTimeout(this.readFacts(peer, matterNodeId), timeoutMs, "Operational reconnect");
    } catch (error) {
      throw classifyIdentityThrown(error, {
        stageHint: sessionReady(peer) ? "read_basic_information" : "discover_operational",
        sessionOnline: sessionReady(peer),
        matterNodeId,
        elapsedMs: Date.now() - started,
        attempts: 1,
        phase: "read",
        storedAddress: hasStoredAddress(peer),
      });
    }
    if (facts.softwareVersion == null) {
      throw new MatterOperationError(
        "identity_read_failed",
        "Basic Information was read, but SoftwareVersion was absent. SerialNumber is optional and was not required. No node record was stored.",
      );
    }
    return {
      matterNodeId,
      ...facts,
      connection: "reachable",
      lastCommunicationAt: new Date().toISOString(),
    };
  }
}

function emptyObservation(matterNodeId: string, connection: ObservedNode["connection"]): ObservedNode {
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
    connection,
    lastCommunicationAt: null,
  };
}

export function mapCommissionError(error: unknown): MatterOperationError {
  if (error instanceof MatterOperationError) return error;
  const message = safeMessage(error);
  if (/fabric/i.test(message) && /(full|limit|no space|too many|busy)/i.test(message)) {
    return new MatterOperationError(
      "fabric_limit",
      "The device cannot accept another fabric. IoT.Edu did not factory reset it and did not remove the Apple Home fabric. An existing administrator can remove a different fabric or open a new commissioning window.",
    );
  }
  if (/not found|discover|no device|mdns/i.test(message)) {
    return new MatterOperationError(
      "discovery_failed",
      `The device was not discovered on the local network. ${message} Open pairing mode in Apple Home again. IoT.Edu did not change the Apple Home fabric or the Thread dataset.`,
    );
  }
  if (/\bcase\b/i.test(message)) {
    return new MatterOperationError(
      "connection_failed",
      `The operational CASE session was not established. ${message} No node record is stored unless Basic Information is read. Open pairing mode again if the window closed. IoT.Edu did not remove the Apple Home fabric.`,
    );
  }
  if (/expir|commissioning window|pase|passcode|timeout/i.test(message)) {
    return new MatterOperationError(
      "commissioning_window_expired",
      `The Apple Home pairing code expired or the commissioning window closed. ${message} In the Home app, turn pairing mode on again and paste the new code. Do not factory-reset the accessory.`,
    );
  }
  return new MatterOperationError(
    "connection_failed",
    `Commissioning did not finish. ${message} The accessory was not factory reset, and the Apple Home fabric was not removed.`,
  );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The Matter controller reported a failure.";
  return redactSecrets(message);
}

function installRedactingLog(logger: { level: unknown; destinations: { default?: { write: (text: string, message: never) => void; ioteduRedacted?: boolean } } }, warn: unknown): void {
  logger.level = warn;
  const destination = logger.destinations.default;
  if (!destination || destination.ioteduRedacted) return;
  const write = destination.write.bind(destination);
  destination.write = ((text: string, message: never) => {
    write(redactSecrets(text), message);
  }) as typeof destination.write;
  destination.ioteduRedacted = true;
}

function bytesToHex(value: unknown): string | null {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return null;
}

function idText(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0 && value !== "[object Object]") return value;
  if (value && typeof value === "object" && "id" in value) return idText((value as { id: unknown }).id);
  if (value && typeof value === "object" && Symbol.toPrimitive in Object.getPrototypeOf(value)) {
    const text = String(value);
    return text && text !== "[object Object]" ? text : null;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    return numberOrNull((value as { value: unknown }).value);
  }
  if (value && typeof value === "object" && "valueOf" in value) {
    const primitive = value.valueOf();
    if (primitive !== value) return numberOrNull(primitive);
  }
  return null;
}

async function storageHasKeys(directory: string): Promise<boolean> {
  try {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(directory);
    return names.some((name) => name !== IDENTITY_FILE && name !== "matter-config.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasStoredAddress(peer: RemotePeer): boolean {
  return Array.isArray(peer.state?.commissioning?.addresses) && peer.state.commissioning.addresses.length > 0;
}

function sessionReady(peer: RemotePeer): boolean {
  return peer.lifecycle.isOnline === true || peer.lifecycle.isConnected === true;
}

async function* asReports(chunk: unknown): AsyncIterable<unknown> {
  if (chunk && typeof chunk === "object" && Symbol.asyncIterator in chunk) {
    yield* chunk as AsyncIterable<unknown>;
    return;
  }
  if (Array.isArray(chunk)) {
    for (const report of chunk) yield report;
    return;
  }
  if (chunk != null) yield chunk;
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function matterJsVersion(): string {
  return MATTER_JS_VERSION;
}
