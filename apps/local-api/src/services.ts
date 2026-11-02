import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalCatalogRepository } from "@iotedu/catalog";
import {
  type BuildArtifact,
  type BuildJob,
  type FirmwareBuildRequest,
  type ManagedNode,
  type ValidationResult,
} from "@iotedu/contracts";
import {
  detectGpioConflicts,
  loadReferenceLayout,
  renderVersionSdkconfig,
  selectionIssues,
  versionSupersedes,
  type BoardProfile,
} from "@iotedu/firmware-builder";
import { runNativeDht11Build, type NativeBuildResult, type NativeBuildSpec } from "@iotedu/firmware-builder/native";
import { readFirmwareArtifact } from "./firmware-artifacts.js";
import type { BuildRepository } from "./store.js";

export type NativeRunner = (spec: NativeBuildSpec) => Promise<NativeBuildResult>;

export interface CatalogueBuildHook {
  notes: string[];
  prepareWorkspace: (workspaceDir: string) => Promise<{
    partitionLayoutId: string;
    pinExpectations?: { key: string; value: string }[];
    productId?: number;
  }>;
  onComplete: (job: BuildJob, result: NativeBuildResult | null) => Promise<void>;
}

export class LocalFirmwareBuildService {
  private readonly running = new Map<string, AbortController>();
  private activeNativeId: string | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private logChain: Promise<void> = Promise.resolve();
  private lastSave = 0;
  private readonly catalogueHooks = new Map<string, CatalogueBuildHook>();

  constructor(
    private readonly catalog: LocalCatalogRepository,
    private readonly jobs: BuildRepository,
    private readonly dataDir: string,
    private readonly repoRoot: string,
    private readonly profile: BoardProfile,
    private readonly options: {
      nodes?: { getById(id: string): Promise<ManagedNode | null> };
      nativeAvailable?: boolean;
      runNative?: NativeRunner;
      archiveDir?: string;
    } = {},
  ) {}

  async validate(input: FirmwareBuildRequest): Promise<ValidationResult> {
    const issues: ValidationResult["issues"] = [];
    const manifests = await this.catalog.list();
    if (input.baseFirmwareId !== "iotedu-core") {
      issues.push({
        level: "error",
        code: "unknown_base",
        message: "The only base firmware in this release is the audited Matter-over-Thread core.",
      });
    }
    issues.push(...selectionIssues(manifests, [input.baseFirmwareId, ...input.componentIds], input.mode));
    issues.push(...detectGpioConflicts(this.profile, input.pins));
    for (const id of input.componentIds) {
      const manifest = manifests.find((item) => item.id === id);
      for (const pin of manifest?.firmware?.kconfig ?? []) {
        if (!input.pins.some((item) => item.componentId === id && item.pinName === pin.pinName)) {
          issues.push({
            level: "error",
            code: "missing_pin",
            message: `${manifest?.name ?? id} needs a ${pin.pinName} assignment`,
          });
        }
      }
    }
    try {
      renderVersionSdkconfig(input.softwareVersion, input.softwareVersionString);
    } catch (error) {
      issues.push({
        level: "error",
        code: "invalid_version",
        message: error instanceof Error ? error.message : "Firmware version is invalid",
      });
    }
    if (input.nodeId && this.options.nodes) {
      const node = await this.options.nodes.getById(input.nodeId);
      if (node?.softwareVersion != null && !versionSupersedes(input.softwareVersion, node.softwareVersion)) {
        issues.push({
          level: "warning",
          code: "version_not_higher",
          message: `SoftwareVersion ${input.softwareVersion} is not higher than installed SoftwareVersion ${node.softwareVersion}.`,
        });
      }
    }
    if (input.mode === "native") {
      if (input.codeSource !== "approved") {
        issues.push({
          level: "error",
          code: "untrusted_source_not_compiled",
          message: "Native builds accept approved local components only. Uploaded and AI sources are not compiled.",
        });
      }
      const unsupported = input.componentIds.filter((id) => id !== "iotedu-dht11");
      if (!input.componentIds.includes("iotedu-dht11") || unsupported.length > 0) {
        issues.push({
          level: "error",
          code: "native_package_unsupported",
          message: "The native pipeline builds the verified ESP32-H2 DHT11 package. Other component sets are rejected.",
        });
      }
      if (!this.options.nativeAvailable) {
        issues.push({
          level: "error",
          code: "toolchain_not_configured",
          message: "Native builds need IDF_PATH, ESP_MATTER_PATH, and IDF_ACTIVATE in the API environment.",
        });
      }
    }
    if (input.codeSource === "ai_draft") {
      issues.push({
        level: "error",
        code: "ai_not_available",
        message: "AI drafts cannot be built. Configure a provider later, then review the source before accepting it.",
      });
    }
    if (input.codeSource === "upload" && !input.uploadId) {
      issues.push({
        level: "error",
        code: "missing_upload",
        message: "An uploaded source id is required for the custom-code path.",
      });
    }
    if (input.codeSource === "upload" && input.uploadId) {
      const upload = path.join(this.dataDir, "uploads", input.uploadId, "meta.json");
      try {
        await readFile(upload, "utf8");
      } catch {
        issues.push({
          level: "error",
          code: "upload_missing",
          message: "The uploaded source was not found. It was not compiled.",
        });
      }
    }
    const selected = new Set(input.componentIds);
    for (const pin of input.pins) {
      if (!selected.has(pin.componentId) && pin.componentId !== input.baseFirmwareId) {
        issues.push({
          level: "error",
          code: "pin_without_component",
          message: `Pin ${pin.pinName} refers to ${pin.componentId}, which is not selected.`,
        });
      }
    }
    return { ok: issues.every((issue) => issue.level !== "error"), issues };
  }

  async build(input: FirmwareBuildRequest): Promise<BuildJob> {
    const validation = await this.validate(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    if (!validation.ok) {
      const rejected: BuildJob = {
        id,
        simulated: input.mode !== "native",
        verification: null,
        status: "failed",
        request: input,
        validation,
        logs: ["Build rejected before any compiler was started.", ...validation.issues.map((issue) => issue.message)],
        artifacts: [],
        partitionLayoutId: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.jobs.save(rejected);
      return rejected;
    }

    if (input.mode === "native") {
      if (this.activeNativeId) {
        const busy: BuildJob = {
          id,
          simulated: false,
          verification: null,
          status: "failed",
          request: input,
          validation,
          logs: ["Another native build is already running. Wait for it to finish before starting a second one."],
          artifacts: [],
          partitionLayoutId: null,
          durationMs: null,
          createdAt: now,
          updatedAt: now,
        };
        await this.jobs.save(busy);
        return busy;
      }
      const running: BuildJob = {
        id,
        simulated: false,
        verification: null,
        status: "running",
        request: input,
        validation,
        logs: ["Native build accepted. The compiler has been started."],
        artifacts: [],
        partitionLayoutId: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.jobs.save(running);
      void this.executeNative(running);
      return running;
    }

    const layout = await loadReferenceLayout(this.repoRoot, this.profile);
    const body = [
      "SIMULATED IoT.Edu firmware package",
      "This file is not an ESP-IDF application binary.",
      "Do not flash it and do not offer it as a Matter OTA image.",
      `softwareVersion=${input.softwareVersion}`,
      `softwareVersionString=${input.softwareVersionString}`,
      `components=${input.componentIds.join(",")}`,
      "",
    ].join("\n");
    const dir = path.join(this.dataDir, "builds", id);
    await mkdir(dir, { recursive: true });
    const artifactPath = path.join(dir, "SIMULATED.txt");
    await writeFile(artifactPath, body, "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const job: BuildJob = {
      id,
      simulated: true,
      verification: "simulated",
      status: "simulated",
      request: input,
      validation,
      logs: [
        "Mock mode: ESP-IDF was not invoked.",
        "No application image or Matter OTA image was produced.",
        `Partition layout ${layout.layoutId} was copied from the reference table for display only.`,
        "The resulting record is simulated and is not deployable.",
      ],
      artifacts: [
        {
          name: "SIMULATED.txt",
          relativePath: path.join("builds", id, "SIMULATED.txt"),
          sha256,
          size: Buffer.byteLength(body),
          simulated: true,
          deployable: false,
        },
      ],
      partitionLayoutId: layout.layoutId,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.save(job);
    return job;
  }

  async composeCatalogue(request: FirmwareBuildRequest, hook: CatalogueBuildHook): Promise<BuildJob> {
    const issues: ValidationResult["issues"] = [...detectGpioConflicts(this.profile, request.pins)];
    try {
      renderVersionSdkconfig(request.softwareVersion, request.softwareVersionString);
    } catch (error) {
      issues.push({
        level: "error",
        code: "invalid_version",
        message: error instanceof Error ? error.message : "Firmware version is invalid",
      });
    }
    if (request.componentIds.includes("custom-dht11") && request.softwareVersion === 2) {
      issues.push({
        level: "error",
        code: "version_is_component_revision",
        message: "Matter SoftwareVersion must be a device firmware version. Component revision 2 is not a firmware version.",
      });
    }
    if (!this.options.nativeAvailable) {
      issues.push({
        level: "error",
        code: "toolchain_not_configured",
        message: "Native builds need IDF_PATH, ESP_MATTER_PATH, and IDF_ACTIVATE in the API environment.",
      });
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const validation = { ok: issues.every((issue) => issue.level !== "error"), issues };
    if (!validation.ok || this.activeNativeId) {
      const rejected: BuildJob = {
        id,
        simulated: false,
        verification: null,
        status: "failed",
        request,
        validation,
        logs: this.activeNativeId && validation.ok
          ? ["Another native build is already running. Wait for it to finish before starting a second one."]
          : ["Catalogue composition was rejected before the compiler started.", ...issues.map((issue) => issue.message)],
        artifacts: [],
        partitionLayoutId: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.jobs.save(rejected);
      return rejected;
    }
    this.catalogueHooks.set(id, hook);
    const running: BuildJob = {
      id,
      simulated: false,
      verification: null,
      status: "running",
      request,
      validation,
      logs: ["Catalogue composition accepted. The ESP-IDF compiler has been started. The device is not being written.", ...hook.notes],
      artifacts: [],
      partitionLayoutId: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.save(running);
    void this.executeNative(running);
    return running;
  }

  async recoverInterrupted(): Promise<void> {
    for (const job of await this.jobs.list()) {
      if (job.status !== "running") continue;
      job.status = "interrupted";
      job.verification = null;
      job.artifacts = job.artifacts.map((artifact) => ({ ...artifact, deployable: false }));
      job.logs = [
        ...job.logs,
        "The API process stopped before this build finished. It is not a successful firmware package.",
      ];
      job.updatedAt = new Date().toISOString();
      await this.jobs.save(job);
      await rm(path.join(this.dataDir, "builds", job.id, "workspace"), { recursive: true, force: true });
    }
  }

  async cancel(id: string): Promise<BuildJob | null> {
    const job = await this.jobs.get(id);
    if (!job) return null;
    const controller = this.running.get(id);
    if (job.status !== "running" || !controller) return job;
    controller.abort();
    job.logs = [...job.logs, "Cancellation requested."];
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
    return job;
  }

  async readLog(id: string): Promise<{ status: BuildJob["status"]; tail: string } | null> {
    const job = await this.jobs.get(id);
    if (!job) return null;
    const recorded = job.artifacts.find((artifact) => artifact.name === "build.log");
    let tail = job.logs.join("\n");
    try {
      const resolved = await readFirmwareArtifact({
        dataDir: this.dataDir,
        archiveDir: this.options.archiveDir,
        buildId: id,
        name: "build.log",
        relativePath: recorded?.relativePath,
        expectedSha256: recorded?.sha256,
        verify: true,
      });
      const lines = resolved.bytes.toString("utf8").split(/\r?\n/);
      tail = lines.slice(-200).join("\n");
    } catch {
      // The milestone list is enough until the log file exists.
    }
    return { status: job.status, tail };
  }

  private persist(job: BuildJob): Promise<void> {
    this.saveChain = this.saveChain.then(() => this.jobs.save(job));
    return this.saveChain;
  }

  private appendLog(job: BuildJob, line: string): void {
    const next = [...job.logs, line];
    job.logs = next.length > 48 ? [...next.slice(0, 8), ...next.slice(-40)] : next;
    this.logChain = this.logChain.then(async () => {
      const file = path.join(this.dataDir, "builds", job.id, "artifacts", "build.log");
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${line}\n`);
      const now = Date.now();
      if (now - this.lastSave > 2000) {
        this.lastSave = now;
        job.updatedAt = new Date().toISOString();
        await this.persist(job);
      }
    });
  }

  private async executeNative(job: BuildJob): Promise<void> {
    const pin = job.request.pins.find((item) =>
      (item.componentId === "iotedu-dht11" || item.componentId === "custom-dht11") && item.pinName === "DHT11_DATA");
    const controller = new AbortController();
    this.running.set(job.id, controller);
    this.activeNativeId = job.id;
    const artifactDir = path.join(this.dataDir, "builds", job.id, "artifacts");
    const workspaceDir = path.join(this.dataDir, "builds", job.id, "workspace");
    const hook = this.catalogueHooks.get(job.id);
    const runner = this.options.runNative ?? runNativeDht11Build;
    let result: NativeBuildResult | null = null;
    try {
      result = await runner({
        repoRoot: this.repoRoot,
        workspaceDir,
        artifactDir,
        softwareVersion: job.request.softwareVersion,
        softwareVersionString: job.request.softwareVersionString,
        dht11Gpio: pin?.gpio ?? 4,
        signal: controller.signal,
        prepareWorkspace: hook ? () => hook.prepareWorkspace(workspaceDir) : undefined,
        onLog: (line) => {
          this.appendLog(job, line);
        },
      });
      await this.logChain;
      await this.persist(job);
      job.durationMs = result.durationMs;
      job.partitionLayoutId = result.partitionLayoutId;
      job.validation = {
        ok: result.ok && result.issues.every((issue) => issue.level !== "error"),
        issues: [...job.validation.issues, ...result.issues],
      };
      job.logs = [...job.logs, ...result.summary];
      if (result.cancelled || controller.signal.aborted) {
        job.status = "interrupted";
        job.verification = null;
        job.simulated = false;
        job.artifacts = [];
        job.logs = [...job.logs, "Build cancelled. No firmware package was published."];
      } else if (result.ok) {
        job.status = "succeeded";
        job.verification = "compiled";
        job.simulated = false;
        job.artifacts = await this.recordedArtifacts(job.id, result, artifactDir);
        job.logs = [...job.logs, "Compilation finished. The package is compiled and has not been hardware-verified."];
      } else {
        job.status = "failed";
        job.verification = null;
        job.simulated = false;
        job.artifacts = await this.diagnosticArtifacts(job.id, artifactDir);
        job.logs = [...job.logs, "Build failed. No deployable firmware package was published."];
      }
    } catch (error) {
      job.status = "failed";
      job.verification = null;
      job.simulated = false;
      job.artifacts = [];
      job.logs = [...job.logs, error instanceof Error ? error.message : "Native build failed"];
    } finally {
      this.running.delete(job.id);
      if (this.activeNativeId === job.id) this.activeNativeId = null;
      this.catalogueHooks.delete(job.id);
      job.updatedAt = new Date().toISOString();
      await this.persist(job);
      if (hook) {
        try {
          await hook.onComplete(job, result);
        } catch (error) {
          job.logs = [...job.logs, error instanceof Error ? error.message : "The catalogue build record was not saved."];
          job.updatedAt = new Date().toISOString();
          await this.persist(job);
        }
      }
    }
  }

  private async recordedArtifacts(id: string, result: NativeBuildResult, artifactDir: string): Promise<BuildArtifact[]> {
    const artifacts: BuildArtifact[] = result.artifacts.map((artifact) => ({
      name: artifact.name,
      relativePath: path.join("builds", id, "artifacts", artifact.name),
      sha256: artifact.sha256,
      size: artifact.size,
      simulated: false,
      deployable: artifact.deployable,
    }));
    try {
      artifacts.push(await this.hashFile(id, artifactDir, "build.log", false));
    } catch {
      // A runner can finish without writing a log file.
    }
    const sums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n") + "\n";
    const sumsPath = path.join(artifactDir, "SHA256SUMS");
    await writeFile(sumsPath, sums);
    artifacts.push(await this.hashFile(id, artifactDir, "SHA256SUMS", false));
    return artifacts;
  }

  private async diagnosticArtifacts(id: string, artifactDir: string): Promise<BuildArtifact[]> {
    const found: BuildArtifact[] = [];
    for (const name of ["build.log", "sdkconfig"]) {
      try {
        found.push(await this.hashFile(id, artifactDir, name, false));
      } catch {
        // A failed start may not have produced that file.
      }
    }
    return found;
  }

  private async hashFile(id: string, artifactDir: string, name: string, deployable: boolean): Promise<BuildArtifact> {
    const body = await readFile(path.join(artifactDir, name));
    return {
      name,
      relativePath: path.join("builds", id, "artifacts", name),
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
      simulated: false,
      deployable,
    };
  }

  async get(id: string) {
    return this.jobs.get(id);
  }

  async list() {
    return this.jobs.list();
  }
}
