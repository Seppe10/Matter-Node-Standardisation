import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { BuildJob, EraseAssessment, EraseRequest, EraseSession, FlashBackupRecord, HardwareInstallation, ProgramRequest, ProgramSession } from "@iotedu/contracts";
import { FACTORY_RESET_WATCH_MAX_SECONDS, FACTORY_RESET_WATCH_MIN_SECONDS, FACTORY_RESET_WATCH_SECONDS, assessFactoryResetCapture, commissioningFromLog, commissioningOverlayFromReset, currentCommissioningLog, factoryResetConsoleRecovery, firmwareStartupStages, installationIdentity, macFromDeviceLog, readAdvertisedOnboarding, readDeviceOnboarding, readElfSha256Prefix, startupCheckStatus, usesCompiledTestDiscriminator, verifyOnboarding, type FactoryResetAssessment, type OnboardingVerification } from "@iotedu/contracts";
import {
  archiveBackup,
  assessEraseReadiness,
  createFlashBackup,
  findBackup,
  flashBackupRoot,
  inspectPackageForRecovery,
  latestBackupForMac,
  parseDeviceEvidence,
  parsePartitionTable,
  samplesAreBlank,
  sha256,
  type PackageReadiness,
} from "@iotedu/firmware-builder/recovery";
import {
  buildWritePlan,
  chipConnectionFailure,
  createFlashIo,
  flashProgressPercent,
  isAllowedSerialPort,
  listSerialPorts,
  FLASH_VERIFIED_BOOT_PENDING,
  bootListenSettled,
  bootResultMessage,
  firmwareConsole,
  installationSummary,
  PORT_REAPPEAR_FAILED,
  packageProgrammingBlock,
  flashImagesFromPlan,
  readAppElfSha256,
  redactSerialLog,
  runApplicationReset,
  runSerialMonitor,
  probeChip,
  runUsbWrite,
  startupChecks,
  type FlashArguments,
  type FlashIo,
  type FlashPlan,
  type UsbRunnerResult,
  type UsbRunnerSpec,
} from "@iotedu/firmware-builder/programmer";
import { loadReferenceLayout, sdkconfigValue, type BoardProfile, type ToolchainInspection } from "@iotedu/firmware-builder";
import { classifyHostSerialPorts, serialPortOccupants, type ClassifiedSerialPort, type PortOccupant } from "@iotedu/firmware-builder/usb-ports";
import type { BuildRepository } from "./store.js";
import { JsonJobRepository } from "./store.js";
import { installationFromStoredOnboarding, keepDistinctPasscode, mergeStoredOnboarding, onboardingFromSession, retainProgramSessions, verifiedDevelopmentOnboarding, type StoredDeviceOnboarding } from "./session-history.js";
import { FirmwareArtifactError, firmwareArchiveDir, openFirmwarePackage, readFirmwareArtifact } from "./firmware-artifacts.js";

function parseConfigId(value: string | null): number | null {
  if (!value) return null;
  const parsed = /^0x/i.test(value) ? Number.parseInt(value, 16) : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function matterStartupFromLog(log: string, _storedPassed: boolean): "started" | "failed" | "unknown" {
  const failure = Math.max(log.lastIndexOf("Failed to register the RGB light"), log.lastIndexOf("Failed to start Matter"), log.lastIndexOf("Failed to create Matter node"), log.lastIndexOf("Failed to prepare the Matter core"), log.lastIndexOf("Failed to init server"));
  const started = Math.max(log.lastIndexOf("Server Listening"), log.lastIndexOf("Fabric already commissioned"), log.lastIndexOf("Existing Matter fabric count"), log.lastIndexOf("SetupQRCode:"), log.lastIndexOf("CHIPoBLE advertising started"), log.lastIndexOf("Commissioning window opened"));
  if (failure >= 0 && failure > started) return "failed";
  if (started >= 0) return "started";
  return "unknown";
}

function installationRank(record: HardwareInstallation): number {
  return Number(record.versionVerified) + Number(record.matterReady) + Number(record.bootVerified) + Number(record.writeCompleted);
}

export function selectCurrentInstallation(existing: HardwareInstallation, incoming: HardwareInstallation): HardwareInstallation {
  const newer = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const firmware = installationRank(incoming) === installationRank(existing)
    ? newer
    : installationRank(incoming) > installationRank(existing) ? incoming : existing;
  if (!newer.commissioningObservedAt || newer.sessionId === firmware.sessionId) return firmware;
  return {
    ...firmware,
    commissioningState: newer.commissioningState,
    commissioningWindowOpen: newer.commissioningWindowOpen,
    windowNow: newer.windowNow,
    lastWindowEvent: newer.lastWindowEvent,
    bleAdvertisingObserved: newer.bleAdvertisingObserved,
    dnsSdWarning: newer.dnsSdWarning,
    appleHomeFabric: newer.appleHomeFabric,
    fabricVendors: newer.fabricVendors,
    commissioningDetail: newer.commissioningDetail,
    commissioningObservedAt: newer.commissioningObservedAt,
    macSource: newer.macSource ?? firmware.macSource,
  };
}

export class ProgrammerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export type UsbRunner = (spec: UsbRunnerSpec) => Promise<UsbRunnerResult>;
export type MonitorRunner = typeof runSerialMonitor;
export type PortLister = () => Promise<string[]>;
export type ChipProbe = typeof probeChip;
export type AppReset = typeof runApplicationReset;
export type OccupantLookup = (port: string) => Promise<PortOccupant[]>;
export type PortClassifier = (ports: string[]) => Promise<ClassifiedSerialPort[]>;

export interface ProgrammerOptions {
  toolchain?: ToolchainInspection;
  flashIo?: FlashIo;
  backupRoot?: string;
  archiveDir?: string;
  appReset?: AppReset;
  occupants?: OccupantLookup;
  classifyPorts?: PortClassifier;
}

const REQUIRED = ["bootloader.bin", "sensors.bin", "partition-table.bin", "ota_data_initial.bin", "usb-image.bin", "flasher_args.json"];

function clip(text: string): string {
  if (text.length <= 20_000) return text;
  return `${text.slice(0, 4_000)}\nnote: earlier monitor text clipped\n${text.slice(-16_000)}`;
}

interface StoredFactoryResetWatch {
  id: string;
  consolePort: string;
  selectedMac: string | null;
  observedAt: string;
  watchSeconds: number;
  disconnected: boolean;
  text: string;
}

export class LocalProgrammerService {
  private readonly sessions: JsonJobRepository<ProgramSession>;
  private readonly onboarding: JsonJobRepository<StoredDeviceOnboarding>;
  private readonly eraseSessions: JsonJobRepository<EraseSession>;
  private readonly factoryResets: JsonJobRepository<StoredFactoryResetWatch>;
  private readonly running = new Map<string, AbortController>();
  private readonly monitors = new Map<string, AbortController>();
  private readonly portStops = new Map<string, AbortController>();
  private readonly ports = new Map<string, string>();
  private readonly toolchain: ToolchainInspection;
  private readonly flashIo: FlashIo;
  private readonly backupRoot: string;
  private readonly appReset: AppReset;
  private readonly occupants: OccupantLookup;
  private readonly classifyPorts: PortClassifier;
  private readonly archiveDirectory: string;
  private saveChain: Promise<void> = Promise.resolve();
  private logChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly builds: BuildRepository,
    private readonly dataDir: string,
    private readonly repoRoot: string,
    private readonly profile: BoardProfile,
    private readonly nativeAvailable: boolean,
    private readonly runWrite: UsbRunner = runUsbWrite,
    private readonly runMonitor: MonitorRunner = runSerialMonitor,
    private readonly listPorts: PortLister = listSerialPorts,
    private readonly identifyChip: ChipProbe = probeChip,
    options: ProgrammerOptions = {},
  ) {
    this.sessions = new JsonJobRepository(path.join(dataDir, "programmer-sessions.json"), {
      tolerant: true,
      retain: (items) => retainProgramSessions(items),
      beforeWrite: (items) => this.rememberOnboarding(items),
    });
    this.onboarding = new JsonJobRepository(path.join(dataDir, "device-onboarding.json"), { tolerant: true });
    this.eraseSessions = new JsonJobRepository(path.join(dataDir, "erase-sessions.json"));
    this.factoryResets = new JsonJobRepository(path.join(dataDir, "factory-reset-observations.json"));
    const hostPorts = listPorts === listSerialPorts;
    this.appReset = options.appReset ?? runApplicationReset;
    this.occupants = options.occupants ?? (hostPorts ? serialPortOccupants : async () => []);
    this.classifyPorts = options.classifyPorts ?? (hostPorts
      ? classifyHostSerialPorts
      : async (ports) => ports.map((port) => ({ path: port, role: "unknown" as const, label: "USB serial" })));
    this.archiveDirectory = options.archiveDir ?? firmwareArchiveDir();
    this.toolchain = options.toolchain ?? {
      nativeAvailable,
      programmingAvailable: nativeAvailable,
      programmingCode: nativeAvailable ? "ok" : "toolchain_not_installed",
      idfPathConfigured: nativeAvailable,
      espMatterPathConfigured: nativeAvailable,
      activateConfigured: nativeAvailable,
      source: nativeAvailable ? "environment" : "incomplete",
      detail: nativeAvailable
        ? "ESP-IDF v5.4.1 is available to this application."
        : "ESP-IDF v5.4.1 was not found. Install it with Espressif EIM, or set IDF_PATH, ESP_MATTER_PATH, and IDF_ACTIVATE.",
      childEnv: process.env,
    };
    this.flashIo = options.flashIo ?? createFlashIo(repoRoot, this.toolchain.childEnv);
    this.backupRoot = options.backupRoot ?? flashBackupRoot(homedir());
  }

  async recoverInterrupted(): Promise<void> {
    for (const session of await this.sessions.list()) {
      if (session.status !== "running") continue;
      session.status = "interrupted";
      session.stage = "idle";
      session.nvsPreserved = true;
      session.eraseAll = false;
      session.hardwareVerified = false;
      session.message = "The write was interrupted because the application restarted. Device contents are unknown. The package files were not deleted.";
      session.logs = [...session.logs, session.message];
      session.checks = startupChecks({
        writeLog: session.logs.join("\n"),
        monitorLog: session.monitorLog,
        versionString: session.softwareVersionString,
        writeStatus: session.status,
      });
      session.updatedAt = new Date().toISOString();
      await this.sessions.save(session);
    }
    await this.pruneSessionHistory();
    for (const session of await this.eraseSessions.list()) {
      if (session.status !== "running") continue;
      session.status = "interrupted";
      session.verifiedBlank = false;
      session.needsFirmware = false;
      session.hardwareVerified = false;
      session.message = "The erase was interrupted because the application restarted. Flash contents are unknown. The backup was not deleted.";
      session.updatedAt = new Date().toISOString();
      await this.eraseSessions.save(session);
    }
  }

  async list(): Promise<ProgramSession[]> {
    const sessions = await this.sessions.list();
    return Promise.all(sessions.map((session) => this.withFlashImages(session)));
  }

  async get(id: string): Promise<ProgramSession | null> {
    const session = await this.sessions.get(id);
    return session ? this.withFlashImages(session) : null;
  }

  async listInstallations(): Promise<HardwareInstallation[]> {
    const sessions = await this.sessions.list();
    const ranked = new Map<string, HardwareInstallation>();
    for (const session of [...sessions].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))) {
      if (session.status !== "succeeded" && session.status !== "failed" && session.status !== "interrupted") continue;
      const record = await this.installationFromSession(session);
      const key = record.mac ?? `session:${record.sessionId}`;
      const existing = ranked.get(key);
      ranked.set(key, existing ? selectCurrentInstallation(existing, record) : record);
    }
    const observations = await this.factoryResets.list();
    for (const [key, record] of ranked) {
      if (!record.mac) continue;
      const latest = observations
        .filter((item) => item.selectedMac == null || item.selectedMac.toLowerCase() === record.mac)
        .map((item) => ({ item, assessment: assessFactoryResetCapture(item.text, record.mac) }))
        .filter((item) => item.assessment.mac === record.mac && item.item.observedAt >= (record.commissioningObservedAt ?? ""))
        .sort((left, right) => right.item.observedAt.localeCompare(left.item.observedAt))[0];
      const overlay = latest ? commissioningOverlayFromReset(latest.assessment) : null;
      if (!latest || !overlay) continue;
      const refreshed = latest.assessment.stage === "verified_fabric_free" || latest.assessment.stage === "fabric_still_present"
        ? await this.onboardingForBuild(record.buildId, record.softwareVersion, record.softwareVersionString, record.vendorId, record.productId, latest.item.text)
        : null;
      ranked.set(key, {
        ...record,
        commissioningState: overlay.state,
        commissioningWindowOpen: overlay.windowOpen,
        windowNow: overlay.windowNow,
        lastWindowEvent: overlay.lastWindowEvent,
        bleAdvertisingObserved: overlay.bleAdvertisingObserved,
        dnsSdWarning: overlay.dnsSdWarning,
        appleHomeFabric: overlay.appleHomeFabric,
        fabricVendors: overlay.fabricVendors,
        commissioningDetail: overlay.detail,
        commissioningObservedAt: latest.item.observedAt,
        updatedAt: latest.item.observedAt > record.updatedAt ? latest.item.observedAt : record.updatedAt,
        ...(refreshed ? {
          onboardingStatus: refreshed.status,
          onboardingReason: refreshed.reason,
          onboardingPayload: refreshed.payload,
          firmwareImageIdentity: refreshed.imageIdentity,
          discriminatorEvidence: refreshed.discriminatorEvidence,
        } : {}),
      });
    }
    const stored = await this.onboarding.list();
    for (const record of stored) {
      const key = [...ranked.keys()].find((candidate) => candidate.toLowerCase() === record.id);
      const existing = key ? ranked.get(key) : undefined;
      if (existing) {
        if (!existing.deviceOnboarding) {
          ranked.set(key ?? record.id, {
            ...existing,
            deviceOnboarding: { qrPayload: record.qrPayload, manualCode: record.manualCode },
            vendorId: existing.vendorId ?? record.vendorId,
            productId: existing.productId ?? record.productId,
          });
        }
        continue;
      }
      ranked.set(record.id, installationFromStoredOnboarding(record));
    }
    return [...ranked.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async rememberOnboarding(sessions: ProgramSession[]): Promise<void> {
    const remembered = sessions.flatMap((session) => {
      const record = onboardingFromSession(session);
      return record ? [record] : [];
    });
    const developed = (await Promise.all(sessions.map((session) => this.developmentOnboardingRecord(session)))).flatMap((record) => record ? [record] : []);
    if (remembered.length === 0 && developed.length === 0) return;
    const current = await this.onboarding.list();
    let merged = mergeStoredOnboarding(current, remembered);
    for (const record of developed) merged = keepDistinctPasscode(merged, record);
    const unchanged = merged.length === current.length && merged.every((item, index) => item.id === current[index]?.id && item.qrPayload === current[index]?.qrPayload && item.manualCode === current[index]?.manualCode);
    if (!unchanged) await this.onboarding.replace(merged);
  }

  private async pruneSessionHistory(): Promise<void> {
    const sessions = await this.sessions.list();
    await this.rememberOnboarding(sessions);
    const kept = retainProgramSessions(sessions);
    if (kept.length !== sessions.length) await this.sessions.replace(kept);
  }

  portsAvailable(): Promise<string[]> {
    return this.listPorts();
  }

  async portDetails(): Promise<ClassifiedSerialPort[]> {
    const available = (await this.listPorts()).filter((port) => isAllowedSerialPort(port));
    const devices = await this.classifyPorts(available);
    return Promise.all(devices.map(async (device) => {
      const occupants = await this.occupants(device.path);
      const ownedByApplication = this.ports.has(device.path) || occupants.some((item) => item.pid === process.pid);
      return {
        ...device,
        occupants,
        ownedByApplication,
        busy: ownedByApplication || occupants.length > 0,
      };
    }));
  }

  releaseOwnedConsole(port: string): { released: true; message: string } {
    if (!isAllowedSerialPort(port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    const owner = this.ports.get(port);
    let released = false;
    if (owner === "console") {
      this.portStops.get(port)?.abort();
      released = true;
    }
    if (owner && this.monitors.has(owner)) {
      this.monitors.get(owner)?.abort();
      released = true;
    }
    if (!released) {
      throw new ProgrammerError("IoT.Edu does not have a console session on this port. The other program was left running.", 409, "port_not_owned");
    }
    return { released: true, message: "The IoT.Edu console session was stopped. Other programs were left running." };
  }

  verifyStoredBackup(mac: string): Promise<FlashBackupRecord | null> {
    return latestBackupForMac(this.backupRoot, mac);
  }

  private get programmingAvailable(): boolean {
    return this.toolchain.programmingAvailable;
  }

  async probe(port: string): Promise<{ port: string; accepted: boolean; detail: string; failure: ReturnType<typeof chipConnectionFailure> }> {
    if (!isAllowedSerialPort(port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    const devices = await this.portDetails();
    const selected = devices.find((device) => device.path === port);
    if (!selected) {
      const programming = devices.find((device) => device.role === "programming");
      throw new ProgrammerError(
        programming
          ? `The selected programming port is no longer present. A programming interface is available at ${programming.path}. Detect devices again and select it.`
          : "The selected programming port is no longer present. Reconnect the board and detect devices again.",
        400,
        "port_missing",
      );
    }
    if (selected.role === "console") {
      throw new ProgrammerError("That port is the UART console. Select the ESP32-H2 programming interface. The console session was left running.", 400, "console_port");
    }
    if (selected.busy && !selected.ownedByApplication) {
      const holder = selected.occupants?.[0];
      throw new ProgrammerError(
        holder
          ? `The programming port is open in ${holder.command} (process ${holder.pid}). Close that program and detect devices again.`
          : "The programming port is open in another program. Close that program and detect devices again.",
        409,
        "port_busy",
      );
    }
    if (!this.programmingAvailable) {
      throw new ProgrammerError(this.toolchain.detail, 400, this.toolchain.programmingCode);
    }
    if (this.ports.has(port)) {
      throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
    }
    this.ports.set(port, "probe");
    try {
      const result = await this.identifyChip({ repoRoot: this.repoRoot, port, env: this.toolchain.childEnv, includeFlashSize: true });
      const detail = result.text || (result.accepted
        ? "ESP32-H2 responded."
        : "The connected chip did not respond.");
      return { port, accepted: result.accepted, failure: result.failure, detail };
    } finally {
      this.ports.delete(port);
    }
  }

  async captureConsole(port: string, seconds = 6): Promise<{ port: string; text: string; erasePerformed: false }> {
    if (!isAllowedSerialPort(port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    const available = await this.listPorts();
    if (!available.includes(port)) {
      throw new ProgrammerError("That serial port is not currently connected.", 400, "port_missing");
    }
    if (!this.programmingAvailable) {
      throw new ProgrammerError(this.toolchain.detail, 400, this.toolchain.programmingCode);
    }
    if (this.ports.has(port)) {
      throw new ProgrammerError("This device already has a write or monitor in progress. Close it before opening the console.", 409, "port_busy");
    }
    const bounded = Math.min(8, Math.max(2, Math.round(seconds)));
    this.ports.set(port, "console");
    const controller = new AbortController();
    this.portStops.set(port, controller);
    const timer = setTimeout(() => controller.abort(), bounded * 1000);
    const lines: string[] = [];
    try {
      await this.runMonitor({
        repoRoot: this.repoRoot,
        port,
        signal: controller.signal,
        env: this.toolchain.childEnv,
        onLog: (line) => lines.push(redactSerialLog(line)),
      });
    } finally {
      clearTimeout(timer);
      if (this.portStops.get(port) === controller) this.portStops.delete(port);
      this.ports.delete(port);
    }
    return { port, text: clip(lines.join("\n")), erasePerformed: false };
  }

  async watchFactoryReset(port: string, seconds = FACTORY_RESET_WATCH_SECONDS, selectedMac: string | null = null): Promise<{
    port: string;
    text: string;
    erasePerformed: false;
    watchSeconds: number;
    disconnected: boolean;
    followedNewPort: false;
    assessment: FactoryResetAssessment;
    observedAt: string;
  }> {
    if (!isAllowedSerialPort(port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    const available = await this.listPorts();
    if (!available.includes(port)) {
      throw new ProgrammerError("That serial port is not currently connected.", 400, "port_missing");
    }
    if (!this.programmingAvailable) {
      throw new ProgrammerError(this.toolchain.detail, 400, this.toolchain.programmingCode);
    }
    if (this.ports.has(port)) {
      throw new ProgrammerError("This device already has a write or monitor in progress. Close it before opening the console.", 409, "port_busy");
    }
    const bounded = Math.min(FACTORY_RESET_WATCH_MAX_SECONDS, Math.max(FACTORY_RESET_WATCH_MIN_SECONDS, Math.round(seconds)));
    this.ports.set(port, "console");
    const controller = new AbortController();
    this.portStops.set(port, controller);
    const timer = setTimeout(() => controller.abort(), bounded * 1000);
    const lines: string[] = [];
    let failed: Error | null = null;
    try {
      await this.runMonitor({
        repoRoot: this.repoRoot,
        port,
        signal: controller.signal,
        env: this.toolchain.childEnv,
        onLog: (line) => {
          lines.push(redactSerialLog(line));
          if (assessFactoryResetCapture(lines.join("\n"), selectedMac).conclusive) controller.abort();
        },
      });
    } catch (error) {
      failed = error instanceof Error ? error : new Error("The factory-reset watch failed");
    } finally {
      clearTimeout(timer);
      if (this.portStops.get(port) === controller) this.portStops.delete(port);
      this.ports.delete(port);
    }
    const portsNow = await this.listPorts().catch(() => []);
    const recovery = factoryResetConsoleRecovery({ watchedPort: port, portsNow });
    if (failed && !recovery.disconnected) throw failed;
    const text = clip(lines.join("\n"));
    const assessment = assessFactoryResetCapture(text, selectedMac);
    const observedAt = new Date().toISOString();
    await this.factoryResets.save({
      id: randomUUID(),
      consolePort: port,
      selectedMac: selectedMac?.toLowerCase() ?? null,
      observedAt,
      watchSeconds: bounded,
      disconnected: recovery.disconnected,
      text,
    });
    return {
      port,
      text,
      erasePerformed: false,
      watchSeconds: bounded,
      disconnected: recovery.disconnected,
      followedNewPort: false,
      assessment,
      observedAt,
    };
  }

  async describeWrite(buildId: string, port: string): Promise<{
    buildId: string;
    softwareVersion: number;
    softwareVersionString: string;
    regions: Array<{ offset: string; artifact: string; bytes: number }>;
    preserved: string[];
  }> {
    await this.rejectUnusablePackage(buildId);
    if (!isAllowedSerialPort(port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    const available = await this.listPorts();
    if (!available.includes(port)) {
      throw new ProgrammerError("That serial port is not currently connected.", 400, "port_missing");
    }
    const { job, plan } = await this.preparePlan(buildId, port);
    try {
      if (!plan.ok) {
        throw new ProgrammerError(plan.issues[0]?.message ?? "The package is not safe to write.", 400, plan.issues[0]?.code ?? "layout_rejected");
      }
      return {
        buildId: job.id,
        softwareVersion: job.request.softwareVersion,
        softwareVersionString: job.request.softwareVersionString,
        regions: plan.regions,
        preserved: ["nvs", "nvs_keys", "fctry", "esp_secure_cert", "phy_init"],
      };
    } finally {
      await plan.cleanup();
    }
  }

  async start(input: ProgramRequest): Promise<ProgramSession> {
    await this.rejectUnusablePackage(input.buildId);
    if (input.intent === "commissioned_maintenance" && input.acknowledgeCommissioned !== true) {
      throw new ProgrammerError(
        "Updating a commissioned node over USB needs an extra confirmation. This is not a Matter OTA update.",
        400,
        "confirmation_required",
      );
    }
    if (!isAllowedSerialPort(input.port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    const available = await this.listPorts();
    if (!available.includes(input.port)) {
      throw new ProgrammerError("That serial port is not currently connected.", 400, "port_missing");
    }
    if (!this.programmingAvailable) {
      throw new ProgrammerError(this.toolchain.detail, 400, this.toolchain.programmingCode);
    }
    if (this.ports.has(input.port)) {
      throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
    }
    const { job, plan } = await this.preparePlan(input.buildId, input.port);
    if (!plan.ok) {
      await plan.cleanup();
      throw new ProgrammerError(plan.issues[0]?.message ?? "The package is not safe to write.", 400, plan.issues[0]?.code ?? "layout_rejected");
    }

    const now = new Date().toISOString();
    const session: ProgramSession = {
      id: randomUUID(),
      buildId: job.id,
      port: input.port,
      intent: input.intent,
      status: "running",
      stage: "writing",
      progressPercent: 0,
      logs: [
        `Writing ${job.request.softwareVersionString} to ${input.port}.`,
        "NVS, factory data, and the secure-cert partition are not erased. Full-chip erase is not available.",
      ],
      monitorLog: "",
      checks: [],
      message: "Writing the compiled image.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: job.request.softwareVersionString,
      createdAt: now,
      updatedAt: now,
    };
    session.checks = this.checksFor(session);
    this.ports.set(input.port, session.id);
    try {
      await this.sessions.save(session);
    } catch (error) {
      if (this.ports.get(input.port) === session.id) this.ports.delete(input.port);
      await plan.cleanup();
      throw error;
    }
    void this.execute(session, plan.regions, plan.args, plan.cleanup);
    return session;
  }

  async cancel(id: string): Promise<ProgramSession | null> {
    const session = await this.sessions.get(id);
    if (!session) return null;
    this.running.get(id)?.abort();
    this.monitors.get(id)?.abort();
    if (session.stage === "monitoring") {
      session.stage = "idle";
      session.monitorLog = clip(`${session.monitorLog}\nnote: serial monitor closed`);
      session.checks = this.checksFor(session);
      if (session.status === "succeeded") session.message = bootResultMessage(session.monitorLog, session.checks, session.status) ?? session.message;
      session.updatedAt = new Date().toISOString();
      await this.persist(session);
    }
    return session;
  }

  async readLog(id: string): Promise<{ status: ProgramSession["status"]; tail: string; progressPercent: number | null } | null> {
    const session = await this.sessions.get(id);
    if (!session) return null;
    const tail = redactSerialLog(session.logs.slice(-200).join("\n"));
    return { status: session.status, tail, progressPercent: session.progressPercent };
  }

  async monitor(id: string): Promise<ProgramSession> {
    const session = await this.sessions.get(id);
    if (!session) throw new ProgrammerError("Programming session not found.", 404, "not_found");
    if (session.status !== "succeeded") {
      throw new ProgrammerError("Open the serial monitor after a write that finished.", 409, "monitor_not_ready");
    }
    if (this.ports.has(session.port) || this.monitors.has(id)) {
      throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
    }
    const controller = new AbortController();
    this.monitors.set(id, controller);
    this.ports.set(session.port, id);
    session.stage = "monitoring";
    session.monitorLog = clip(`${session.monitorLog}\nnote: serial monitor opened at 115200`);
    session.message = "Serial monitor is open. Startup checks stay unknown until the log shows them.";
    session.checks = this.checksFor(session);
    session.updatedAt = new Date().toISOString();
    await this.cacheOnboarding(session);
    await this.persist(session);
    void this.captureMonitor(session, controller);
    return session;
  }

  async saveLog(id: string): Promise<{ bytes: number }> {
    const session = await this.sessions.get(id);
    if (!session) throw new ProgrammerError("Programming session not found.", 404, "not_found");
    const redacted = redactSerialLog(session.monitorLog);
    if (!redacted.trim()) throw new ProgrammerError("There is no serial log to save.", 409, "log_empty");
    session.savedSerialLog = redacted.endsWith("\n") ? redacted : `${redacted}\n`;
    session.updatedAt = new Date().toISOString();
    await this.sessions.save(session);
    return { bytes: Buffer.byteLength(session.savedSerialLog) };
  }

  async savedLog(id: string): Promise<string | null> {
    const session = await this.sessions.get(id);
    const saved = session?.savedSerialLog?.trim();
    return saved ? session?.savedSerialLog ?? null : null;
  }

  private async rejectUnusablePackage(buildId: string): Promise<BuildJob> {
    const job = await this.builds.get(buildId);
    if (!job) throw new ProgrammerError("Build not found.", 404, "not_found");
    const blocked = packageProgrammingBlock(job);
    if (blocked) throw new ProgrammerError(blocked.message, blocked.code === "simulated_package" ? 409 : 400, blocked.code);
    return job;
  }

  private async preparePlan(buildId: string, port: string): Promise<{ job: BuildJob; plan: FlashPlan & { cleanup: () => Promise<void> } }> {
    const job = await this.rejectUnusablePackage(buildId);
    let opened: { directory: string; cleanup: () => Promise<void> };
    try {
      opened = await openFirmwarePackage({
        dataDir: this.dataDir,
        archiveDir: this.archiveDirectory,
        buildId: job.id,
        files: REQUIRED.map((name) => {
          const artifact = job.artifacts.find((item) => item.name === name);
          return { name, relativePath: artifact?.relativePath, expectedSha256: artifact?.sha256 };
        }),
      });
    } catch (error) {
      if (error instanceof FirmwareArtifactError) throw new ProgrammerError(error.message, 400, error.code);
      throw error;
    }
    try {
      const files: Record<string, Buffer> = {};
      for (const name of REQUIRED) {
        if (name === "flasher_args.json") continue;
        files[name] = await readFile(path.join(opened.directory, name));
      }
      const flasher = JSON.parse(await readFile(path.join(opened.directory, "flasher_args.json"), "utf8")) as FlashArguments;
      const layout = await loadReferenceLayout(this.repoRoot, this.profile);
      const plan = buildWritePlan({
        flasher,
        artifactDir: opened.directory,
        port,
        partitions: layout.partitions,
        bootloaderOffset: this.profile.bootloaderOffset,
        partitionTableOffset: this.profile.partitionTableOffset,
        flashSizeBytes: this.profile.flashSizeBytes,
        files,
      });
      return { job, plan: { ...plan, cleanup: opened.cleanup } };
    } catch (error) {
      await opened.cleanup();
      throw error;
    }
  }

  private async readPackageBytes(job: BuildJob, name: string, verify: boolean): Promise<Buffer> {
    const artifact = job.artifacts.find((item) => item.name === name);
    try {
      const resolved = await readFirmwareArtifact({
        dataDir: this.dataDir,
        archiveDir: this.archiveDirectory,
        buildId: job.id,
        name,
        relativePath: artifact?.relativePath,
        expectedSha256: artifact?.sha256,
        verify,
      });
      return resolved.bytes;
    } catch (error) {
      if (error instanceof FirmwareArtifactError) throw new ProgrammerError(error.message, 400, error.code);
      throw error;
    }
  }

  private readonly packageEvidenceCache = new Map<string, Promise<{ elfSha256: string | null; compiledTestDiscriminator: boolean }>>();

  private packageEvidence(buildId: string): Promise<{ elfSha256: string | null; compiledTestDiscriminator: boolean }> {
    const cached = this.packageEvidenceCache.get(buildId);
    if (cached) return cached;
    const pending = this.loadPackageEvidence(buildId);
    this.packageEvidenceCache.set(buildId, pending);
    return pending;
  }

  private async loadPackageEvidence(buildId: string): Promise<{ elfSha256: string | null; compiledTestDiscriminator: boolean }> {
    const job = await this.builds.get(buildId);
    if (!job) return { elfSha256: null, compiledTestDiscriminator: false };
    try {
      const sdkconfig = await this.readPackageBytes(job, "sdkconfig", false);
      const application = await this.readPackageBytes(job, "sensors.bin", false);
      return {
        elfSha256: readAppElfSha256(application),
        compiledTestDiscriminator: usesCompiledTestDiscriminator(sdkconfig.toString("utf8")),
      };
    } catch {
      return { elfSha256: null, compiledTestDiscriminator: false };
    }
  }

  private async onboardingForBuild(
    buildId: string,
    softwareVersion: number | null,
    softwareVersionString: string | null,
    vendorId: number | null,
    productId: number | null,
    log: string,
  ): Promise<OnboardingVerification> {
    const evidence = await this.packageEvidence(buildId);
    const scoped = currentCommissioningLog(log);
    const text = scoped.resetWithoutBoot ? "" : scoped.text || log;
    const advertised = readAdvertisedOnboarding(text);
    return verifyOnboarding({
      softwareVersion,
      softwareVersionString,
      vendorId,
      productId,
      advertisedDiscriminator: advertised.discriminator,
      discriminatorRedacted: advertised.redacted,
      advertisedVendorId: advertised.vendorId,
      advertisedProductId: advertised.productId,
      imageSha256Prefix: readElfSha256Prefix(text),
      packageElfSha256: evidence.elfSha256,
      usesCompiledTestDiscriminator: evidence.compiledTestDiscriminator,
    });
  }

  private async installationFromSession(session: ProgramSession): Promise<HardwareInstallation> {
    const job = await this.builds.get(session.buildId);
    let vendorId: number | null = null;
    let productId: number | null = null;
    if (job) {
      try {
        const sdkconfig = (await this.readPackageBytes(job, "sdkconfig", false)).toString("utf8");
        vendorId = parseConfigId(sdkconfigValue(sdkconfig, "CONFIG_DEVICE_VENDOR_ID"));
        productId = parseConfigId(sdkconfigValue(sdkconfig, "CONFIG_DEVICE_PRODUCT_ID"));
      } catch {
        vendorId = null;
        productId = null;
      }
    }
    const identified = installationIdentity({
      log: `${session.logs.join("\n")}\n${session.monitorLog}`,
      storedMac: session.baseMac ?? null,
      recordedAt: session.updatedAt,
    });
    const conflictingMac = identified.conflict;
    const mac = identified.mac;
    const macSource = identified.source;
    const commissioning = conflictingMac
      ? {
          state: "unknown" as const,
          windowOpen: null,
          windowNow: "unknown" as const,
          lastWindowEvent: null,
          bleAdvertisingObserved: false,
          dnsSdWarning: null,
          appleHomeFabric: false,
          fabricVendors: [],
          detail: "The programming identity and the boot log name different MAC addresses, so this session cannot verify either board.",
        }
      : commissioningFromLog(session.monitorLog);
    const computed = await this.onboardingForBuild(
      session.buildId,
      job?.request.softwareVersion ?? null,
      session.softwareVersionString,
      vendorId,
      productId,
      session.monitorLog,
    );
    const onboarding = conflictingMac
      ? {
          ...computed,
          status: "not_verified" as const,
          reason: "Onboarding Payload — Not Verified. This log is not tied to one physical MAC.",
          payload: "unknown" as const,
          imageIdentity: "unknown" as const,
          discriminatorEvidence: "absent" as const,
        }
      : session.onboardingCheck?.status === "verified" && session.onboardingCheck.discriminatorMatched === true && computed.imageIdentity !== "mismatch"
        ? { ...computed, status: "verified" as const, reason: session.onboardingCheck.reason, discriminatorMatched: true, discriminatorEvidence: "live_match" as const, payload: "consistent" as const, payloadConsistent: true }
        : computed;
    const enriched = await this.withFlashImages(session);
    const checks = session.checks;
    const matterStartup = matterStartupFromLog(session.monitorLog, startupCheckStatus(checks, "matter") === "passed");
    const started = Date.parse(session.createdAt);
    const finished = Date.parse(session.updatedAt);
    return {
      mac,
      macSource,
      identityDetail: identified.detail,
      programmingPort: session.port,
      consolePort: session.consolePort ?? null,
      buildId: session.buildId,
      sessionId: session.id,
      softwareVersion: job?.request.softwareVersion ?? null,
      softwareVersionString: session.softwareVersionString,
      vendorId,
      productId,
      writeCompleted: session.status === "succeeded",
      bootVerified: startupCheckStatus(checks, "boot") === "passed",
      matterReady: matterStartup === "started",
      matterStartup,
      nvsPreserved: session.nvsPreserved === true,
      threadReady: startupCheckStatus(checks, "openthread") === "passed",
      versionVerified: startupCheckStatus(checks, "version") === "passed",
      dht11: startupCheckStatus(checks, "dht11"),
      commissioningState: commissioning.state,
      commissioningWindowOpen: commissioning.windowOpen,
      windowNow: commissioning.windowNow,
      lastWindowEvent: commissioning.lastWindowEvent,
      bleAdvertisingObserved: commissioning.bleAdvertisingObserved,
      dnsSdWarning: commissioning.dnsSdWarning,
      appleHomeFabric: commissioning.appleHomeFabric,
      fabricVendors: commissioning.fabricVendors,
      managedNodeId: null,
      commissioningDetail: matterStartup === "failed" && commissioning.state === "unknown"
        ? "The application stopped before Matter started. No fabric and no commissioning window were observed. Preserved NVS was not read or erased."
        : commissioning.detail,
      commissioningObservedAt: session.monitorLog.trim() ? session.updatedAt : null,
      onboardingStatus: onboarding.status,
      onboardingReason: onboarding.reason,
      onboardingPayload: onboarding.payload,
      firmwareImageIdentity: onboarding.imageIdentity,
      discriminatorEvidence: onboarding.discriminatorEvidence,
      deviceOnboarding: (() => {
        const recovered = readDeviceOnboarding(session.monitorLog);
        const qrPayload = session.deviceOnboarding?.qrPayload || recovered.qrPayload || "";
        const manualCode = session.deviceOnboarding?.manualCode || recovered.manualCode || "";
        return qrPayload && manualCode ? { qrPayload, manualCode } : null;
      })(),
      startupStages: firmwareStartupStages({
        writeCompleted: session.status === "succeeded",
        checks,
        monitorLog: session.monitorLog,
      }),
      flashImages: enriched.flashImages ?? [],
      startedAt: session.createdAt,
      elapsedSeconds: Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? Math.round((finished - started) / 1000) : null,
      updatedAt: session.updatedAt,
    };
  }

  private readonly onboardingExpected = new Map<string, { softwareVersion: number; softwareVersionString: string; vendorId: number; productId: number } | null>();

  private async cacheOnboarding(session: ProgramSession): Promise<void> {
    if (this.onboardingExpected.has(session.id)) return;
    const job = await this.builds.get(session.buildId);
    if (!job) {
      this.onboardingExpected.set(session.id, null);
      return;
    }
    let vendorId: number | null = null;
    let productId: number | null = null;
    try {
      const sdkconfig = (await this.readPackageBytes(job, "sdkconfig", false)).toString("utf8");
      vendorId = parseConfigId(sdkconfigValue(sdkconfig, "CONFIG_DEVICE_VENDOR_ID"));
      productId = parseConfigId(sdkconfigValue(sdkconfig, "CONFIG_DEVICE_PRODUCT_ID"));
    } catch {
      vendorId = null;
      productId = null;
    }
    this.onboardingExpected.set(session.id, vendorId == null || productId == null ? null : {
      softwareVersion: job.request.softwareVersion,
      softwareVersionString: session.softwareVersionString,
      vendorId,
      productId,
    });
  }

  private observeAdvertisement(session: ProgramSession, line: string): void {
    const printed = readDeviceOnboarding(line);
    if (printed.qrPayload || printed.manualCode) {
      const current = session.deviceOnboarding;
      const qrPayload = printed.qrPayload ?? current?.qrPayload ?? "";
      const manualCode = printed.manualCode ?? current?.manualCode ?? "";
      if (qrPayload || manualCode) session.deviceOnboarding = { qrPayload, manualCode };
    }
    const advertised = readAdvertisedOnboarding(line);
    if (advertised.discriminator == null && !advertised.redacted) return;
    const expected = this.onboardingExpected.get(session.id) ?? null;
    const check = verifyOnboarding({
      softwareVersion: expected?.softwareVersion ?? null,
      softwareVersionString: expected?.softwareVersionString ?? session.softwareVersionString,
      vendorId: expected?.vendorId ?? null,
      productId: expected?.productId ?? null,
      advertisedDiscriminator: advertised.discriminator,
      discriminatorRedacted: advertised.redacted,
      advertisedVendorId: advertised.vendorId,
      advertisedProductId: advertised.productId,
    });
    session.onboardingCheck = { ...check, checkedAt: new Date().toISOString() };
  }

  private async withFlashImages(session: ProgramSession): Promise<ProgramSession> {
    return { ...session, flashImages: session.flashImages ?? [] };
  }

  private checksFor(session: ProgramSession) {
    return startupChecks({
      writeLog: session.logs.join("\n"),
      monitorLog: session.monitorLog,
      versionString: session.softwareVersionString,
      writeStatus: session.status,
    });
  }

  private persist(session: ProgramSession): Promise<void> {
    session.eraseAll = false;
    session.nvsPreserved = true;
    session.hardwareVerified = false;
    this.saveChain = this.saveChain.then(() => this.sessions.save(session));
    return this.saveChain;
  }

  private note(session: ProgramSession, line: string): void {
    const mac = macFromDeviceLog(line);
    if (mac && /BASE MAC/i.test(line)) session.baseMac = mac;
    const next = [...session.logs, line];
    session.logs = next.length > 48 ? [...next.slice(0, 8), ...next.slice(-40)] : next;
    const percent = flashProgressPercent(line);
    if (percent !== null) session.progressPercent = percent;
    session.checks = this.checksFor(session);
    session.updatedAt = new Date().toISOString();
    this.logChain = this.logChain.then(() => this.persist(session));
  }

  private async execute(
    session: ProgramSession,
    regions: FlashPlan["regions"],
    args: string[],
    cleanup: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    const controller = new AbortController();
    this.running.set(session.id, controller);
    try {
      const result = await this.runWrite({
        repoRoot: this.repoRoot,
        port: session.port,
        writeArgs: args,
        signal: controller.signal,
        env: this.toolchain.childEnv,
        onLog: (line) => this.note(session, line),
      });
      await this.logChain;
      const verified = result.ok && !result.cancelled && !controller.signal.aborted;
      session.flashImages = flashImagesFromPlan(regions, verified);
      if (result.cancelled || controller.signal.aborted) {
        session.status = "interrupted";
        session.message = "The write was cancelled. It is not recorded as a success.";
        this.note(session, session.message);
      } else if (result.ok) {
        session.status = "succeeded";
        session.progressPercent = 100;
        session.message = FLASH_VERIFIED_BOOT_PENDING;
        this.note(session, session.message);
      } else if (result.timedOut) {
        session.status = "interrupted";
        session.message = result.diagnostic ?? "Flash verification timed out. The result is unknown. Review the diagnostic log before retrying.";
        this.note(session, session.message);
      } else {
        session.status = "failed";
        session.message = result.diagnostic ?? "The write failed.";
        this.note(session, session.message);
      }
      session.stage = "idle";
      session.checks = this.checksFor(session);
      session.updatedAt = new Date().toISOString();
      await this.persist(session);
    } catch (error) {
      session.status = "failed";
      session.stage = "idle";
      session.flashImages = session.flashImages ?? flashImagesFromPlan(regions, false);
      session.message = error instanceof Error ? error.message : "The write failed.";
      session.checks = this.checksFor(session);
      session.updatedAt = new Date().toISOString();
      await this.persist(session);
    } finally {
      this.running.delete(session.id);
      if (this.ports.get(session.port) === session.id) this.ports.delete(session.port);
      await cleanup().catch(() => undefined);
    }
  }

  toolchainReport(): { available: boolean; detail: string; source: ToolchainInspection["source"]; code: ToolchainInspection["programmingCode"] } {
    return {
      available: this.programmingAvailable,
      detail: this.toolchain.detail,
      source: this.toolchain.source,
      code: this.programmingAvailable ? "ok" : this.toolchain.programmingCode,
    };
  }

  listEraseSessions(): Promise<EraseSession[]> {
    return this.eraseSessions.list();
  }

  async assessRecovery(input: {
    port: string;
    consolePort?: string | null;
    buildId: string;
    previouslyCommissioned?: boolean;
  }): Promise<EraseAssessment> {
    const ports = await this.listPorts();
    const connected = Boolean(input.port) && isAllowedSerialPort(input.port) && ports.includes(input.port);
    let evidence = null;
    if (connected && this.programmingAvailable) {
      if (input.consolePort && input.consolePort === input.port) {
        evidence = null;
      } else if (this.ports.has(input.port)) {
        throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
      } else {
        this.ports.set(input.port, "recovery");
        try {
          evidence = await this.readEvidence(input.port);
        } finally {
          if (this.ports.get(input.port) === "recovery") this.ports.delete(input.port);
        }
      }
    }
    const backup = evidence?.mac ? await latestBackupForMac(this.backupRoot, evidence.mac) : null;
    const packageReady = await this.packageReadiness(input.buildId, input.port || "/dev/cu.usbmodem0", evidence?.flashSizeBytes ?? null);
    return assessEraseReadiness({
      portConnected: connected,
      port: connected ? input.port : null,
      consolePort: input.consolePort ?? null,
      toolchainAvailable: this.programmingAvailable,
      toolchainDetail: this.toolchain.detail,
      evidence,
      backup,
      packageReady,
      previouslyCommissioned: input.previouslyCommissioned,
    });
  }

  async createRecoveryBackup(input: { port: string; consolePort?: string | null; buildId: string }): Promise<FlashBackupRecord> {
    await this.assertRecoveryPort(input.port, input.consolePort ?? null);
    if (!this.programmingAvailable) {
      throw new ProgrammerError(this.toolchain.detail, 400, this.toolchain.programmingCode);
    }
    if (this.ports.has(input.port)) {
      throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
    }
    this.ports.set(input.port, "recovery");
    try {
      const evidence = await this.readEvidence(input.port);
      if (evidence.chip !== "ESP32-H2" || !evidence.mac || !evidence.flashSizeBytes) {
        throw new ProgrammerError("The chip is not an identified ESP32-H2, so no backup was saved.", 400, "device_unidentified");
      }
      if (!evidence.security.reflashable) {
        throw new ProgrammerError(`${evidence.security.detail} No backup was marked safe for erase.`, 400, "security_blocked");
      }
      const image = await this.flashIo.read(input.port, 0, evidence.flashSizeBytes);
      const repeated = await this.flashIo.read(input.port, 0, 256);
      if (!repeated.equals(image.subarray(0, repeated.length))) {
        throw new ProgrammerError("The flash read did not repeat, so the backup was not saved.", 400, "backup_unverified");
      }
      const packageReady = await this.packageReadiness(input.buildId, input.port, evidence.flashSizeBytes);
      return await createFlashBackup({
        evidence,
        packageReady,
        backupRoot: this.backupRoot,
        buildId: input.buildId,
        image,
      });
    } finally {
      if (this.ports.get(input.port) === "recovery") this.ports.delete(input.port);
    }
  }

  async eraseDevice(input: EraseRequest): Promise<EraseSession> {
    await this.assertRecoveryPort(input.port, input.consolePort ?? null);
    if (!this.programmingAvailable) {
      throw new ProgrammerError(this.toolchain.detail, 400, this.toolchain.programmingCode);
    }
    if (this.ports.has(input.port)) {
      throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
    }
    const now = new Date().toISOString();
    const session: EraseSession = {
      id: randomUUID(),
      port: input.port,
      buildId: input.buildId,
      backupId: input.backupId,
      mac: input.mac,
      status: "running",
      verifiedBlank: false,
      needsFirmware: false,
      hardwareVerified: false,
      message: "Erasing flash.",
      createdAt: now,
      updatedAt: now,
    };
    this.ports.set(input.port, session.id);
    await this.eraseSessions.save(session);
    try {
      const evidence = await this.readEvidence(input.port);
      const backup = await findBackup(this.backupRoot, input.backupId);
      const packageReady = await this.packageReadiness(input.buildId, input.port, evidence.flashSizeBytes);
      const freshBackup = evidence.mac ? await latestBackupForMac(this.backupRoot, evidence.mac) : null;
      const selected = backup && freshBackup && backup.id === freshBackup.id ? freshBackup : backup;
      const assessment = assessEraseReadiness({
        portConnected: true,
        port: input.port,
        consolePort: input.consolePort ?? null,
        toolchainAvailable: true,
        toolchainDetail: this.toolchain.detail,
        evidence,
        backup: selected,
        packageReady,
      });
      if (evidence.mac !== input.mac || !assessment.enabled || selected?.id !== input.backupId) {
        session.status = "failed";
        session.message = evidence.mac !== input.mac
          ? "The connected chip does not match the confirmed MAC address. Flash was not erased."
          : `${assessment.blockers[0]?.message ?? "A safety check failed."} Flash was not erased.`;
        return session;
      }
      const erased = await this.flashIo.erase(input.port);
      if (erased.cancelled) {
        session.status = "interrupted";
        session.message = "The erase was cancelled. Flash contents are unknown.";
        return session;
      }
      if (erased.code !== 0) {
        session.status = "failed";
        session.message = "The erase command failed. A zero exit status was not observed, and the device was not marked ready for installation.";
        return session;
      }
      const offsets = [0, this.profile.partitionTableOffset, ...(evidence.partitions ?? []).map((region) => region.offset)];
      const samples: Buffer[] = [];
      for (const offset of offsets) samples.push(await this.flashIo.read(input.port, offset, 64));
      if (!samplesAreBlank(samples)) {
        session.status = "failed";
        session.verifiedBlank = false;
        session.needsFirmware = false;
        session.message = "The erase command finished, but the read-back was not blank. The device was not marked ready for installation.";
        return session;
      }
      session.status = "succeeded";
      session.verifiedBlank = true;
      session.needsFirmware = true;
      session.hardwareVerified = false;
      session.message = "Flash erase completed and the read-back was blank. Install firmware before the device can boot. This is not hardware verification.";
      return session;
    } catch (error) {
      session.status = "failed";
      session.verifiedBlank = false;
      session.needsFirmware = false;
      session.message = error instanceof Error ? error.message : "The erase failed. Flash contents are unknown.";
      return session;
    } finally {
      session.updatedAt = new Date().toISOString();
      await this.eraseSessions.save(session);
      if (this.ports.get(input.port) === session.id) this.ports.delete(input.port);
    }
  }

  async exportRecoveryBackup(id: string): Promise<{ filename: string; bytes: Buffer }> {
    const record = await findBackup(this.backupRoot, id);
    if (!record || !record.verified) {
      throw new ProgrammerError("That backup was not found or did not pass its integrity check.", 404, "backup_missing");
    }
    return {
      filename: `flash-backup-${record.mac.replace(/:/g, "")}.tar`,
      bytes: await archiveBackup(record.location),
    };
  }

  private async assertRecoveryPort(port: string, consolePort: string | null): Promise<void> {
    if (!isAllowedSerialPort(port)) {
      throw new ProgrammerError("Choose a local macOS USB serial device.", 400, "port_rejected");
    }
    if (consolePort && consolePort === port) {
      throw new ProgrammerError("The programming port and the console port are the same device.", 409, "port_conflict");
    }
    const available = await this.listPorts();
    if (!available.includes(port)) {
      throw new ProgrammerError("That serial port is not currently connected.", 400, "port_missing");
    }
  }

  private async readEvidence(port: string) {
    const chip = await this.flashIo.chip(port);
    const flash = await this.flashIo.flash(port);
    const security = await this.flashIo.security(port);
    let bootHeader: Buffer | null = null;
    let table: Buffer | null = null;
    try {
      bootHeader = await this.flashIo.read(port, this.profile.bootloaderOffset, 64);
    } catch {
      bootHeader = null;
    }
    try {
      const primary = await this.flashIo.read(port, this.profile.partitionTableOffset, 0xc00);
      table = parsePartitionTable(primary) ? primary : await this.flashIo.read(port, 0x8000, 0xc00);
    } catch {
      table = null;
    }
    return parseDeviceEvidence({
      chipText: chip.code === 0 ? chip.text : "",
      flashText: flash.code === 0 ? flash.text : "",
      securityText: security.code === 0 ? security.text : "",
      partitionTable: table,
      bootHeader,
    });
  }

  private async packageReadiness(buildId: string, port: string, deviceFlashBytes: number | null): Promise<PackageReadiness> {
    const empty = (detail: string): PackageReadiness => inspectPackageForRecovery({
      buildId: null,
      planOk: false,
      planDetail: detail,
      bootloader: null,
      application: null,
      sdkconfig: null,
      hashesOk: false,
      hashDetail: detail,
      packageFlashBytes: this.profile.flashSizeBytes,
      deviceFlashBytes,
      partitionEnd: null,
    });
    const job = await this.builds.get(buildId);
    if (!job) return empty("The firmware package was not found.");
    const blocked = packageProgrammingBlock(job);
    if (blocked) return empty(blocked.message);
    try {
      const opened = await openFirmwarePackage({
        dataDir: this.dataDir,
        archiveDir: this.archiveDirectory,
        buildId: job.id,
        files: REQUIRED.map((name) => {
          const artifact = job.artifacts.find((item) => item.name === name);
          return { name, relativePath: artifact?.relativePath, expectedSha256: artifact?.sha256 };
        }),
      });
      try {
        const files: Record<string, Buffer> = {};
        const mismatches: string[] = [];
        for (const name of REQUIRED) {
          if (name === "flasher_args.json") continue;
          const artifact = job.artifacts.find((item) => item.name === name);
          const bytes = await readFile(path.join(opened.directory, name));
          files[name] = bytes;
          if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.sha256 !== sha256(bytes)) mismatches.push(name);
        }
        const flasher = JSON.parse(await readFile(path.join(opened.directory, "flasher_args.json"), "utf8")) as FlashArguments;
        const layout = await loadReferenceLayout(this.repoRoot, this.profile);
        const plan = buildWritePlan({
          flasher,
          artifactDir: opened.directory,
          port,
          partitions: layout.partitions,
          bootloaderOffset: this.profile.bootloaderOffset,
          partitionTableOffset: this.profile.partitionTableOffset,
          flashSizeBytes: this.profile.flashSizeBytes,
          files,
        });
        let sdkconfig: string | null = null;
        try {
          sdkconfig = await readFile(path.join(opened.directory, "sdkconfig"), "utf8");
        } catch {
          try {
            sdkconfig = (await this.readPackageBytes(job, "sdkconfig", false)).toString("utf8");
          } catch {
            sdkconfig = null;
          }
        }
        const ends = layout.partitions.map((row) => (row.offset ?? 0) + row.size);
        return inspectPackageForRecovery({
          buildId: job.id,
          planOk: plan.ok,
          planDetail: plan.ok ? "The four-image plan is valid." : plan.issues[0]?.message ?? "The package is not safe to write.",
          bootloader: files["bootloader.bin"] ?? null,
          application: files["sensors.bin"] ?? null,
          sdkconfig,
          hashesOk: mismatches.length === 0,
          hashDetail: mismatches.length === 0 ? "Package checksums match." : `Checksum mismatch for ${mismatches.join(", ")}.`,
          packageFlashBytes: this.profile.flashSizeBytes,
          deviceFlashBytes,
          partitionEnd: ends.length ? Math.max(...ends) : null,
        });
      } finally {
        await opened.cleanup();
      }
    } catch (error) {
      return empty(error instanceof ProgrammerError || error instanceof FirmwareArtifactError ? error.message : "The firmware package could not be read.");
    }
  }

  private async consoleForBuild(buildId: string) {
    try {
      const job = await this.builds.get(buildId);
      if (!job) return firmwareConsole("");
      const text = (await this.readPackageBytes(job, "sdkconfig", false)).toString("utf8");
      return firmwareConsole(text);
    } catch {
      return firmwareConsole("");
    }
  }

  private async waitForSerialPort(port: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const ports = await this.listPorts();
      if (ports.includes(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return false;
  }

  private async developmentOnboardingRecord(session: ProgramSession): Promise<StoredDeviceOnboarding | null> {
    try {
      if (session.status !== "succeeded") return null;
      const identity = installationIdentity({
        log: `${session.logs.join("\n")}\n${session.monitorLog}`,
        storedMac: session.baseMac ?? null,
        recordedAt: session.updatedAt,
      });
      if (!identity.mac || identity.conflict) return null;
      const job = await this.builds.get(session.buildId);
      let vendorId: number | null = null;
      let productId: number | null = null;
      if (job) {
        try {
          const sdkconfig = (await this.readPackageBytes(job, "sdkconfig", false)).toString("utf8");
          vendorId = parseConfigId(sdkconfigValue(sdkconfig, "CONFIG_DEVICE_VENDOR_ID"));
          productId = parseConfigId(sdkconfigValue(sdkconfig, "CONFIG_DEVICE_PRODUCT_ID"));
        } catch {
          vendorId = null;
          productId = null;
        }
      }
      const verification = await this.onboardingForBuild(session.buildId, job?.request.softwareVersion ?? null, session.softwareVersionString, vendorId, productId, session.monitorLog);
      return verifiedDevelopmentOnboarding({
        mac: identity.mac,
        vendorId,
        productId,
        verification,
        commissioningState: commissioningFromLog(session.monitorLog).state,
        updatedAt: session.updatedAt,
      });
    } catch {
      return null;
    }
  }

  private finishBootCapture(session: ProgramSession): void {
    session.stage = "idle";
    session.checks = this.checksFor(session);
    session.message = bootResultMessage(session.monitorLog, session.checks, session.status) ?? session.message;
    session.updatedAt = new Date().toISOString();
  }

  async verifyBoot(id: string, consolePort: string): Promise<ProgramSession> {
    const session = await this.sessions.get(id);
    if (!session) throw new ProgrammerError("Programming session not found.", 404, "not_found");
    if (session.status !== "succeeded") {
      throw new ProgrammerError("Boot verification follows a successful firmware write. The firmware was not written again.", 409, "verification_not_ready");
    }
    if (!isAllowedSerialPort(consolePort)) {
      throw new ProgrammerError("Choose a local USB serial port.", 400, "console_port");
    }
    const sharedUsb = consolePort === session.port;
    const consoleConfig = await this.consoleForBuild(session.buildId);
    if (sharedUsb && !consoleConfig.usbSerialJtagOutput) {
      throw new ProgrammerError("This firmware sends its console to UART0. The USB programming port cannot capture those logs. Connect a UART adapter. Flash was not rewritten.", 400, "console_port");
    }
    const devices = await this.portDetails();
    const selected = devices.find((device) => device.path === consolePort);
    if (!selected) {
      throw new ProgrammerError("The console port is not connected. Reconnect it and detect devices again.", 400, "port_missing");
    }
    if (!sharedUsb && selected.role === "programming") {
      throw new ProgrammerError("That port is the programming interface. Select the UART console.", 400, "console_port");
    }
    if (selected.busy && !selected.ownedByApplication) {
      const holder = selected.occupants?.[0];
      throw new ProgrammerError(
        holder
          ? `The UART console is open in ${holder.command} (process ${holder.pid}). Close that serial monitor, then retry boot verification. It was left running.`
          : "The UART console is open in another program. Close that serial monitor, then retry boot verification. It was left running.",
        409,
        "port_busy",
      );
    }
    if (this.ports.has(consolePort) || this.ports.has(session.port) || this.monitors.has(id)) {
      throw new ProgrammerError("This device already has a write or monitor in progress.", 409, "port_busy");
    }
    const controller = new AbortController();
    this.monitors.set(id, controller);
    this.ports.set(consolePort, id);
    session.stage = "monitoring";
    session.consolePort = consolePort;
    if (sharedUsb) {
      session.monitorLog = clip(`${session.monitorLog}\nnote: console port ${consolePort}`);
      session.message = "Opening the USB console before the application reset. Flash is not being erased.";
      session.updatedAt = new Date().toISOString();
      await this.persist(session);
      const opened = await this.confirmConsoleOpen(session, controller, consolePort);
      if (!opened) {
        session.monitorLog = clip(`${session.monitorLog}\nnote: the USB console did not open, so the board was not reset`);
        this.finishBootCapture(session);
        session.message = "The USB console did not open, so the board was not reset. Close any other serial monitor and retry. Flash was not rewritten.";
        await this.persist(session);
        this.monitors.delete(id);
        return this.withFlashImages(session);
      }
      session.monitorLog = clip(`${session.monitorLog}\nnote: reset requested`);
      session.message = "The USB console is open. Resetting into the application. Flash is not being erased.";
      session.updatedAt = new Date().toISOString();
      await this.persist(session);
      let resetDetail = "The application was reset. Flash was not erased.";
      const presentBefore = (await this.listPorts()).includes(consolePort);
      let dropped = false;
      let watch = true;
      const disappearance = (async () => {
        while (watch && !dropped) {
          if (presentBefore && !(await this.listPorts()).includes(consolePort)) dropped = true;
          if (!dropped) await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();
      try {
        const reset = await this.appReset({
          repoRoot: this.repoRoot,
          port: session.port,
          signal: controller.signal,
          env: this.toolchain.childEnv,
        });
        resetDetail = reset.ok
          ? reset.detail
          : `${reset.detail} Press the board RESET button once. Do not hold BOOT.`;
      } finally {
        watch = false;
        if (this.ports.get(consolePort) === id) this.ports.delete(consolePort);
      }
      await disappearance;
      session.monitorLog = clip(`${session.monitorLog}\nnote: ${dropped ? "usb interface disconnected" : "usb interface remained present"}`);
      const reappeared = await this.waitForSerialPort(consolePort, 8_000);
      session.monitorLog = clip(`${session.monitorLog}\nnote: ${reappeared ? "usb interface reappeared" : PORT_REAPPEAR_FAILED}`);
      if (!reappeared) {
        this.finishBootCapture(session);
        session.message = PORT_REAPPEAR_FAILED;
        await this.persist(session);
        this.monitors.delete(id);
        return this.withFlashImages(session);
      }
      this.ports.set(consolePort, id);
      await this.finishListen(session, controller, consolePort, 25_000, resetDetail);
      return this.withFlashImages(session);
    }
    session.message = "Listening on the UART console before a normal application reset. Flash is not being erased.";
    session.updatedAt = new Date().toISOString();
    await this.cacheOnboarding(session);
    await this.persist(session);
    const captured = this.captureMonitor(session, controller, consolePort);
    const listenDeadline = Date.now() + 5_000;
    while (Date.now() < listenDeadline && !controller.signal.aborted) {
      if (/uart console open|could not open port|ESP-ROM:|App version:/i.test(session.monitorLog)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const consoleOpen = /uart console open|ESP-ROM:|App version:/i.test(session.monitorLog)
      && !/could not open port/i.test(session.monitorLog);
    this.ports.set(session.port, id);
    let resetDetail = "The automatic reset did not finish. Press the board RESET button once. Do not hold BOOT. Holding BOOT for five seconds is the Matter factory reset.";
    try {
      if (!consoleOpen) {
        resetDetail = "The UART console did not open, so the board was not reset. Close any other serial monitor and retry.";
      } else {
        const reset = await this.appReset({
          repoRoot: this.repoRoot,
          port: session.port,
          signal: controller.signal,
          env: this.toolchain.childEnv,
        });
        resetDetail = reset.ok
          ? reset.detail
          : `${reset.detail} Press the board RESET button once while the console is listening. Do not hold BOOT.`;
      }
    } finally {
      if (this.ports.get(session.port) === id) this.ports.delete(session.port);
    }
    await this.finishListen(session, controller, consolePort, 25_000, resetDetail, captured);
    return this.withFlashImages(session);
  }

  private async confirmConsoleOpen(session: ProgramSession, parent: AbortController, port: string): Promise<boolean> {
    const child = new AbortController();
    const onParent = () => child.abort();
    if (parent.signal.aborted) child.abort();
    else parent.signal.addEventListener("abort", onParent);
    const captured = this.captureMonitor(session, child, port);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !child.signal.aborted) {
      const deviceLine = session.monitorLog.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith("note:");
      });
      if (deviceLine || /uart console open|could not open port/i.test(session.monitorLog)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const deviceLine = session.monitorLog.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("note:");
    });
    const opened = (deviceLine || /uart console open/i.test(session.monitorLog))
      && !/could not open port/i.test(session.monitorLog);
    child.abort();
    await captured;
    parent.signal.removeEventListener("abort", onParent);
    if (opened) session.monitorLog = clip(`${session.monitorLog}\nnote: console opened`);
    return opened;
  }

  private async finishListen(
    session: ProgramSession,
    controller: AbortController,
    port: string,
    timeoutMs: number,
    resetDetail: string,
    existing?: Promise<void>,
  ): Promise<void> {
    const captured = existing ?? this.captureMonitor(session, controller, port);
    let monitorDone = false;
    void captured.then(() => {
      monitorDone = true;
    });
    const deadline = Date.now() + timeoutMs;
    const marker = session.monitorLog.lastIndexOf("note: reset requested");
    let seenAt: number | null = null;
    while (Date.now() < deadline && !controller.signal.aborted && !monitorDone) {
      const portion = marker >= 0 ? session.monitorLog.slice(marker) : session.monitorLog;
      const settled = bootListenSettled(portion, seenAt, Date.now());
      seenAt = settled.seenAt;
      if (settled.settled) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const portion = marker >= 0 ? session.monitorLog.slice(marker) : session.monitorLog;
    if (!bootListenSettled(portion, seenAt, Date.now()).settled) {
      session.monitorLog = clip(`${session.monitorLog}\nnote: ${resetDetail}`);
      session.monitorLog = clip(`${session.monitorLog}\nnote: capture ended before application startup was settled`);
    } else {
      session.monitorLog = clip(`${session.monitorLog}\nnote: capture ended`);
    }
    controller.abort();
    await captured;
    this.finishBootCapture(session);
    await this.persist(session);
  }

  private async captureMonitor(session: ProgramSession, controller: AbortController, port = session.port): Promise<void> {
    try {
      await this.runMonitor({
        repoRoot: this.repoRoot,
        port,
        signal: controller.signal,
        env: this.toolchain.childEnv,
        onLog: (line) => {
          this.observeAdvertisement(session, line);
          session.monitorLog = clip(`${session.monitorLog}\n${redactSerialLog(line)}`);
          session.checks = this.checksFor(session);
          session.updatedAt = new Date().toISOString();
          void this.persist(session);
        },
      });
      if (!controller.signal.aborted) {
        session.monitorLog = clip(`${session.monitorLog}\nnote: serial port closed`);
      }
    } finally {
      session.stage = "idle";
      session.checks = this.checksFor(session);
      if (session.status === "succeeded") session.message = bootResultMessage(session.monitorLog, session.checks, session.status) ?? session.message;
      session.updatedAt = new Date().toISOString();
      await this.persist(session);
      this.monitors.delete(session.id);
      if (this.ports.get(port) === session.id) this.ports.delete(port);
    }
  }
}
