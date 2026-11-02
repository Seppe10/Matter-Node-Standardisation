import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import { LocalCatalogRepository } from "@iotedu/catalog";
import {
  aiDraftRequestSchema,
  commissionRequestSchema,
  recoverExistingRequestSchema,
  firmwareBuildRequestSchema,
  libraryCreateRequestSchema,
  libraryStageRequestSchema,
  libraryUpdateRequestSchema,
  libraryValidateRequestSchema,
  eraseRequestSchema,
  programRequestSchema,
  removeNodeRequestSchema,
  retirePeerRequestSchema,
  renameNodeSchema,
  type BuildJob,
} from "@iotedu/contracts";
import { boardProfileFile } from "@iotedu/contracts/paths";
import { discoverToolchain, loadReferenceLayout, type BoardProfile, type ToolchainInspection } from "@iotedu/firmware-builder";
import { probeChip, redactSerialLog, verifyProgrammingTools, type FlashIo } from "@iotedu/firmware-builder/programmer";
import { LiveMatterManagementService, MatterOperationError, MockMatterManagementService } from "@iotedu/matter-controller";
import type { MatterManagementService } from "@iotedu/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { startDht11Composition, startNodeTypeComposition } from "./catalogue-compose.js";
import { classifyFirmwareStorage, FirmwareArtifactError, readFirmwareArtifact } from "./firmware-artifacts.js";
import { listNodeTypes } from "./node-types.js";
import { CatalogueError, catalogueEnabled, catalogueStorage, compositionStatus, listFirmwareReleases, listPending, saveSelection } from "./catalogue-store.js";
import { FirmwareLibraryError, FirmwareLibraryService } from "./firmware-library-service.js";
import { LocalProgrammerService, ProgrammerError, type AppReset, type MonitorRunner, type OccupantLookup, type PortClassifier, type PortLister, type UsbRunner } from "./programmer-service.js";
import { LocalFirmwareBuildService, type NativeRunner } from "./services.js";
import { ReachabilityMonitor } from "./reachability.js";
import { JsonJobRepository, JsonNodeRepository, redact, removeOrphanTemporaryFiles } from "./store.js";
import { ALLOWED_ORIGINS, attachAuth, resolveAuthStore } from "./auth-http.js";
import type { AuthStore } from "./auth-store.js";

function publicSession<T extends object>(session: T): Omit<T, "deviceOnboarding" | "savedSerialLog"> {
  const { deviceOnboarding: _hidden, savedSerialLog: _saved, ...rest } = session as T & { deviceOnboarding?: unknown; savedSerialLog?: unknown };
  const visible = { ...rest } as Omit<T, "deviceOnboarding" | "savedSerialLog"> & { monitorLog?: unknown; logs?: unknown };
  if (typeof visible.monitorLog === "string") visible.monitorLog = redactSerialLog(visible.monitorLog);
  if (Array.isArray(visible.logs)) visible.logs = visible.logs.map((line) => typeof line === "string" ? redactSerialLog(line) : line);
  return visible;
}

const UPLOAD_EXTENSIONS = new Set([".c", ".h", ".cpp", ".hpp", ".txt"]);

export interface AppPaths {
  dataDir: string;
  repoRoot: string;
  catalogDir: string;
  profile: BoardProfile;
  nativeAvailable?: boolean;
  runNative?: NativeRunner;
  runProgram?: UsbRunner;
  runMonitor?: MonitorRunner;
  listPorts?: PortLister;
  classifyPorts?: PortClassifier;
  flashIo?: FlashIo;
  backupRoot?: string;
  appReset?: AppReset;
  occupants?: OccupantLookup;
  toolchain?: ToolchainInspection;
  libraryCompile?: (files: { name: string; data: Buffer }[]) => Promise<{ available: boolean; ran: boolean; success: boolean; diagnostics: { level: "error" | "warning"; message: string; file?: string; line?: number }[] }>;
  matterMode?: "mock" | "live";
  matter?: MatterManagementService;
  firmwareArchiveDir?: string;
  reachabilityIntervalMs?: number;
  auth?: AuthStore | "off";
}

export function startupLog(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  console.log(JSON.stringify({ source: "iotedu-api", event, ...fields }));
}

function boardLimits(profile: BoardProfile) {
  return {
    gpioMin: profile.gpioMin,
    gpioMax: profile.gpioMax,
    reservedGpio: profile.reservedGpio,
    adc1Channels: profile.adc1Channels ?? [],
  };
}

/** An explicit availability flag is a test or host override. It does not re-inspect the machine toolchain. */
function syntheticToolchain(nativeAvailable: boolean): ToolchainInspection {
  return {
    nativeAvailable,
    programmingAvailable: nativeAvailable,
    programmingCode: nativeAvailable ? "ok" : "toolchain_not_installed",
    idfPathConfigured: nativeAvailable,
    espMatterPathConfigured: nativeAvailable,
    activateConfigured: nativeAvailable,
    source: nativeAvailable ? "environment" : "incomplete",
    detail: nativeAvailable
      ? "ESP-IDF v5.4.1 is available to this application."
      : "ESP-IDF v5.4.1 is not installed. IoT.Edu looked for the v5.4.1 toolchain. A missing toolchain is not a missing USB device.",
    childEnv: process.env,
  };
}

export async function buildApp(paths: AppPaths): Promise<FastifyInstance> {
  startupLog("store", { state: "opening" });
  await removeOrphanTemporaryFiles(paths.dataDir);
  const nodes = new JsonNodeRepository(path.join(paths.dataDir, "nodes.json"));
  const builds = new JsonJobRepository<BuildJob>(path.join(paths.dataDir, "builds.json"));
  const catalog = new LocalCatalogRepository(paths.catalogDir, paths.repoRoot);
  startupLog("toolchain", { state: "checking" });
  let toolchain = paths.toolchain ?? (paths.nativeAvailable === undefined ? await discoverToolchain() : syntheticToolchain(paths.nativeAvailable));
  if (!paths.toolchain && paths.nativeAvailable === undefined && toolchain.programmingAvailable) {
    const tools = await verifyProgrammingTools(paths.repoRoot, toolchain.childEnv);
    toolchain = tools.ok
      ? { ...toolchain, detail: tools.detail, programmingCode: "ok" }
      : {
        ...toolchain,
        nativeAvailable: false,
        programmingAvailable: false,
        programmingCode: "tools_unavailable",
        source: "incomplete",
        detail: tools.detail,
      };
  }
  const nativeAvailable = paths.nativeAvailable ?? toolchain.nativeAvailable;
  const toolchainForProgrammer = toolchain;
  startupLog("toolchain", { state: "checked", nativeAvailable, programmingAvailable: toolchainForProgrammer.programmingAvailable });
  const matter = paths.matter
    ?? (paths.matterMode === "live"
      ? new LiveMatterManagementService(nodes, paths.dataDir)
      : new MockMatterManagementService(nodes));
  const deferLiveMatter = paths.matterMode === "live";
  if (deferLiveMatter) {
    startupLog("matter-controller", { state: "starting" });
    void matter.restore().then(async () => {
      const status = await matter.getControllerStatus();
      startupLog("matter-controller", {
        state: status.identityLoaded ? "stored-devices-checked" : "unavailable",
      });
    }, () => {
      startupLog("matter-controller", { state: "failed" });
    });
  } else {
    await matter.restore();
  }
  const firmware = new LocalFirmwareBuildService(catalog, builds, paths.dataDir, paths.repoRoot, paths.profile, {
    nodes,
    nativeAvailable,
    runNative: paths.runNative,
    archiveDir: paths.firmwareArchiveDir,
  });
  startupLog("firmware", { state: "recovering" });
  await firmware.recoverInterrupted();
  startupLog("firmware", { state: "ready" });
  const programmer = new LocalProgrammerService(
    builds,
    paths.dataDir,
    paths.repoRoot,
    paths.profile,
    nativeAvailable,
    paths.runProgram,
    paths.runMonitor,
    paths.listPorts,
    probeChip,
    {
      toolchain: toolchainForProgrammer,
      flashIo: paths.flashIo,
      backupRoot: paths.backupRoot,
      archiveDir: paths.firmwareArchiveDir,
      appReset: paths.appReset,
      occupants: paths.occupants,
      classifyPorts: paths.classifyPorts,
    },
  );
  startupLog("programmer", { state: "recovering" });
  await programmer.recoverInterrupted();
  startupLog("programmer", { state: "ready" });
  const reachability = new ReachabilityMonitor(
    nodes,
    matter,
    paths.reachabilityIntervalMs ?? Number(process.env.REACHABILITY_INTERVAL_MS ?? 30_000),
  );
  if ((paths.reachabilityIntervalMs ?? 30_000) !== 0) reachability.start();

  const library = new FirmwareLibraryService(paths.dataDir, paths.profile, () => catalog.list(), { compile: paths.libraryCompile });

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.has(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"), false);
    },
  });
  // DNS-rebinding guard. Applies even when authentication is off (no DATABASE_URL).
  app.addHook("onRequest", async (request, reply) => {
    const hostname = (request.headers.host ?? "").replace(/:\d+$/, "");
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return reply.code(421).header("cache-control", "no-store").send({ error: { code: "host_rejected", message: "This request was rejected." } });
    }
  });
  const authStore = await resolveAuthStore(paths);
  if (authStore) attachAuth(app, authStore);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "invalid_input", message: redact(error.issues.map((issue) => issue.message).join("; ")) },
      });
    }
    if (error instanceof MatterOperationError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: redact(error.message), detail: error.detail },
      });
    }
    const message = error instanceof Error ? error.message : "Request failed";
    const status = message === "Node not found" ? 404 : 400;
    return reply.code(status).send({ error: { code: "request_failed", message } });
  });

  app.get("/api/health", async () => ({ ok: true, bind: "127.0.0.1" }));
  app.get("/api/capabilities", async () => {
    const report = await matter.getCapabilities();
    if (nativeAvailable) {
      report.firmwareBuild = "available";
      report.usbFlash = "available";
      report.notes = [
        ...report.notes,
        "Native firmware compilation is available. A compiled package is not hardware-verified.",
        "USB writing is available for a compiled ESP32-H2 package. NVS is not erased. A finished write is not hardware verification.",
      ];
    }
    return report;
  });

  app.get("/api/nodes", async () => ({ nodes: await reachability.presentAll() }));
  app.get("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = await nodes.getById(id);
    if (!node) return reply.code(404).send({ error: { code: "not_found", message: "Node not found" } });
    return { node: reachability.present(node) };
  });
  app.post("/api/nodes/refresh-live", async () => reachability.checkNow());
  app.post("/api/reachability/interval", async (request) => {
    const body = z.object({ intervalMs: z.number().int().min(10_000).max(120_000) }).parse(request.body);
    const intervalMs = reachability.setIntervalMs(body.intervalMs);
    return { intervalMs, freshnessMs: reachability.freshnessMs() };
  });
  app.post("/api/nodes/commission", async (request, reply) => {
    const body = commissionRequestSchema.parse(request.body);
    const wantsStream = String(request.headers.accept ?? "").includes("application/x-ndjson");
    if (!wantsStream) {
      return matter.commission(body);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    const send = (event: unknown) => {
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const result = await matter.commission(body, (event) => send({ type: "progress", ...event }));
      send({ type: "result", result });
    } catch (error) {
      const code = error instanceof MatterOperationError ? error.code : "request_failed";
      const message = redact(error instanceof Error ? error.message : "Commissioning failed");
      send({ type: "failed", code, message });
    } finally {
      reply.raw.end();
    }
  });
  app.get("/api/controller/peers", async () => ({ peers: await matter.listUnsavedPeers() }));
  app.get("/api/controller/reconciliation", async () => matter.reconciliationPlan());
  app.post("/api/nodes/recover", async (request, reply) => {
    const body = recoverExistingRequestSchema.parse(request.body);
    const wantsStream = String(request.headers.accept ?? "").includes("application/x-ndjson");
    if (!wantsStream) {
      return matter.recoverExisting(body);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    const send = (event: unknown) => {
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const result = await matter.recoverExisting(body, (event) => send({ type: "progress", ...event }));
      send({ type: "result", result });
    } catch (error) {
      const code = error instanceof MatterOperationError ? error.code : "request_failed";
      const message = redact(error instanceof Error ? error.message : "Recovery failed");
      const detail = error instanceof MatterOperationError ? error.detail : null;
      send({ type: "failed", code, message, detail });
    } finally {
      reply.raw.end();
    }
  });
  app.post("/api/nodes/:id/remove", async (request) => {
    const { id } = request.params as { id: string };
    const body = removeNodeRequestSchema.parse(request.body);
    return matter.removeNode(id, body);
  });
  app.post("/api/nodes/:id/refresh", async (request) => {
    const { id } = request.params as { id: string };
    return reachability.refreshOne(id);
  });
  app.post("/api/nodes/:id/commissioning-window", async (request) => {
    const { id } = request.params as { id: string };
    const node = await nodes.getById(id);
    if (!node) throw new Error("Node not found");
    return matter.openCommissioningWindow(id);
  });
  app.post("/api/nodes/:id/rename", async (request) => {
    const { id } = request.params as { id: string };
    const body = renameNodeSchema.parse(request.body);
    const node = await nodes.getById(id);
    if (!node) throw new Error("Node not found");
    const updated = {
      ...node,
      name: body.name,
      updatedAt: new Date().toISOString(),
      history: [...node.history, { at: new Date().toISOString(), kind: "rename", detail: `Renamed to ${body.name}` }],
    };
    await nodes.save(updated);
    return { node: updated };
  });

  app.get("/api/catalog", async (request) => {
    const query = request.query as { q?: string; status?: "verified" | "experimental" | "template" | "planned" };
    const components = await catalog.search(query.q ?? "", query.status);
    return { components };
  });
  app.get("/api/catalog/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const component = await catalog.getById(id);
    if (!component) return reply.code(404).send({ error: { code: "not_found", message: "Component not found" } });
    return { component };
  });

  const sendLibraryError = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
    if (error instanceof FirmwareLibraryError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, detail: error.detail },
      });
    }
    throw error;
  };
  app.get("/api/firmware-library", async (_request, reply) => {
    try {
      const components = await library.list();
      if (!catalogueEnabled()) return { components, pending: [], catalogue: "file" };
      return { components, pending: await listPending(), catalogue: "neon" };
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });
  app.get("/api/catalogue/storage", async (_request, reply) => {
    if (!catalogueEnabled()) return { configured: false, message: "The Neon catalogue is not configured." };
    try {
      return await catalogueStorage();
    } catch {
      return reply.code(503).send({ error: { code: "catalogue_unavailable", message: "Database storage could not be measured." } });
    }
  });
  app.post("/api/firmware-library/stage", async (request, reply) => {
    const body = libraryStageRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await library.stage(body.files));
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });
  app.post("/api/firmware-library/validate", async (request, reply) => {
    const body = libraryValidateRequestSchema.parse(request.body);
    try {
      return await library.validate(body);
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });
  app.post("/api/firmware-library", async (request, reply) => {
    const body = libraryCreateRequestSchema.parse(request.body);
    try {
      return reply.code(201).send({ component: await library.create(body) });
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });
  app.get("/api/firmware-library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const component = await library.get(id);
    if (!component) return reply.code(404).send({ error: { code: "not_found", message: "Firmware component not found." } });
    return { component };
  });
  app.get("/api/firmware-composition", async () => {
    const jobs = await firmware.list();
    const compiled = jobs.filter((job) => job.status === "succeeded"
      && !job.simulated
      && job.request.baseFirmwareId === "matter-core-iotedu"
      && job.request.componentIds.includes("custom-dht11")
      && job.artifacts.some((item) => item.name === "sensors.bin" && !item.simulated));
    const latest = compiled.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!latest) return compositionStatus();
    return {
      available: true,
      reason: "A compiled ESP32-H2 package from Matter core revision 2 and DHT11 revision 2 is available to the installer. It has not been hardware-verified.",
      buildId: latest.id,
      softwareVersion: latest.request.softwareVersion,
      softwareVersionString: latest.request.softwareVersionString,
    };
  });
  app.get("/api/node-types", async (_request, reply) => {
    try {
      return {
        catalogue: "neon",
        requiredFlashBytes: paths.profile.flashSizeBytes,
        nodeTypes: await listNodeTypes(await firmware.list(), paths.dataDir, paths.firmwareArchiveDir),
      };
    } catch (error) {
      if (error instanceof CatalogueError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.code(503).send({ error: { code: "catalogue_unavailable", message: "Node Types could not be loaded from the firmware catalogue." } });
    }
  });
  app.get("/api/firmware-releases", async (_request, reply) => {
    try {
      return { releases: await listFirmwareReleases() };
    } catch (error) {
      if (error instanceof CatalogueError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.code(503).send({ error: { code: "catalogue_unavailable", message: "Firmware release records are unavailable." } });
    }
  });
  app.post("/api/firmware-composition", async (request, reply) => {
    const parsed = z.object({
      gpio: z.number().int().min(0).max(27).optional(),
      nodeType: z.enum(["environmental-dht11", "photosensitive-light", "rgb-led"]).optional(),
      intent: z.enum(["reuse", "new-release"]).optional(),
      softwareVersion: z.number().int().min(1).max(65535).optional(),
    }).safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "invalid_composition", message: "Choose a Node Type. GPIO must be an integer from 0 to 27." } });
    }
    const nodeType = parsed.data.nodeType ?? "environmental-dht11";
    if (nodeType === "photosensitive-light" && parsed.data.gpio != null && parsed.data.gpio !== 4) {
      return reply.code(400).send({ error: { code: "gpio_not_supported", message: "Photosensitive revision 2 reads ADC channel 3, which is GPIO 4 on ESP32-H2." } });
    }
    if (nodeType === "rgb-led" && parsed.data.gpio != null) {
      return reply.code(400).send({ error: { code: "gpio_not_supported", message: "RGB revision 2 uses red GPIO 4, green GPIO 10 and blue GPIO 5." } });
    }
    try {
      const result = nodeType === "environmental-dht11"
        ? await startDht11Composition(firmware, {
            repoRoot: paths.repoRoot,
            dataDir: paths.dataDir,
            gpio: parsed.data.gpio ?? 4,
            intent: parsed.data.intent,
            softwareVersion: parsed.data.softwareVersion,
          })
        : await startNodeTypeComposition(firmware, {
            nodeTypeId: nodeType,
            repoRoot: paths.repoRoot,
            dataDir: paths.dataDir,
            intent: parsed.data.intent,
            softwareVersion: parsed.data.softwareVersion,
          });
      if (!result.reused && result.job.status === "failed") {
        const issue = result.job.validation.issues.find((item) => item.level === "error");
        return reply.code(issue?.code === "toolchain_not_configured" ? 503 : 409).send({
          job: result.job,
          reused: false,
          error: { code: issue?.code ?? "composition_rejected", message: issue?.message ?? result.job.logs.at(-1) ?? "Composition did not start." },
        });
      }
      return reply.code(result.reused ? 200 : 202).send({ job: result.job, reused: result.reused });
    } catch (error) {
      if (error instanceof CatalogueError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.code(503).send({ error: { code: "catalogue_unavailable", message: "The firmware catalogue database is unavailable. Composition did not start." } });
    }
  });
  app.post("/api/firmware-recipes", async (request, reply) => {
    const body = request.body as { componentIds?: unknown };
    if (!Array.isArray(body?.componentIds) || body.componentIds.some((id) => typeof id !== "string")) {
      return reply.code(400).send({ error: { code: "invalid_selection", message: "Choose components from the catalogue." } });
    }
    try {
      return reply.code(201).send(await saveSelection(body.componentIds));
    } catch (error) {
      if (error instanceof CatalogueError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.code(503).send({ error: { code: "catalogue_unavailable", message: "The firmware catalogue database is unavailable. The selection was not saved." } });
    }
  });
  app.put("/api/firmware-library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = libraryUpdateRequestSchema.parse(request.body);
    try {
      return { component: await library.update(id, body) };
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });

  app.get("/api/firmware/layout", async () => loadReferenceLayout(paths.repoRoot, paths.profile));

  app.post("/api/builds/validate", async (request) => {
    const body = firmwareBuildRequestSchema.parse(request.body);
    return firmware.validate(body);
  });
  app.post("/api/builds", async (request, reply) => {
    const body = firmwareBuildRequestSchema.parse(request.body);
    const job = await firmware.build(body);
    if (job.status === "failed") {
      const message = job.validation.issues.find((issue) => issue.level === "error")?.message
        ?? job.logs.at(-1)
        ?? "Build rejected";
      return reply.code(400).send({ job, error: { code: "build_rejected", message } });
    }
    return reply.code(job.status === "running" ? 202 : 201).send({ job });
  });
  app.post("/api/builds/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await firmware.cancel(id);
    if (!job) return reply.code(404).send({ error: { code: "not_found", message: "Build not found" } });
    return { job };
  });
  app.get("/api/builds/:id/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const log = await firmware.readLog(id);
    if (!log) return reply.code(404).send({ error: { code: "not_found", message: "Build not found" } });
    return log;
  });
  app.get("/api/builds", async () => ({
    jobs: await Promise.all((await firmware.list()).map(async (job) => ({
      ...job,
      packageLocation: await classifyFirmwareStorage({ dataDir: paths.dataDir, job, archiveDir: paths.firmwareArchiveDir }),
    }))),
  }));
  app.get("/api/builds/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await firmware.get(id);
    if (!job) return reply.code(404).send({ error: { code: "not_found", message: "Build not found" } });
    return {
      job: {
        ...job,
        packageLocation: await classifyFirmwareStorage({ dataDir: paths.dataDir, job, archiveDir: paths.firmwareArchiveDir }),
      },
    };
  });
  app.get("/api/builds/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await firmware.get(id);
    if (!job) return reply.code(404).send({ error: { code: "not_found", message: "Build not found" } });
    return { artifacts: job.artifacts, simulated: job.simulated, verification: job.verification };
  });
  app.get("/api/builds/:id/download/:name", async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const job = await firmware.get(id);
    if (!job) return reply.code(404).send({ error: { code: "not_found", message: "Build not found" } });
    const safeName = path.basename(name);
    const artifact = safeName === name ? job.artifacts.find((item) => item.name === safeName) : undefined;
    if (!artifact) return reply.code(404).send({ error: { code: "not_found", message: "Artifact not found" } });
    if (artifact.simulated || job.simulated || job.verification === "simulated") {
      return reply.code(409).send({
        error: { code: "simulated_artifact", message: "Simulated packages cannot be downloaded as firmware." },
      });
    }
    const diagnostic = safeName === "build.log" || safeName === "sdkconfig";
    if (job.status !== "succeeded" && !diagnostic) {
      return reply.code(409).send({
        error: { code: "build_not_successful", message: "Only a successful build can be downloaded as firmware." },
      });
    }
    const root = path.resolve(paths.dataDir);
    const absolute = path.resolve(root, artifact.relativePath);
    if (artifact.relativePath && !absolute.startsWith(`${root}${path.sep}`)) {
      return reply.code(400).send({ error: { code: "rejected_path", message: "Artifact path is outside the data directory." } });
    }
    try {
      const resolved = await readFirmwareArtifact({
        dataDir: paths.dataDir,
        archiveDir: paths.firmwareArchiveDir,
        buildId: job.id,
        name: safeName,
        relativePath: artifact.relativePath,
        expectedSha256: artifact.sha256,
        verify: /^[a-f0-9]{64}$/.test(artifact.sha256),
      });
      return reply.header("content-disposition", `attachment; filename="${safeName}"`).type("application/octet-stream").send(resolved.bytes);
    } catch (error) {
      if (error instanceof FirmwareArtifactError) {
        const status = error.code === "artifact_mismatch" ? 409 : error.code === "rejected_path" ? 400 : 404;
        return reply.code(status).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.get("/api/programmer/ports", async () => {
    const devices = await programmer.portDetails();
    return { ports: devices.map((device) => device.path), devices };
  });
  app.get("/api/programmer/toolchain", async () => programmer.toolchainReport());
  app.post("/api/programmer/ports/release", async (request, reply) => {
    const body = z.object({ port: z.string().min(1).max(128) }).strict().parse(request.body);
    try {
      return programmer.releaseOwnedConsole(body.port);
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/recovery/backup/verify", async (request, reply) => {
    const body = z.object({
      mac: z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/),
    }).strict().parse(request.body);
    const backup = await programmer.verifyStoredBackup(body.mac);
    if (!backup) {
      return reply.code(404).send({
        error: { code: "backup_missing", message: "No stored backup was found for that MAC address. Create one with Backup before erase." },
      });
    }
    return { backup };
  });
  app.post("/api/programmer/recovery/assess", async (request, reply) => {
    const body = z.object({
      port: z.string().max(128).optional(),
      consolePort: z.string().max(128).nullable().optional(),
      buildId: z.string().max(80).optional(),
    }).parse(request.body ?? {});
    try {
      return await programmer.assessRecovery({
        port: body.port ?? "",
        consolePort: body.consolePort ?? null,
        buildId: body.buildId ?? "",
      });
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/recovery/backup", async (request, reply) => {
    const body = z.object({
      port: z.string().min(1).max(128),
      consolePort: z.string().max(128).nullable().optional(),
      buildId: z.string().min(1).max(80),
    }).parse(request.body);
    try {
      return await programmer.createRecoveryBackup({
        port: body.port,
        consolePort: body.consolePort ?? null,
        buildId: body.buildId,
      });
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.get("/api/programmer/recovery/backups/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const file = await programmer.exportRecoveryBackup(id);
      return reply.header("content-disposition", `attachment; filename="${file.filename}"`).type("application/x-tar").send(file.bytes);
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/recovery/erase", async (request, reply) => {
    try {
      const session = await programmer.eraseDevice(eraseRequestSchema.parse(request.body));
      return { session };
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.get("/api/programmer/recovery/sessions", async () => ({ sessions: await programmer.listEraseSessions() }));
  app.post("/api/programmer/console", async (request, reply) => {
    const body = z.object({
      port: z.string().min(1).max(128),
      seconds: z.number().int().min(2).max(8).optional(),
    }).parse(request.body);
    try {
      return await programmer.captureConsole(body.port, body.seconds ?? 6);
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/factory-reset-watch", async (request, reply) => {
    const body = z.object({
      port: z.string().min(1).max(128),
      seconds: z.number().int().min(30).max(60).optional(),
      selectedMac: z.string().max(32).nullable().optional(),
    }).parse(request.body);
    try {
      const watched = await programmer.watchFactoryReset(body.port, body.seconds, body.selectedMac ?? null);
      if (watched.assessment.affectsStoredCredentials && watched.assessment.mac && !watched.assessment.identityConflict) {
        const now = new Date().toISOString();
        for (const node of await nodes.list()) {
          const nodeMac = node.hardwareMac?.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
          const resetMac = watched.assessment.mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
          if (!nodeMac || nodeMac !== resetMac || node.simulated) continue;
          await nodes.save({
            ...node,
            operationalReverification: "required",
            updatedAt: now,
            history: [...node.history, { at: now, kind: "factory_reset", detail: `${watched.assessment.detail} The management record and the controller peer were kept.` }],
          });
        }
      }
      return watched;
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/probe", async (request, reply) => {
    const body = request.body as { port?: string };
    try {
      return await programmer.probe(typeof body.port === "string" ? body.port : "");
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/plan", async (request, reply) => {
    const body = request.body as { buildId?: string; port?: string };
    try {
      return await programmer.describeWrite(typeof body.buildId === "string" ? body.buildId : "", typeof body.port === "string" ? body.port : "");
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/sessions", async (request, reply) => {
    try {
      const session = await programmer.start(programRequestSchema.parse(request.body));
      const code = session.status === "running" ? 202 : session.status === "succeeded" ? 201 : 200;
      return reply.code(code).send({ session: publicSession(session) });
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.get("/api/programmer/sessions", async () => ({ sessions: (await programmer.list()).map((session) => publicSession(session)) }));
  app.get("/api/hardware/installations", async () => ({ installations: await programmer.listInstallations() }));
  app.get("/api/programmer/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await programmer.get(id);
    if (!session) return reply.code(404).send({ error: { code: "not_found", message: "Programming session not found" } });
    return { session: publicSession(session) };
  });
  app.post("/api/programmer/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await programmer.cancel(id);
    if (!session) return reply.code(404).send({ error: { code: "not_found", message: "Programming session not found" } });
    return { session: publicSession(session) };
  });
  app.get("/api/programmer/sessions/:id/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const log = await programmer.readLog(id);
    if (!log) return reply.code(404).send({ error: { code: "not_found", message: "Programming session not found" } });
    return log;
  });
  app.post("/api/programmer/sessions/:id/verify-boot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { consolePort?: string };
    try {
      return { session: publicSession(await programmer.verifyBoot(id, typeof body.consolePort === "string" ? body.consolePort : "")) };
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/sessions/:id/monitor", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { session: publicSession(await programmer.monitor(id)) };
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.post("/api/programmer/sessions/:id/save-log", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await programmer.saveLog(id);
    } catch (error) {
      if (error instanceof ProgrammerError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.get("/api/programmer/sessions/:id/saved-log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const text = await programmer.savedLog(id);
    if (text === null) return reply.code(404).send({ error: { code: "not_found", message: "No saved log" } });
    return reply.type("text/plain").send(text);
  });

  app.post("/api/uploads", async (request, reply) => {
    const body = request.body as { fileName?: string; content?: string };
    const fileName = path.basename(body.fileName ?? "");
    const extension = path.extname(fileName).toLowerCase();
    if (!fileName || fileName !== body.fileName || !UPLOAD_EXTENSIONS.has(extension)) {
      return reply.code(400).send({
        error: { code: "rejected_upload", message: "Only a single .c, .h, .cpp, .hpp, or .txt file name is accepted." },
      });
    }
    const content = body.content ?? "";
    if (content.length > 200_000) {
      return reply.code(400).send({ error: { code: "upload_too_large", message: "Upload exceeds 200 kB." } });
    }
    const id = randomUUID();
    const dir = path.join(paths.dataDir, "uploads", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), content, "utf8");
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ id, fileName, trusted: false, compiled: false }, null, 2),
      "utf8",
    );
    return reply.code(201).send({
      uploadId: id,
      trusted: false,
      message: "Stored as untrusted source. It has not been compiled or executed.",
    });
  });

  app.post("/api/ai/draft", async (request, reply) => {
    aiDraftRequestSchema.parse(request.body);
    return reply.code(503).send({
      error: {
        code: "ai_disabled",
        message: "No AI provider is configured. The rest of IoT.Edu continues to work without one.",
      },
    });
  });

  app.post("/api/controller/peers/retire", async (request) => {
    const body = retirePeerRequestSchema.parse(request.body);
    return matter.retireUnsavedPeer(body);
  });
  app.get("/api/controller/status", async () => matter.getControllerStatus());
  app.post("/api/controller/identity", async (request) => {
    const body = request.body as { confirm?: boolean };
    if (body?.confirm !== true) {
      return { ...(await matter.getControllerStatus()), message: "Creating a controller identity requires confirmation." };
    }
    return matter.createIdentity();
  });

  app.get("/api/settings", async () => {
    const controller = await matter.getControllerStatus();
    return {
    applicationVersion: "0.1.0",
    dataDir: paths.dataDir,
    buildMode: nativeAvailable ? "native" : "mock_only",
    expectedIdfVersion: "v5.4.1",
    idfPathConfigured: toolchain.idfPathConfigured,
    espMatterPathConfigured: toolchain.espMatterPathConfigured,
    toolchainProbed: true,
    dockerProbed: false,
    controllerIdentityLoaded: controller.identityLoaded,
    fabricLabel: controller.fabricLabel,
    reachabilityIntervalMs: reachability.intervalMs,
    reachabilityFreshnessMs: reachability.freshnessMs(),
    notes: [
      nativeAvailable
        ? "Native builds use the configured ESP-IDF v5.4.1 environment. Docker remains unavailable."
        : "Native builds need IDF_PATH, ESP_MATTER_PATH, and IDF_ACTIVATE. Mock packages remain available.",
      nativeAvailable
        ? "A compiled package can be written over USB. NVS is not erased. Writing the image does not verify startup or commission the node."
        : "USB writing needs the same ESP-IDF environment as a native build. Simulated packages cannot be written.",
      controller.message,
    ],
  };
  });

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const buildsNow = await firmware.list();
    reply.raw.write(`data: ${JSON.stringify({ builds: buildsNow })}\n\n`);
    reply.raw.end();
  });

  app.addHook("onClose", async () => {
    await reachability.stop();
    await matter.close();
  });

  app.addHook("onSend", async (request, _reply, payload) => {
    if (typeof payload === "string" && request.url.startsWith("/api/")) {
      const keepOnboarding = request.url.split("?")[0] === "/api/hardware/installations";
      return redact(payload, { keepOnboarding });
    }
    return payload;
  });

  return app;
}

export async function readBoardProfile(repoRoot: string): Promise<BoardProfile> {
  const raw = JSON.parse(await readFile(boardProfileFile(repoRoot), "utf8")) as BoardProfile;
  return raw;
}
