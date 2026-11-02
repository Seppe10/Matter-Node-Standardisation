import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compiledTestOnboarding, onboardingDecision, type BuildJob, type FirmwareBuildRequest, type MatterManagementService, type ProgramSession } from "@iotedu/contracts";
import { componentManifestDir } from "@iotedu/contracts/paths";
import type { NativeBuildResult, NativeBuildSpec } from "@iotedu/firmware-builder/native";
import type { UsbRunnerResult, UsbRunnerSpec } from "@iotedu/firmware-builder/programmer";
import { afterEach, describe, expect, it } from "vitest";
import { MatterOperationError } from "@iotedu/matter-controller";
import { buildApp, readBoardProfile } from "./app.js";
import type { AppReset, MonitorRunner, OccupantLookup, PortClassifier, PortLister, UsbRunner } from "./programmer-service.js";
import type { NativeRunner } from "./services.js";
import { JsonNodeRepository } from "./store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function createApp(options: {
  nativeAvailable?: boolean;
  runNative?: NativeRunner;
  dataDir?: string;
  runProgram?: UsbRunner;
  runMonitor?: MonitorRunner;
  listPorts?: PortLister;
  classifyPorts?: PortClassifier;
  appReset?: AppReset;
  occupants?: OccupantLookup;
  matter?: MatterManagementService;
  reachabilityIntervalMs?: number;
} = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(path.join(tmpdir(), "iotedu-"));
  const profile = await readBoardProfile(repoRoot);
  const app = await buildApp({
    dataDir,
    repoRoot,
    catalogDir: componentManifestDir(repoRoot),
    profile,
    nativeAvailable: options.nativeAvailable ?? false,
    runNative: options.runNative,
    runProgram: options.runProgram,
    runMonitor: options.runMonitor,
    listPorts: options.listPorts,
    classifyPorts: options.classifyPorts ?? (async (ports) => ports.map((port) => ({ path: port, role: "unknown" as const, label: "USB serial" }))),
    appReset: options.appReset,
    occupants: options.occupants ?? (async () => []),
    matter: options.matter,
    reachabilityIntervalMs: options.reachabilityIntervalMs,
  });
  return { app, dataDir };
}

async function waitForBuild(app: { inject(options: { method: "GET"; url: string }): Promise<{ json(): { job: BuildJob } }> }, id: string): Promise<BuildJob> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/builds/${id}` });
    const job = response.json().job;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("build did not finish");
}

const compiled = async (spec: NativeBuildSpec): Promise<NativeBuildResult> => {
  await mkdir(spec.artifactDir, { recursive: true });
  const body = Buffer.from(`compiled ${spec.softwareVersion} ${spec.softwareVersionString}`);
  await writeFile(path.join(spec.artifactDir, "sensors.ota"), body);
  spec.onLog(`compiled ${spec.softwareVersionString}`);
  return {
    ok: true,
    cancelled: false,
    durationMs: 15,
    partitionLayoutId: "layout",
    issues: [],
    artifacts: [{ name: "sensors.ota", sha256: "abc", size: body.length, deployable: true }],
    summary: [`Package ${spec.softwareVersionString} is compiled.`],
  };
};

const mockBuild = (overrides: Partial<FirmwareBuildRequest> = {}): FirmwareBuildRequest => ({
  mode: "mock",
  codeSource: "approved",
  nodeId: null,
  hardware: "esp32h2",
  baseFirmwareId: "iotedu-core",
  componentIds: ["iotedu-dht11"],
  pins: [{ componentId: "iotedu-dht11", pinName: "DHT11_DATA", gpio: 4 }],
  softwareVersion: 2,
  softwareVersionString: "1.1",
  uploadId: null,
  confirm: true,
  ...overrides,
});

const programPort = "/dev/cu.usbmodem1101";

function programPayload(overrides: Record<string, unknown> = {}) {
  return {
    buildId: "compiled-package",
    port: programPort,
    intent: "initial_install",
    confirm: true,
    preserveNvs: true,
    ...overrides,
  };
}

async function seedCompiledPackage(dataDir: string): Promise<{ hash: string; dir: string }> {
  const dir = path.join(dataDir, "builds", "compiled-package", "artifacts");
  await mkdir(dir, { recursive: true });
  const bootloader = Buffer.from("boot");
  const table = Buffer.from("table");
  const otadata = Buffer.from("ota");
  const application = Buffer.from("app-image-v1.2.0");
  const merged = Buffer.alloc(0x20000 + application.length, 0xff);
  merged.set(bootloader, 0);
  merged.set(table, 0xc000);
  merged.set(otadata, 0x1d000);
  merged.set(application, 0x20000);
  const flasher = {
    write_flash_args: ["--flash_mode", "dio", "--flash_size", "4MB", "--flash_freq", "48m"],
    flash_files: {
      "0x0": "bootloader/bootloader.bin",
      "0xc000": "partition_table/partition-table.bin",
      "0x1d000": "ota_data_initial.bin",
      "0x20000": "sensors.bin",
    },
    extra_esptool_args: { chip: "esp32h2", before: "default_reset", after: "hard_reset" },
    bootloader: { encrypted: "false" },
    app: { encrypted: "false" },
    "partition-table": { encrypted: "false" },
    otadata: { encrypted: "false" },
  };
  const bodies: Record<string, Buffer | string> = {
    "bootloader.bin": bootloader,
    "partition-table.bin": table,
    "ota_data_initial.bin": otadata,
    "sensors.bin": application,
    "usb-image.bin": merged,
    "flasher_args.json": JSON.stringify(flasher),
  };
  for (const [name, body] of Object.entries(bodies)) {
    await writeFile(path.join(dir, name), body);
  }
  const now = new Date().toISOString();
  const record: BuildJob = {
    id: "compiled-package",
    simulated: false,
    verification: "compiled",
    status: "succeeded",
    request: mockBuild({ mode: "native", softwareVersion: 3, softwareVersionString: "1.2.0" }),
    validation: { ok: true, issues: [] },
    logs: ["compiled"],
    artifacts: Object.keys(bodies).map((name) => ({
      name,
      relativePath: path.join("builds", "compiled-package", "artifacts", name),
      sha256: "abc",
      size: 4,
      simulated: false,
      deployable: false,
    })),
    partitionLayoutId: "layout",
    durationMs: 5,
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([record]));
  return { hash: createHash("sha256").update(application).digest("hex"), dir };
}

async function waitForProgram(
  app: { inject(options: { method: "GET"; url: string }): Promise<{ json(): { session: ProgramSession } }> },
  id: string,
  done: (session: ProgramSession) => boolean,
): Promise<ProgramSession> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/programmer/sessions/${id}` });
    const session = response.json().session;
    if (done(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("programming session did not reach the expected state");
}

describe("local API", () => {
  const closers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((app) => app.close()));
  });

  it("persists a simulated node across a new repository", async () => {
    const { app, dataDir } = await createApp();
    closers.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/nodes/commission",
      payload: {
        path: "smart_home",
        name: "Lab sensor",
        pairingCode: "3497-011-2332",
        confirm: true,
        acknowledgeSimulation: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.matterSessionOpened).toBe(false);
    expect(body.node.simulated).toBe(true);
    expect(body.node.matterNodeId).toBeNull();

    const reopened = new JsonNodeRepository(path.join(dataDir, "nodes.json"));
    const stored = await reopened.getById(body.node.id);
    expect(stored?.name).toBe("Lab sensor");
    expect(created.body).not.toContain("3497-011-2332");
    await expect(readFile(path.join(dataDir, "audit.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams a simulated commission without echoing the pairing code", async () => {
    const { app, dataDir } = await createApp();
    closers.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/nodes/commission",
      headers: { accept: "application/x-ndjson" },
      payload: {
        path: "smart_home",
        name: "Lab sensor",
        pairingCode: "3497-011-2332",
        confirm: true,
        acknowledgeSimulation: true,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(String(created.headers["content-type"])).toContain("application/x-ndjson");
    expect(created.body).toContain('"type":"result"');
    expect(created.body).not.toContain("3497");
    await expect(readFile(path.join(dataDir, "audit.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("searches the catalogue and refuses a planned driver in a native build", async () => {
    const { app } = await createApp();
    closers.push(app);
    const found = await app.inject({ method: "GET", url: "/api/catalog?q=TemperatureMeasurement" });
    expect(found.json().components.map((item: { id: string }) => item.id)).toEqual(["iotedu-dht11"]);

    const native = await app.inject({
      method: "POST",
      url: "/api/builds",
      payload: mockBuild({ mode: "native", componentIds: ["iotedu-ldr"], pins: [] }),
    });
    expect(native.statusCode).toBe(400);
    const job = native.json().job;
    expect(job.status).toBe("failed");
    expect(job.artifacts).toEqual([]);
    expect(job.logs.join("\n")).toMatch(/planned|not available/i);
  });

  it("labels a mock package as simulated", async () => {
    const { app } = await createApp();
    closers.push(app);
    const commissioned = await app.inject({
      method: "POST",
      url: "/api/nodes/commission",
      payload: { path: "new_device", name: "Blank", confirm: true, acknowledgeSimulation: true },
    });
    const nodeId = commissioned.json().node.id as string;

    const built = await app.inject({ method: "POST", url: "/api/builds", payload: mockBuild({ nodeId }) });
    expect(built.statusCode).toBe(201);
    const job = built.json().job;
    expect(job.simulated).toBe(true);
    expect(job.status).toBe("simulated");
    expect(job.artifacts[0].deployable).toBe(false);
    expect(job.logs.join("\n")).toMatch(/ESP-IDF was not invoked/);

    const refreshed = await app.inject({ method: "POST", url: `/api/nodes/${nodeId}/refresh` });
    expect(refreshed.json().liveRead).toBe("unavailable");
    expect(refreshed.json().node.softwareVersion).toBeNull();
  });

  it("keeps a stored node registered without calling it online before a fresh read", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-"));
    const stored = {
      id: "node-2",
      name: "ESP32-H2",
      simulated: false,
      matterNodeId: "2",
      vendorId: 65521,
      productId: 32768,
      softwareVersion: 4,
      softwareVersionString: "1.3.0",
      hardware: "ESP32-H2",
      reachable: true,
      connection: "reachable",
      fabricLabel: "IoT.Edu Management",
      commissionedFabricCount: 3,
      otherFabricCount: 2,
      partitionLayoutId: null,
      installedComponents: [],
      history: [],
      createdAt: "2026-10-22T13:00:00.000Z",
      updatedAt: "2026-10-22T13:43:29.729Z",
      lastCommunicationAt: "2026-10-22T13:43:29.729Z",
    };
    await writeFile(path.join(dataDir, "nodes.json"), JSON.stringify([stored]));
    const repo = new JsonNodeRepository(path.join(dataDir, "nodes.json"));
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const matter: MatterManagementService = {
      getCapabilities: () => Promise.reject(new Error("unused")),
      getControllerStatus: () => Promise.reject(new Error("unused")),
      createIdentity: () => Promise.reject(new Error("unused")),
      restore: () => Promise.resolve(),
      close: () => Promise.resolve(),
      commission: () => Promise.reject(new Error("unused")),
      listUnsavedPeers: () => Promise.resolve([]),
      recoverExisting: () => Promise.reject(new Error("unused")),
      reconciliationPlan: () => Promise.resolve({
        controllerIdentityPreserved: true,
        identityReady: true,
        executed: false,
        credentialStoreEdited: false,
        peers: [{ matterNodeId: "2", commissionedAt: 2, savedNodeId: "node-2", role: "saved-managed-node" }],
        retireAfterFactoryReset: "ClientNode.delete() was not called.",
        notUsed: [],
        blocker: null,
      }),
      refreshNode: async (id: string) => {
        calls += 1;
        await gate;
        const node = await repo.getById(id);
        if (!node) throw new Error("missing");
        const updated = { ...node, presence: "online" as const, reachable: true, lastReachabilityCheckAt: new Date().toISOString() };
        await repo.save(updated);
        return { node: updated, liveRead: "read" as const, message: "Administrative clusters were read." };
      },
      removeNode: () => Promise.reject(new Error("unused")),
      retireUnsavedPeer: () => Promise.reject(new Error("unused")),
      openCommissioningWindow: () => Promise.resolve({ opened: false, message: "unused" }),
      readInstalledSoftwareVersion: () => Promise.resolve(null),
    };
    const { app } = await createApp({ dataDir, matter, reachabilityIntervalMs: 0 });
    closers.push(app);
    const listed = await app.inject({ method: "GET", url: "/api/nodes" });
    expect(listed.json().nodes[0].presence).toBe("unknown");
    expect(listed.json().nodes[0].reachable).toBeNull();
    expect(listed.json().nodes[0].softwareVersionString).toBe("1.3.0");
    expect(listed.json().nodes[0].matterNodeId).toBe("2");
    expect(calls).toBe(0);
    const first = app.inject({ method: "POST", url: "/api/nodes/refresh-live" });
    const second = app.inject({ method: "POST", url: "/api/nodes/refresh-live" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.json().nodes[0].presence).toBe("online");
    expect(two.json().nodes[0].presence).toBe("online");
    expect(calls).toBe(1);
  });

  it("forgets a local record and refuses mock decommission", async () => {
    const { app } = await createApp({ reachabilityIntervalMs: 0 });
    closers.push(app);
    const commissioned = await app.inject({
      method: "POST",
      url: "/api/nodes/commission",
      payload: { path: "smart_home", name: "Bench", confirm: true, acknowledgeSimulation: true },
    });
    const nodeId = commissioned.json().node.id as string;
    const blocked = await app.inject({
      method: "POST",
      url: `/api/nodes/${nodeId}/remove`,
      payload: { mode: "decommission", confirm: true, phrase: "Bench" },
    });
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
    expect(blocked.body).toContain("Nothing was removed");
    const kept = await app.inject({ method: "GET", url: `/api/nodes/${nodeId}` });
    expect(kept.statusCode).toBe(200);
    const removed = await app.inject({
      method: "POST",
      url: `/api/nodes/${nodeId}/remove`,
      payload: { mode: "forget", confirm: true, phrase: "Bench" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().physicalFabricRemoved).toBe(false);
    const gone = await app.inject({ method: "GET", url: `/api/nodes/${nodeId}` });
    expect(gone.statusCode).toBe(404);
  });

  it("warns when a package version is not higher than the installed firmware", async () => {
    const { app, dataDir } = await createApp();
    closers.push(app);
    const commissioned = await app.inject({
      method: "POST",
      url: "/api/nodes/commission",
      payload: { path: "smart_home", name: "Versioned", confirm: true, acknowledgeSimulation: true },
    });
    const nodeId = commissioned.json().node.id as string;
    const nodes = new JsonNodeRepository(path.join(dataDir, "nodes.json"));
    const node = await nodes.getById(nodeId);
    if (!node) throw new Error("missing node");
    await nodes.save({ ...node, softwareVersion: 1, softwareVersionString: "1.0" });

    const higher = await app.inject({
      method: "POST",
      url: "/api/builds/validate",
      payload: mockBuild({ nodeId, softwareVersion: 2, softwareVersionString: "1.1.0" }),
    });
    expect(higher.json().ok).toBe(true);
    expect(higher.json().issues.some((issue: { code: string }) => issue.code === "version_not_higher")).toBe(false);

    const same = await app.inject({
      method: "POST",
      url: "/api/builds/validate",
      payload: mockBuild({ nodeId, softwareVersion: 1, softwareVersionString: "1.0" }),
    });
    expect(same.json().ok).toBe(true);
    expect(same.json().issues.some((issue: { code: string }) => issue.code === "version_not_higher")).toBe(true);
  });

  it("records a compiled package, serves it for download, and keeps it after restart", async () => {
    const { app, dataDir } = await createApp({ nativeAvailable: true, runNative: compiled });
    closers.push(app);
    const started = await app.inject({
      method: "POST",
      url: "/api/builds",
      payload: mockBuild({ mode: "native", softwareVersion: 2, softwareVersionString: "1.1.0" }),
    });
    expect(started.statusCode).toBe(202);
    const job = await waitForBuild(app, started.json().job.id as string);
    expect(job.status).toBe("succeeded");
    expect(job.simulated).toBe(false);
    expect(job.verification).toBe("compiled");
    expect(job.artifacts.some((artifact) => artifact.name === "sensors.ota" && artifact.deployable)).toBe(true);

    const downloaded = await app.inject({ method: "GET", url: `/api/builds/${job.id}/download/sensors.ota` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("compiled 2 1.1.0");

    const blocked = await app.inject({ method: "POST", url: "/api/builds", payload: mockBuild() });
    const simulated = blocked.json().job as BuildJob;
    const refused = await app.inject({ method: "GET", url: `/api/builds/${simulated.id}/download/SIMULATED.txt` });
    expect(refused.statusCode).toBe(409);

    await app.close();
    closers.splice(closers.indexOf(app), 1);
    const reopened = await createApp({ dataDir, nativeAvailable: true, runNative: compiled });
    closers.push(reopened.app);
    const again = await reopened.app.inject({ method: "GET", url: `/api/builds/${job.id}` });
    expect(again.json().job.status).toBe("succeeded");
    expect(again.json().job.verification).toBe("compiled");
    expect(again.json().job.request.softwareVersionString).toBe("1.1.0");
  });

  it("reports a failed native build without a deployable package", async () => {
    const failed: NativeRunner = async () => ({
      ok: false,
      cancelled: false,
      durationMs: 4,
      partitionLayoutId: null,
      issues: [{ level: "error", code: "compile_failed", message: "compiler failed" }],
      artifacts: [],
      summary: [],
    });
    const { app } = await createApp({ nativeAvailable: true, runNative: failed });
    closers.push(app);
    const started = await app.inject({
      method: "POST",
      url: "/api/builds",
      payload: mockBuild({ mode: "native", softwareVersion: 3, softwareVersionString: "1.2.0" }),
    });
    const job = await waitForBuild(app, started.json().job.id as string);
    expect(job.status).toBe("failed");
    expect(job.verification).toBeNull();
    expect(job.artifacts.every((artifact) => artifact.deployable === false)).toBe(true);
  });

  it("cancels a running native build", async () => {
    const hanging: NativeRunner = (spec) => new Promise((resolve) => {
      const stop = () => resolve({
        ok: false,
        cancelled: true,
        durationMs: 5,
        partitionLayoutId: null,
        issues: [],
        artifacts: [],
        summary: [],
      });
      if (spec.signal.aborted) stop();
      else spec.signal.addEventListener("abort", stop, { once: true });
    });
    const { app } = await createApp({ nativeAvailable: true, runNative: hanging });
    closers.push(app);
    const started = await app.inject({
      method: "POST",
      url: "/api/builds",
      payload: mockBuild({ mode: "native" }),
    });
    const id = started.json().job.id as string;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cancelled = await app.inject({ method: "POST", url: `/api/builds/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    const job = await waitForBuild(app, id);
    expect(job.status).toBe("interrupted");
    expect(job.artifacts.filter((artifact) => artifact.deployable)).toEqual([]);
  });

  it("marks an orphaned running build interrupted when the API starts", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-"));
    const now = new Date().toISOString();
    const running: BuildJob = {
      id: "orphan-build",
      simulated: false,
      verification: null,
      status: "running",
      request: mockBuild({ mode: "native" }),
      validation: { ok: true, issues: [] },
      logs: ["started"],
      artifacts: [],
      partitionLayoutId: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([running]));
    const { app } = await createApp({ dataDir, nativeAvailable: true, runNative: compiled });
    closers.push(app);
    const recovered = await app.inject({ method: "GET", url: "/api/builds/orphan-build" });
    expect(recovered.json().job.status).toBe("interrupted");
    expect(recovered.json().job.verification).toBeNull();
  });

  it("reports capability limits and does not create a controller identity", async () => {
    const { app } = await createApp();
    closers.push(app);
    const caps = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(caps.json().bleCommissioning).toBe("unsupported");
    expect(caps.json().firmwareBuild).toBe("mock_only");
    expect(caps.json().ai).toBe("needs_setup");
    const controller = await app.inject({ method: "GET", url: "/api/controller/status" });
    expect(controller.json().identityLoaded).toBe(false);
    const ai = await app.inject({
      method: "POST",
      url: "/api/ai/draft",
      payload: {
        peripheralName: "LDR",
        interfaceName: "ADC",
        gpioNotes: "GPIO1",
        behaviour: "read light",
        matterFunction: "illuminance",
        dependencies: "",
      },
    });
    expect(ai.statusCode).toBe(503);
  });

  it("returns a local commissioning code and redacts secrets from errors", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-"));
    await writeFile(path.join(dataDir, "nodes.json"), JSON.stringify([{ id: "node-1", name: "Bench" }]));
    const matter: MatterManagementService = {
      getCapabilities: () => Promise.reject(new Error("unused")),
      getControllerStatus: () => Promise.reject(new Error("unused")),
      createIdentity: () => Promise.reject(new Error("unused")),
      restore: () => Promise.resolve(),
      close: () => Promise.resolve(),
      commission: () => {
        throw new MatterOperationError("discovery_failed", "device not found for MT:Y.ABCDEF");
      },
      listUnsavedPeers: () => Promise.resolve([]),
      recoverExisting: () => Promise.reject(new Error("unused")),
      refreshNode: () => Promise.reject(new Error("unused")),
      removeNode: () => Promise.reject(new Error("unused")),
      retireUnsavedPeer: () => Promise.reject(new Error("unused")),
      reconciliationPlan: () => Promise.resolve({
        controllerIdentityPreserved: true,
        identityReady: false,
        executed: false as const,
        credentialStoreEdited: false as const,
        peers: [],
        retireAfterFactoryReset: "not called",
        notUsed: [],
        blocker: "unused",
      }),
      openCommissioningWindow: () => Promise.resolve({
        opened: true,
        message: "window",
        manualPairingCode: "3497-011-2332",
        qrPairingCode: "MT:Y.ABCDEF",
      }),
      readInstalledSoftwareVersion: () => Promise.resolve(null),
    };
    const { app } = await createApp({ dataDir, matter });
    closers.push(app);
    const window = await app.inject({ method: "POST", url: "/api/nodes/node-1/commissioning-window" });
    expect(window.statusCode).toBe(200);
    expect(window.body).toContain("3497-011-2332");
    expect(window.body).toContain("MT:Y.ABCDEF");
    const failed = await app.inject({
      method: "POST",
      url: "/api/nodes/commission",
      payload: { path: "smart_home", name: "Bench", pairingCode: "MT:Y.ABCDEF", confirm: true },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain("MT:Y.ABCDEF");
    expect(failed.body).toContain("[redacted]");
  });

  it("does not expose a simulated package as a flashable or OTA image", async () => {
    const { app, dataDir } = await createApp();
    closers.push(app);
    const built = await app.inject({ method: "POST", url: "/api/builds", payload: mockBuild() });
    const job = built.json().job;
    const listed = await app.inject({ method: "GET", url: `/api/builds/${job.id}/artifacts` });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["content-type"]).toMatch(/application\/json/);
    expect(listed.json().artifacts).toEqual([
      expect.objectContaining({
        name: "SIMULATED.txt",
        simulated: true,
        deployable: false,
      }),
    ]);
    expect(listed.body).not.toMatch(/sensors\.bin|\.ota\b/);
    const artifact = await readFile(path.join(dataDir, job.artifacts[0].relativePath), "utf8");
    expect(artifact).toMatch(/not an ESP-IDF application binary/);
    expect(artifact).toMatch(/Do not flash/);

    const routes = app.printRoutes();
    expect(routes).toContain("programmer/");
    expect(routes).not.toMatch(/flash|esptool|serial/i);
  });

  it("has no USB tool or compiler invocation in the application source", async () => {
    async function filesUnder(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...await filesUnder(full));
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) found.push(full);
      }
      return found;
    }
    const sources = await filesUnder(path.join(repoRoot, "apps"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/esptool|child_process|ota_image_tool|idf\.py|execFile|spawn\(/);
    }
  });

  it("has no PostgreSQL or GitHub client dependency", async () => {
    const packages = ["package.json", "apps/desktop-ui/package.json"];
    for (const relative of packages) {
      const text = await readFile(path.join(repoRoot, relative), "utf8");
      expect(text).not.toMatch(/postgres|pg\b|prisma|typeorm|octokit|@octokit/i);
    }
    const server = await readFile(path.join(repoRoot, "apps/local-api/package.json"), "utf8");
    expect(server).not.toMatch(/prisma|typeorm|octokit|@octokit/i);
    expect(server).toMatch(/"pg"/);
    const manifestNames = await readdir(componentManifestDir(repoRoot));
    expect(manifestNames.length).toBeGreaterThan(0);
  });

  it("reports a missing toolchain separately from a connected USB port", async () => {
    const { app } = await createApp({ listPorts: async () => ["/dev/cu.usbmodem1101"] });
    closers.push(app);
    const ports = await app.inject({ method: "GET", url: "/api/programmer/ports" });
    expect(ports.json().ports).toEqual(["/dev/cu.usbmodem1101"]);
    const toolchain = await app.inject({ method: "GET", url: "/api/programmer/toolchain" });
    expect(toolchain.json().available).toBe(false);
    expect(toolchain.json().code).toBe("toolchain_not_installed");
    const probe = await app.inject({
      method: "POST",
      url: "/api/programmer/probe",
      payload: { port: "/dev/cu.usbmodem1101" },
    });
    expect(probe.statusCode).toBe(400);
    expect(probe.json().error.code).toBe("toolchain_not_installed");
    expect(probe.json().error.message).toMatch(/not a missing USB device/);
    expect(probe.json().error.message).not.toMatch(/not currently connected/);
    const release = await app.inject({
      method: "POST",
      url: "/api/programmer/ports/release",
      payload: { port: "/dev/cu.usbmodem1101" },
    });
    expect(release.statusCode).toBe(409);
    expect(release.json().error.code).toBe("port_not_owned");
    expect(release.json().error.message).toMatch(/left running/);
    const missingBackup = await app.inject({
      method: "POST",
      url: "/api/programmer/recovery/backup/verify",
      payload: { mac: "aa:bb:cc:dd:ee:ff" },
    });
    expect(missingBackup.statusCode).toBe(404);
    expect(missingBackup.json().error.code).toBe("backup_missing");
  });

  it("rejects a simulated package, an erase request, and a busy or disconnected device", async () => {
    const { app } = await createApp({ listPorts: async () => ["/dev/cu.usbmodem1101"] });
    closers.push(app);
    const built = await app.inject({ method: "POST", url: "/api/builds", payload: mockBuild() });
    const refused = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: {
        buildId: built.json().job.id,
        port: "/dev/cu.usbmodem1101",
        intent: "initial_install",
        confirm: true,
        preserveNvs: true,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("simulated_package");

    const erased = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: {
        buildId: built.json().job.id,
        port: "/dev/cu.usbmodem1101",
        intent: "initial_install",
        confirm: true,
        preserveNvs: true,
        eraseAll: true,
      },
    });
    expect(erased.statusCode).toBe(400);

    const missingNvs = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: {
        buildId: built.json().job.id,
        port: "/dev/cu.usbmodem1101",
        intent: "reflash",
        confirm: true,
      },
    });
    expect(missingNvs.statusCode).toBe(400);

    const commissioned = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: {
        buildId: "not-a-package",
        port: "/dev/tty.usbmodem1101",
        intent: "commissioned_maintenance",
        confirm: true,
        preserveNvs: true,
      },
    });
    expect(commissioned.statusCode).toBe(404);
  });

  it("writes a compiled package, reports progress, and leaves the package files unchanged", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-program-"));
    const seeded = await seedCompiledPackage(dataDir);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[][] = [];
    const runProgram: UsbRunner = async (spec) => {
      seen.push(spec.writeArgs);
      spec.onLog("Writing at 0x00020000... (40 %)");
      await gate;
      if (spec.signal.aborted) return { ok: false, cancelled: true, diagnostic: null };
      return { ok: true, cancelled: false, diagnostic: null };
    };
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(app);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: programPayload({ intent: "commissioned_maintenance" }),
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("confirmation_required");

    const started = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: programPayload(),
    });
    expect(started.statusCode).toBe(202);
    const session = started.json().session as ProgramSession;
    expect(session.eraseAll).toBe(false);
    expect(session.nvsPreserved).toBe(true);
    expect(session.hardwareVerified).toBe(false);

    const progress = await waitForProgram(app, session.id, (item) => item.progressPercent === 40 || item.status !== "running");
    expect(progress.progressPercent).toBe(40);
    const busy = await app.inject({
      method: "POST",
      url: "/api/programmer/sessions",
      payload: programPayload({ intent: "reflash" }),
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("port_busy");
    release();

    const finished = await waitForProgram(app, session.id, (item) => item.status !== "running");
    expect(finished.status).toBe("succeeded");
    expect(finished.progressPercent).toBe(100);
    expect(finished.hardwareVerified).toBe(false);
    expect(finished.checks.find((item) => item.id === "boot")?.status).toBe("unknown");
    expect(finished.checks.find((item) => item.id === "factory_reset")?.status).toBe("unknown");
    expect(seen[0]?.some((arg) => arg.endsWith("usb-image.bin"))).toBe(false);
    expect(seen[0]?.some((arg) => /erase/i.test(arg))).toBe(false);
    expect(seen[0]).toEqual(expect.arrayContaining(["0x0", "0xc000", "0x1d000", "0x20000"]));
    const hash = createHash("sha256").update(await readFile(path.join(seeded.dir, "sensors.bin"))).digest("hex");
    expect(hash).toBe(seeded.hash);
    const build = await app.inject({ method: "GET", url: "/api/builds/compiled-package" });
    expect(build.json().job.verification).toBe("compiled");

    await app.close();
    closers.splice(closers.indexOf(app), 1);
    const { app: reopened } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem1101"] });
    closers.push(reopened);
    const stored = await reopened.inject({ method: "GET", url: `/api/programmer/sessions/${session.id}` });
    expect(stored.json().session.status).toBe("succeeded");
    expect(stored.json().session.hardwareVerified).toBe(false);
    expect(stored.json().session.flashImages).toEqual([
      { label: "bootloader.bin", offset: 0, bytes: expect.any(Number), hashVerified: true, seconds: null },
      { label: "partition-table.bin", offset: 0xc000, bytes: expect.any(Number), hashVerified: true, seconds: null },
      { label: "ota_data_initial.bin", offset: 0x1d000, bytes: expect.any(Number), hashVerified: true, seconds: null },
      { label: "sensors.bin", offset: 0x20000, bytes: expect.any(Number), hashVerified: true, seconds: null },
    ]);
    await expect(access(path.join(dataDir, "programmer"))).rejects.toThrow();
  });

  it("records a failed write and a disconnect without marking the package hardware-verified", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-program-fail-"));
    const seeded = await seedCompiledPackage(dataDir);
    const runProgram: UsbRunner = async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, cancelled: false, diagnostic: "The serial port could not be opened." };
      return { ok: true, cancelled: false, diagnostic: null };
    };
    let attempts = 0;
    const runMonitor: MonitorRunner = async (spec) => {
      spec.onLog("could not open port: Device not configured");
      return { cancelled: false, code: 1 };
    };
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(app);
    const started = await app.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const failed = await waitForProgram(app, started.json().session.id, (item) => item.status !== "running");
    expect(failed.status).toBe("failed");
    expect(failed.hardwareVerified).toBe(false);
    expect((failed.flashImages ?? []).every((image) => image.hashVerified === false)).toBe(true);
    expect((failed.flashImages ?? []).map((image) => image.offset)).toEqual([0, 0xc000, 0x1d000, 0x20000]);
    expect(failed.checks.every((item) => item.status !== "passed" || item.id === "connect")).toBe(true);
    expect(createHash("sha256").update(await readFile(path.join(seeded.dir, "sensors.bin"))).digest("hex")).toBe(seeded.hash);

    const again = await app.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    expect([201, 202]).toContain(again.statusCode);
    const written = await waitForProgram(app, again.json().session.id, (item) => item.status !== "running");
    expect(written.status).toBe("succeeded");
    expect(written.hardwareVerified).toBe(false);
    const opened = await app.inject({ method: "POST", url: `/api/programmer/sessions/${written.id}/monitor` });
    expect(opened.statusCode).toBe(200);
    const watched = await waitForProgram(app, written.id, (item) => item.stage !== "monitoring");
    expect(watched.status).toBe("succeeded");
    expect(watched.checks.find((item) => item.id === "serial")?.status).toBe("failed");
    expect(watched.checks.find((item) => item.id === "boot")?.status).toBe("unknown");
    expect(watched.hardwareVerified).toBe(false);
    const build = await app.inject({ method: "GET", url: "/api/builds/compiled-package" });
    expect(build.json().job.verification).toBe("compiled");
  });

  it("cancels a write, captures a redacted monitor log, and recovers an orphaned session", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-program-cancel-"));
    await seedCompiledPackage(dataDir);
    const runProgram: UsbRunner = (spec) => new Promise<UsbRunnerResult>((resolve) => {
      spec.signal.addEventListener("abort", () => resolve({ ok: false, cancelled: true, diagnostic: null }), { once: true });
    });
    const runMonitor: MonitorRunner = async (spec) => {
      spec.onLog('I boot: App "sensors" version 1.2.0');
      spec.onLog("passcode: 12345678");
      spec.onLog("MT:Y.ABCDEFGH");
      return { cancelled: false, code: 0 };
    };
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(app);
    const started = await app.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const id = started.json().session.id as string;
    const cancelled = await app.inject({ method: "POST", url: `/api/programmer/sessions/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    const interrupted = await waitForProgram(app, id, (item) => item.status !== "running");
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.checks.find((item) => item.id === "write")?.status).toBe("failed");

    const orphan: ProgramSession = {
      ...interrupted,
      id: "orphan-program",
      status: "running",
      stage: "writing",
      message: "still writing",
    };
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify([interrupted, orphan]));
    await app.close();
    closers.splice(closers.indexOf(app), 1);
    const { app: reopened } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(reopened);
    const recovered = await reopened.inject({ method: "GET", url: "/api/programmer/sessions/orphan-program" });
    expect(recovered.json().session.status).toBe("interrupted");
    expect(recovered.json().session.nvsPreserved).toBe(true);

    const success = await reopened.inject({ method: "GET", url: `/api/programmer/sessions/${id}` });
    expect(success.json().session.status).toBe("interrupted");
    const monitorApp = reopened;
    const writable = success.json().session as ProgramSession;
    writable.status = "succeeded";
    writable.stage = "idle";
    const sessions = [writable, recovered.json().session as ProgramSession];
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify(sessions));
    const opened = await monitorApp.inject({ method: "POST", url: `/api/programmer/sessions/${id}/monitor` });
    expect(opened.statusCode).toBe(200);
    const watched = await waitForProgram(monitorApp, id, (item) => item.stage !== "monitoring");
    expect(watched.status).toBe("succeeded");
    expect(watched.checks.find((item) => item.id === "version")?.status).toBe("passed");
    expect(watched.checks.find((item) => item.id === "matter")?.status).toBe("unknown");
    expect(watched.hardwareVerified).toBe(false);
    const saved = await monitorApp.inject({ method: "POST", url: `/api/programmer/sessions/${id}/save-log` });
    expect(saved.statusCode).toBe(200);
    const log = await monitorApp.inject({ method: "GET", url: `/api/programmer/sessions/${id}/saved-log` });
    expect(log.body).toContain("1.2.0");
    expect(log.body).not.toContain("12345678");
    expect(log.body).not.toContain("MT:Y");
    const listed = await monitorApp.inject({ method: "GET", url: `/api/programmer/sessions/${id}` });
    expect(listed.body).not.toContain("savedSerialLog");
    const progress = await monitorApp.inject({ method: "GET", url: `/api/programmer/sessions/${id}/log` });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().status).toBe("succeeded");
    expect(progress.json().tail).toContain("cancelled");
    await expect(access(path.join(dataDir, "programmer"))).rejects.toThrow();
  });

  it("captures a console log without erasing flash", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-console-"));
    const runMonitor: MonitorRunner = async (spec) => {
      spec.onLog("I (1) chip[SVR]: Factory reset requested");
      spec.onLog("setup pin: 34970112332");
      return { cancelled: true, code: 0 };
    };
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runMonitor,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(app);
    const missing = await app.inject({
      method: "POST",
      url: "/api/programmer/console",
      payload: { port: "/dev/cu.usbmodem9999" },
    });
    expect(missing.statusCode).toBe(400);
    const captured = await app.inject({
      method: "POST",
      url: "/api/programmer/console",
      payload: { port: "/dev/cu.usbmodem1101", seconds: 2 },
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.json().erasePerformed).toBe(false);
    expect(captured.json().text).toContain("Factory reset requested");
    expect(captured.json().text).not.toContain("34970112332");
  });

  it("verifies boot on the UART console without writing again and leaves a busy console running", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-boot-"));
    await seedCompiledPackage(dataDir);
    const resets: string[] = [];
    const monitors: string[] = [];
    const runProgram: UsbRunner = async () => ({ ok: true, cancelled: false, diagnostic: null });
    const runMonitor: MonitorRunner = async (spec) => {
      monitors.push(spec.port);
      spec.onLog("ESP-ROM:esp32h2-20221101");
      spec.onLog("I (28) cpu_start: App version:      1.2.0");
      spec.onLog("I (900) chip[DL]: OpenThread started: OK");
      spec.onLog("I (1200) chip[DL]: CHIP task running");
      spec.onLog("I (1400) chip[DL]: Server Listening...");
      spec.onLog("I (3200) DHT11: DHT11 Temperature: 24°C, Humidity: 51%RH");
      await new Promise<void>((resolve) => spec.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { cancelled: true, code: 0 };
    };
    const appReset: AppReset = async (spec) => {
      resets.push(spec.port);
      return { ok: true, detail: "The application was reset. Flash was not erased." };
    };
    const ports = ["/dev/cu.usbmodem1101", "/dev/cu.usbmodem1102"];
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor,
      appReset,
      listPorts: async () => ports,
    });
    closers.push(app);
    const started = await app.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const written = await waitForProgram(app, started.json().session.id, (item) => item.status !== "running");
    expect(written.status).toBe("succeeded");
    expect(written.message).toBe("Flash contents were verified. Application startup has not been captured yet.");
    expect(written.checks.find((item) => item.id === "boot")?.status).toBe("unknown");
    const samePort = await app.inject({
      method: "POST",
      url: `/api/programmer/sessions/${written.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1101" },
    });
    expect(samePort.statusCode).toBe(400);
    const verified = await app.inject({
      method: "POST",
      url: `/api/programmer/sessions/${written.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1102" },
    });
    expect(verified.statusCode).toBe(200);
    const session = verified.json().session as ProgramSession;
    expect(session.status).toBe("succeeded");
    expect(session.hardwareVerified).toBe(false);
    expect(session.message).toBe("Firmware Installed and Verified.");
    expect(session.checks.find((item) => item.id === "matter")?.status).toBe("passed");
    expect(session.checks.find((item) => item.id === "openthread")?.status).toBe("passed");
    expect(session.checks.find((item) => item.id === "dht11")?.status).toBe("passed");
    expect(session.checks.find((item) => item.id === "version")?.status).toBe("passed");
    expect(resets).toEqual(["/dev/cu.usbmodem1101"]);
    expect(monitors).toEqual(["/dev/cu.usbmodem1102"]);
    await app.close();
    closers.splice(closers.indexOf(app), 1);

    const { app: reopened } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ports });
    closers.push(reopened);
    const stored = await reopened.inject({ method: "GET", url: `/api/programmer/sessions/${written.id}` });
    expect(stored.json().session.message).toBe("Firmware Installed and Verified.");
    expect(stored.json().session.checks.find((item: { id: string }) => item.id === "boot")?.status).toBe("passed");
    await reopened.close();
    closers.splice(closers.indexOf(reopened), 1);

    let resetCalled = false;
    const { app: busyApp } = await createApp({
      dataDir,
      nativeAvailable: true,
      listPorts: async () => ports,
      occupants: async (port) => port.endsWith("1102") ? [{ pid: 5327, command: "Python" }] : [],
      appReset: async () => {
        resetCalled = true;
        return { ok: false, detail: "should not reset" };
      },
    });
    closers.push(busyApp);
    const busy = await busyApp.inject({
      method: "POST",
      url: `/api/programmer/sessions/${written.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1102" },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("port_busy");
    expect(busy.json().error.message).toMatch(/Python \(process 5327\)/);
    expect(busy.json().error.message).toMatch(/left running/);
    expect(resetCalled).toBe(false);
  });

  it("verifies boot on the USB programming port when the package enables that console and does not write again", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-usb-console-"));
    const seeded = await seedCompiledPackage(dataDir);
    await writeFile(path.join(seeded.dir, "sdkconfig"), "CONFIG_ESP_CONSOLE_UART_DEFAULT=y\nCONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=y\n");
    const order: string[] = [];
    let hidePort = false;
    let writes = 0;
    const runProgram: UsbRunner = async () => {
      writes += 1;
      return { ok: true, cancelled: false, diagnostic: null };
    };
    const runMonitor: MonitorRunner = async (spec) => {
      order.push(`monitor:${spec.port}`);
      spec.onLog("waiting for download");
      await new Promise<void>((resolve) => spec.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { cancelled: true, code: 0 };
    };
    const appReset: AppReset = async (spec) => {
      order.push(`reset:${spec.port}`);
      hidePort = true;
      setTimeout(() => {
        hidePort = false;
      }, 250);
      return { ok: true, detail: "The application was reset. Flash was not erased." };
    };
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor,
      appReset,
      listPorts: async () => hidePort ? [] : ["/dev/cu.usbmodem1101"],
    });
    closers.push(app);
    const started = await app.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const written = await waitForProgram(app, started.json().session.id, (item) => item.status !== "running");
    const verified = await app.inject({
      method: "POST",
      url: `/api/programmer/sessions/${written.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1101" },
    });
    expect(verified.statusCode).toBe(200);
    const session = verified.json().session as ProgramSession;
    expect(writes).toBe(1);
    expect(order).toEqual(["monitor:/dev/cu.usbmodem1101", "reset:/dev/cu.usbmodem1101", "monitor:/dev/cu.usbmodem1101"]);
    expect(session.message).toBe("The console shows ROM download mode. Application startup was not observed. Flash was not rewritten.");
    expect(session.checks.find((item) => item.id === "boot")?.status).not.toBe("passed");

    const booted = await app.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const second = await waitForProgram(app, booted.json().session.id, (item) => item.status !== "running");
    const quiet: MonitorRunner = async (spec) => {
      order.push("quiet");
      spec.onLog("ESP-ROM:esp32h2-eco5-20240613");
      spec.onLog("I (23) boot: ESP-IDF v5.4.1 2nd stage bootloader");
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (spec.signal.aborted) return { cancelled: true, code: 0 };
      spec.onLog("I (28) cpu_start: App version:      1.2.0");
      spec.onLog("I (40) cpu_start: Calling app_main()");
      await new Promise<void>((resolve) => spec.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { cancelled: true, code: 0 };
    };
    await app.close();
    closers.splice(closers.indexOf(app), 1);
    const { app: next } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor: quiet,
      appReset,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(next);
    const startedApp = await next.inject({
      method: "POST",
      url: `/api/programmer/sessions/${second.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1101" },
    });
    expect(startedApp.statusCode).toBe(200);
    expect(startedApp.json().session.message).toBe("Firmware installation succeeded. Matter commissioning has not yet been performed.");
    expect(startedApp.json().session.checks.find((item: { id: string; status: string }) => item.id === "version")?.status).toBe("passed");
    expect(writes).toBe(2);
    await next.close();
    closers.splice(closers.indexOf(next), 1);

    const silentMonitor: MonitorRunner = async (spec) => {
      spec.onLog("note: uart console open");
      return { cancelled: false, code: 0 };
    };
    const { app: silentApp } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor: silentMonitor,
      appReset,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(silentApp);
    const silentWrite = await silentApp.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const silentSession = await waitForProgram(silentApp, silentWrite.json().session.id, (item) => item.status !== "running");
    const silent = await silentApp.inject({
      method: "POST",
      url: `/api/programmer/sessions/${silentSession.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1101" },
    });
    expect(silent.json().session.message).toMatch(/silent console is not proof/);
    await silentApp.close();
    closers.splice(closers.indexOf(silentApp), 1);

    const crashed: MonitorRunner = async (spec) => {
      spec.onLog("Guru Meditation Error: Core 0 panic'ed");
      await new Promise<void>((resolve) => spec.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { cancelled: true, code: 0 };
    };
    const { app: crashApp } = await createApp({
      dataDir,
      nativeAvailable: true,
      runProgram,
      runMonitor: crashed,
      appReset,
      listPorts: async () => ["/dev/cu.usbmodem1101"],
    });
    closers.push(crashApp);
    const crashWrite = await crashApp.inject({ method: "POST", url: "/api/programmer/sessions", payload: programPayload() });
    const crashSession = await waitForProgram(crashApp, crashWrite.json().session.id, (item) => item.status !== "running");
    const crash = await crashApp.inject({
      method: "POST",
      url: `/api/programmer/sessions/${crashSession.id}/verify-boot`,
      payload: { consolePort: "/dev/cu.usbmodem1101" },
    });
    expect(crash.json().session.message).toMatch(/panic or repeated resets/);
    expect(writes).toBe(4);
  }, 20_000);

  it("keeps a verified installation for a device that is not yet a managed node", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-hardware-"));
    const session = {
      id: "verified-session",
      buildId: "missing-build",
      port: "/dev/cu.usbmodem1101",
      intent: "initial_install",
      status: "succeeded",
      stage: "idle",
      progressPercent: 100,
      logs: ["Chip is ESP32-H2 (revision v0.1)"],
      monitorLog: "Bluetooth MAC: 48:31:b7:cf:3d:52\nApp version: 1.3.0\nOpenThread started: OK\nServer Listening...\nFabric already commissioned\nVendorId 0x1384\ncommissioning mode 0",
      checks: [
        { id: "boot", label: "boot", status: "passed", detail: "seen" },
        { id: "matter", label: "matter", status: "passed", detail: "seen" },
        { id: "openthread", label: "thread", status: "passed", detail: "seen" },
        { id: "dht11", label: "dht", status: "unknown", detail: "not seen" },
        { id: "version", label: "version", status: "passed", detail: "1.3.0" },
      ],
      message: "Firmware Installed and Verified.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: "1.3.0",
      createdAt: "2026-10-24T01:00:00.000Z",
      updatedAt: "2026-10-24T01:00:00.000Z",
    };
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify([session]));
    const { app } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem1101"] });
    closers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    expect(response.statusCode).toBe(200);
    const record = response.json().installations[0];
    expect(record.mac).toBe("48:31:b7:cf:3d:52");
    expect(record.managedNodeId).toBeNull();
    expect(record.bootVerified).toBe(true);
    expect(record.dht11).toBe("unknown");
    expect(record.commissioningState).toBe("commissioned");
    expect(record.commissioningWindowOpen).toBe(false);
    expect(record.vendorId).toBeNull();
  });

  it("returns the printed onboarding payload only on the installation response", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-onboarding-"));
    const onboarding = compiledTestOnboarding(0xfff1, 0x8002);
    expect(onboarding).not.toBeNull();
    if (!onboarding) return;
    const session = {
      id: "printed-onboarding",
      buildId: "missing-build",
      port: "/dev/cu.usbmodem1101",
      intent: "initial_install",
      status: "succeeded",
      stage: "idle",
      progressPercent: 100,
      logs: ["Chip is ESP32-H2 (revision v0.1)"],
      monitorLog: `Bluetooth MAC: 10:51:db:68:64:4c\nApp version: 1.9.0\nServer Listening...\nFabric count 0\nCHIPoBLE advertising started\nSetupQRCode: [${onboarding.qrPayload}]\nManual pairing code: [${onboarding.manualCode}]`,
      checks: [
        { id: "boot", label: "boot", status: "passed", detail: "seen" },
        { id: "matter", label: "matter", status: "passed", detail: "seen" },
        { id: "openthread", label: "thread", status: "passed", detail: "seen" },
        { id: "version", label: "version", status: "passed", detail: "1.9.0" },
      ],
      message: "Firmware Installed and Verified.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: "1.9.0",
      createdAt: "2026-10-25T05:47:10.000Z",
      updatedAt: "2026-10-25T05:47:56.000Z",
      deviceOnboarding: { qrPayload: onboarding.qrPayload, manualCode: onboarding.manualCode },
    };
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify([session]));
    const { app } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem1101"] });
    closers.push(app);
    const installations = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    expect(installations.statusCode).toBe(200);
    expect(installations.body).toContain(onboarding.qrPayload);
    expect(installations.body).toContain(onboarding.manualCode);
    const sessions = await app.inject({ method: "GET", url: "/api/programmer/sessions" });
    expect(sessions.body).not.toContain(onboarding.qrPayload);
    expect(sessions.body).not.toContain(onboarding.manualCode);
    expect(sessions.body).not.toContain("deviceOnboarding");
    const one = await app.inject({ method: "GET", url: "/api/programmer/sessions/printed-onboarding" });
    expect(one.body).not.toContain(onboarding.qrPayload);
    expect(one.body).not.toContain(onboarding.manualCode);
  });

  it("keeps two ESP32-H2 histories separate and reports recorded flash images", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-two-boards-"));
    const base = {
      buildId: "missing-build",
      port: "/dev/cu.usbmodem143401",
      intent: "initial_install",
      status: "succeeded",
      stage: "idle",
      progressPercent: 100,
      logs: ["Chip is ESP32-H2 (revision v0.1)"],
      checks: ["boot", "matter", "openthread", "version"].map((id) => ({ id, label: id, status: "passed", detail: "seen" })),
      message: "Firmware Installed and Verified.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: "1.3.0",
      createdAt: "2026-10-24T01:00:00.000Z",
    };
    const sessions = [
      {
        ...base,
        id: "older-board",
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:3d:52\nServer Listening...\nFabric already commissioned\nVendorId 0x1384\ncommissioning mode 0",
        updatedAt: "2026-10-24T01:00:01.000Z",
      },
      {
        ...base,
        id: "newer-board",
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:5f\nApp version: 1.3.0\nServer Listening...\ncommissioning mode 1\nCHIPoBLE advertising started\nFailed to advertise commissionable node: 3\ndiscriminator: [redacted]",
        createdAt: "2026-10-24T01:48:19.000Z",
        updatedAt: "2026-10-24T01:48:55.000Z",
        flashImages: [
          { label: "bootloader.bin", offset: 0, bytes: 21696, hashVerified: true, seconds: 0.2 },
          { label: "partition-table.bin", offset: 0xc000, bytes: 3072, hashVerified: true, seconds: 0 },
          { label: "ota_data_initial.bin", offset: 0x1d000, bytes: 8192, hashVerified: true, seconds: 0 },
          { label: "sensors.bin", offset: 0x20000, bytes: 1592800, hashVerified: true, seconds: 6.8 },
        ],
      },
    ];
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify(sessions));
    const { app } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem143401"] });
    closers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    expect(response.statusCode).toBe(200);
    const records = response.json().installations as Array<{ mac: string; commissioningState: string; flashImages: Array<{ hashVerified: boolean }>; onboardingStatus: string; onboardingReason: string }>;
    expect(records.map((item) => item.mac).sort()).toEqual(["48:31:b7:cf:37:5f", "48:31:b7:cf:3d:52"]);
    const fresh = records.find((item) => item.mac === "48:31:b7:cf:37:5f");
    expect(fresh?.commissioningState).toBe("uncommissioned");
    expect(fresh?.flashImages).toHaveLength(4);
    expect(fresh?.flashImages.every((image) => image.hashVerified)).toBe(true);
    expect(fresh?.onboardingStatus).toBe("not_verified");
    expect(fresh?.onboardingReason).toMatch(/Not Verified/);
    expect(JSON.stringify(records)).not.toContain("20202021");
    const older = records.find((item) => item.mac === "48:31:b7:cf:3d:52");
    expect(older?.flashImages).toEqual([]);
    expect(older?.commissioningState).toBe("commissioned");
  });

  it("keeps a later factory reset ahead of an older fabric, and a later fabric ahead of that reset", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-reset-order-"));
    const base = {
      buildId: "missing-build",
      port: "/dev/cu.usbmodem143401",
      intent: "commissioned_maintenance",
      status: "succeeded",
      stage: "idle",
      progressPercent: 100,
      logs: ["NVS, factory data, and the secure-cert partition are not erased. Full-chip erase is not available.", "Chip is ESP32-H2 (revision v0.1)"],
      checks: ["boot", "matter", "openthread", "version"].map((id) => ({ id, label: id, status: "passed", detail: "seen" })),
      message: "Firmware Installed and Verified.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: "1.3.0",
      createdAt: "2026-10-24T04:30:00.000Z",
    };
    const sessions = [
      {
        ...base,
        id: "fabric-before-reset",
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:b7\nFabric already commissioned\nVendorId 0x1384\ncommissioning mode 0",
        updatedAt: "2026-10-24T04:30:00.000Z",
      },
      {
        ...base,
        id: "reset-watch",
        checks: [{ id: "boot", label: "boot", status: "unknown", detail: "not seen" }],
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:b7\nStarting factory reset",
        updatedAt: "2026-10-24T04:38:00.000Z",
      },
      {
        ...base,
        id: "other-board",
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:5f\nFabric already commissioned\nVendorId 0x1349",
        updatedAt: "2026-10-24T04:40:00.000Z",
      },
    ];
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify(sessions));
    const { app } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem143401"] });
    closers.push(app);
    const resetResponse = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    const resetRecords = resetResponse.json().installations as Array<{ mac: string | null; macSource?: string; commissioningState: string; commissioningDetail: string; fabricVendors: string[] }>;
    const resetBoard = resetRecords.find((item) => item.mac === "48:31:b7:cf:37:b7");
    expect(resetBoard?.macSource).toBe("bluetooth_mac");
    expect(resetBoard?.commissioningState).toBe("unknown");
    expect(resetBoard?.fabricVendors).toEqual([]);
    expect(resetBoard?.commissioningDetail).toMatch(/factory reset was logged/i);
    expect(resetRecords.find((item) => item.mac === "48:31:b7:cf:37:5f")?.commissioningState).toBe("commissioned");

    sessions.push({
      ...base,
      id: "reflash-after-reset",
      monitorLog: "rst:0x1 (POWERON)\nBluetooth MAC: 48:31:b7:cf:37:b7\nApp version: 1.3.0\nFabric index 0x2 was retrieved from storage. VendorId 0x1384\nFabric already commissioned\ncommissioning mode 0",
      updatedAt: "2026-10-24T04:43:00.000Z",
    });
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify(sessions));
    const { app: reflashed } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem143401"] });
    closers.push(reflashed);
    const later = await reflashed.inject({ method: "GET", url: "/api/hardware/installations" });
    const laterBoard = (later.json().installations as Array<{ mac: string | null; commissioningState: string; fabricVendors: string[] }>).find((item) => item.mac === "48:31:b7:cf:37:b7");
    expect(laterBoard?.commissioningState).toBe("commissioned");
    expect(laterBoard?.fabricVendors).toEqual(["1384"]);
  });

  it("does not attach a capture that names two ESP32-H2 boards to either MAC", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-mixed-mac-"));
    const session = {
      id: "mixed-console",
      buildId: "missing-build",
      port: "/dev/cu.usbmodem143401",
      intent: "initial_install",
      status: "succeeded",
      stage: "idle",
      progressPercent: 100,
      logs: ["Chip is ESP32-H2 (revision v0.1)"],
      monitorLog: "rst:0x1 (POWERON)\nBluetooth MAC: 48:31:b7:cf:37:5f\nrst:0x1 (POWERON)\nBluetooth MAC: 48:31:b7:cf:37:b7\nVendorId 0x1384\nFabric already commissioned",
      checks: ["boot", "matter", "openthread", "version"].map((id) => ({ id, label: id, status: "passed", detail: "seen" })),
      message: "Firmware Installed and Verified.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: "1.3.0",
      baseMac: "48:31:b7:cf:37:5f",
      createdAt: "2026-10-24T04:30:00.000Z",
      updatedAt: "2026-10-24T04:30:02.000Z",
    };
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify([session]));
    const { app } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem143401"] });
    closers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    const records = response.json().installations as Array<{ mac: string | null; commissioningState: string }>;
    expect(records.map((item) => item.mac)).toEqual([null]);
    expect(records[0]?.commissioningState).toBe("unknown");
  });

  it("watches a factory reset long enough to replace an older fabric and marks only that managed node", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-reset-watch-"));
    const node = {
      id: "node-b7",
      name: "Board B7",
      simulated: false,
      matterNodeId: "2",
      vendorId: 65521,
      productId: 32768,
      softwareVersion: 4,
      softwareVersionString: "1.3.0",
      hardwareMac: "48:31:B7:CF:37:B7",
      hardware: "ESP32-H2",
      reachable: false,
      fabricLabel: "IoT.Edu Management",
      commissionedFabricCount: 1,
      otherFabricCount: 0,
      partitionLayoutId: null,
      installedComponents: [],
      history: [],
      createdAt: "2026-10-24T04:00:00.000Z",
      updatedAt: "2026-10-24T04:00:00.000Z",
    };
    const other = { ...node, id: "node-5f", name: "Board 5F", matterNodeId: "3", hardwareMac: "48:31:B7:CF:37:5F" };
    await writeFile(path.join(dataDir, "nodes.json"), JSON.stringify([node, other]));
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify([{
      id: "old-fabric",
      buildId: "missing-build",
      port: "/dev/cu.usbmodem143401",
      consolePort: "/dev/cu.usbmodem1102",
      intent: "commissioned_maintenance",
      status: "succeeded",
      stage: "idle",
      progressPercent: 100,
      logs: ["Chip is ESP32-H2 (revision v0.1)"],
      monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:b7\nVendorId 0x1384\nFabric already commissioned\ncommissioning mode 0",
      checks: ["boot", "matter", "openthread", "version"].map((id) => ({ id, label: id, status: "passed", detail: "seen" })),
      message: "Firmware Installed and Verified.",
      eraseAll: false,
      nvsPreserved: true,
      hardwareVerified: false,
      softwareVersionString: "1.3.0",
      createdAt: "2026-10-24T04:30:00.000Z",
      updatedAt: "2026-10-24T04:43:10.000Z",
    }]));
    const runMonitor: MonitorRunner = async (spec) => {
      spec.onLog("Starting factory reset");
      spec.onLog("Performing factory reset");
      spec.onLog("rst:0x1 (POWERON)");
      spec.onLog("Bluetooth MAC: 48:31:b7:cf:37:b7");
      spec.onLog("Server Listening...");
      spec.onLog("commissioning mode 1");
      spec.onLog("CHIPoBLE advertising started");
      return { cancelled: true, code: 0 };
    };
    const { app } = await createApp({
      dataDir,
      nativeAvailable: true,
      runMonitor,
      listPorts: async () => ["/dev/cu.usbmodem1102"],
    });
    closers.push(app);
    const tooShort = await app.inject({
      method: "POST",
      url: "/api/programmer/factory-reset-watch",
      payload: { port: "/dev/cu.usbmodem1102", seconds: 6 },
    });
    expect(tooShort.statusCode).toBe(400);
    const watched = await app.inject({
      method: "POST",
      url: "/api/programmer/factory-reset-watch",
      payload: { port: "/dev/cu.usbmodem1102", seconds: 45, selectedMac: "48:31:b7:cf:37:b7" },
    });
    expect(watched.statusCode).toBe(200);
    expect(watched.json().erasePerformed).toBe(false);
    expect(watched.json().followedNewPort).toBe(false);
    expect(watched.json().watchSeconds).toBe(45);
    expect(watched.json().assessment.stage).toBe("verified_fabric_free");
    const installations = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    const board = (installations.json().installations as Array<{ mac: string | null; commissioningState: string; fabricVendors: string[] }>).find((item) => item.mac === "48:31:b7:cf:37:b7");
    expect(board?.commissioningState).toBe("uncommissioned");
    expect(board?.fabricVendors).toEqual([]);
    const nodes = await app.inject({ method: "GET", url: "/api/nodes" });
    const records = nodes.json().nodes as Array<{ id: string; operationalReverification?: string; matterNodeId: string }>;
    expect(records.find((item) => item.id === "node-b7")?.operationalReverification).toBe("required");
    expect(records.find((item) => item.id === "node-b7")?.matterNodeId).toBe("2");
    expect(records.find((item) => item.id === "node-5f")?.operationalReverification).toBeUndefined();
  });

  it("shows a firmware-verified QR after reset when the saved log removed the discriminator", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-onboarding-image-"));
    const dir = path.join(dataDir, "builds", "image-package", "artifacts");
    await mkdir(dir, { recursive: true });
    const digest = Buffer.from("a4a5dcfd3e8e7f6892251ba3bab87e8267161369ddcfe067d10aaf446f7d32a2", "hex");
    const application = Buffer.alloc(176, 0);
    application.writeUInt32LE(0xabcd5432, 0);
    application.write("1.3.0", 16, "utf8");
    digest.copy(application, 144);
    const names = ["bootloader.bin", "partition-table.bin", "ota_data_initial.bin", "sensors.bin", "usb-image.bin", "flasher_args.json"];
    for (const name of names) {
      await writeFile(path.join(dir, name), name === "sensors.bin" ? application : name === "flasher_args.json" ? "{}" : Buffer.from(name));
    }
    await writeFile(path.join(dir, "sdkconfig"), [
      "CONFIG_DEVICE_VENDOR_ID=0xFFF1",
      "CONFIG_DEVICE_PRODUCT_ID=0x8000",
      "CONFIG_ENABLE_TEST_SETUP_PARAMS=y",
      "CONFIG_EXAMPLE_COMMISSIONABLE_DATA_PROVIDER=y",
      "# CONFIG_ENABLE_ESP32_FACTORY_DATA_PROVIDER is not set",
      "# CONFIG_SEC_CERT_COMMISSIONABLE_DATA_PROVIDER is not set",
      "# CONFIG_CUSTOM_COMMISSIONABLE_DATA_PROVIDER is not set",
    ].join("\n"));
    const now = "2026-10-24T05:00:00.000Z";
    const job: BuildJob = {
      id: "image-package",
      simulated: false,
      verification: "compiled",
      status: "succeeded",
      request: mockBuild({ mode: "native", softwareVersion: 4, softwareVersionString: "1.3.0" }),
      validation: { ok: true, issues: [] },
      logs: ["compiled"],
      artifacts: names.map((name) => ({
        name,
        relativePath: path.join("builds", "image-package", "artifacts", name),
        sha256: "abc",
        size: 4,
        simulated: false,
        deployable: false,
      })),
      partitionLayoutId: "layout",
      durationMs: 5,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([job]));
    const checks = ["boot", "matter", "openthread", "version"].map((id) => ({ id, label: id, status: "passed", detail: "seen" }));
    await writeFile(path.join(dataDir, "programmer-sessions.json"), JSON.stringify([
      {
        id: "b7-install",
        buildId: "image-package",
        port: "/dev/cu.usbmodem143401",
        intent: "commissioned_maintenance",
        status: "succeeded",
        stage: "idle",
        progressPercent: 100,
        logs: ["Chip is ESP32-H2 (revision v0.1)"],
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:b7\nELF file SHA256: a4a5dcfd3...\nApp version: 1.3.0\nVendorId 0x1384\nFabric already commissioned\ncommissioning mode 0\nServer Listening...",
        checks,
        message: "Firmware Installed and Verified.",
        eraseAll: false,
        nvsPreserved: true,
        hardwareVerified: false,
        softwareVersionString: "1.3.0",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "other-install",
        buildId: "missing-build",
        port: "/dev/cu.usbmodem143401",
        intent: "initial_install",
        status: "succeeded",
        stage: "idle",
        progressPercent: 100,
        logs: ["Chip is ESP32-H2 (revision v0.1)"],
        monitorLog: "Bluetooth MAC: 48:31:b7:cf:37:5f\nELF file SHA256: 9959a23ed...\nVendorId 0x1349\nFabric already commissioned\ncommissioning mode 0\nServer Listening...",
        checks,
        message: "Firmware Installed and Verified.",
        eraseAll: false,
        nvsPreserved: true,
        hardwareVerified: false,
        softwareVersionString: "1.3.0",
        createdAt: now,
        updatedAt: "2026-10-24T05:10:00.000Z",
      },
    ]));
    await writeFile(path.join(dataDir, "factory-reset-observations.json"), JSON.stringify([{
      id: "reset-b7",
      consolePort: "/dev/cu.usbmodem5B610393331",
      selectedMac: "48:31:b7:cf:37:b7",
      observedAt: "2026-10-24T05:26:30.000Z",
      watchSeconds: 45,
      disconnected: false,
      text: [
        "Bluetooth MAC: 48:31:b7:cf:37:b7",
        "VendorId 0x1384",
        "Fabric already commissioned",
        "Starting factory reset",
        "Performing factory reset",
        "System restarting",
        "rst:0xc (SW_CPU)",
        "Bluetooth MAC: 48:31:b7:cf:37:b7",
        "ELF file SHA256:  a4a5dcfd3...",
        "App version: 1.3.0",
        "Server Listening...",
        "commissioning mode 1",
        "Advertise commission parameter vendorID=65521 productID=32768 discriminator: [redacted] cm=1",
        "Failed to advertise commissionable node: 3",
        "CHIPoBLE advertising started",
      ].join("\n"),
    }]));
    const { app } = await createApp({ dataDir, nativeAvailable: true, listPorts: async () => ["/dev/cu.usbmodem143401"] });
    closers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/hardware/installations" });
    const records = response.json().installations as Array<{
      mac: string;
      commissioningState: string;
      fabricVendors: string[];
      onboardingStatus: string;
      onboardingPayload: string;
      firmwareImageIdentity: string;
      discriminatorEvidence: string;
      bleAdvertisingObserved: boolean;
      windowNow: string;
      dnsSdWarning: string | null;
      softwareVersion: number;
      softwareVersionString: string;
      vendorId: number;
      productId: number;
      writeCompleted: boolean;
      bootVerified: boolean;
      matterReady: boolean;
      threadReady: boolean;
      versionVerified: boolean;
      commissioningWindowOpen: boolean | null;
    }>;
    const board = records.find((item) => item.mac === "48:31:b7:cf:37:b7");
    const other = records.find((item) => item.mac === "48:31:b7:cf:37:5f");
    expect(board?.commissioningState).toBe("uncommissioned");
    expect(board?.fabricVendors).toEqual([]);
    expect(board?.onboardingStatus).toBe("image_verified");
    expect(board?.onboardingPayload).toBe("consistent");
    expect(board?.firmwareImageIdentity).toBe("verified");
    expect(board?.discriminatorEvidence).toBe("redacted");
    expect(board?.bleAdvertisingObserved).toBe(true);
    expect(board?.windowNow).toBe("unknown");
    expect(board?.dnsSdWarning).toMatch(/error 3/);
    expect(other?.commissioningState).toBe("commissioned");
    expect(other?.onboardingStatus).not.toBe("image_verified");
    expect(other?.firmwareImageIdentity).toBe("unknown");
    const decision = onboardingDecision({
      writeCompleted: board?.writeCompleted ?? false,
      bootVerified: board?.bootVerified ?? false,
      matterReady: board?.matterReady ?? false,
      threadReady: board?.threadReady ?? false,
      versionVerified: board?.versionVerified ?? false,
      softwareVersion: board?.softwareVersion ?? null,
      softwareVersionString: board?.softwareVersionString ?? null,
      vendorId: board?.vendorId ?? null,
      productId: board?.productId ?? null,
      commissioningState: board?.commissioningState === "uncommissioned" || board?.commissioningState === "commissioned" ? board.commissioningState : "unknown",
      commissioningWindowOpen: board?.commissioningWindowOpen ?? null,
      onboardingStatus: board?.onboardingStatus === "image_verified" ? "image_verified" : "not_verified",
      windowNow: board?.windowNow === "open" || board?.windowNow === "closed" ? board.windowNow : "unknown",
    });
    expect(decision.show).toBe(true);
    expect(decision.reason).toBe("Verified from installed firmware — live BLE advertisement not confirmed.");
    expect(JSON.stringify(records)).not.toContain("20202021");
  });

  it("does not start catalogue composition without the Neon catalogue", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { app } = await createApp({ nativeAvailable: true, runNative: compiled });
      closers.push(app);
      const response = await app.inject({ method: "POST", url: "/api/firmware-composition", payload: { gpio: 4 } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("catalogue_unavailable");
      const listed = await app.inject({ method: "GET", url: "/api/builds" });
      expect(listed.json().jobs).toEqual([]);
      const nodeTypes = await app.inject({ method: "GET", url: "/api/node-types" });
      expect(nodeTypes.statusCode).toBe(503);
      expect(nodeTypes.json().error.code).toBe("catalogue_unavailable");
      expect(nodeTypes.json().nodeTypes).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
