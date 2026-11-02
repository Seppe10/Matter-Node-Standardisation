import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { zipCrc32, type BoardProfile } from "@iotedu/firmware-builder";
import type { ComponentManifest, LibraryComponent, LibraryValidationResponse } from "@iotedu/contracts";
import { componentManifestDir, repositoryPaths } from "@iotedu/contracts/paths";
import { buildApp, readBoardProfile } from "./app.js";
import { FirmwareLibraryService } from "./firmware-library-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const closers: { close: () => Promise<void> }[] = [];
const sourceText = "#include \"sensor.h\"\nstatic const int data_gpio = 4;\nesp_err_t sensor_init(uint16_t endpoint_id) { (void)endpoint_id; (void)data_gpio; return 0; }\n";
const headerText = "#pragma once\n#include \"esp_err.h\"\nesp_err_t sensor_init(uint16_t endpoint_id);\n";
const cmakeText = "idf_component_register(SRCS \"sensor.c\" INCLUDE_DIRS \".\")\n";
const compiled = async () => ({ available: true, ran: true, success: true, diagnostics: [] as { level: "error" | "warning"; message: string }[] });
function componentUploads(source = sourceText) {
  return [
    { name: "sensor.c", data: Buffer.from(source) },
    { name: "sensor.h", data: Buffer.from(headerText) },
    { name: "CMakeLists.txt", data: Buffer.from(cmakeText) },
  ];
}

function packZip(name: string, data: Buffer): Buffer {
  const compressed = deflateRawSync(data);
  const encodedName = Buffer.from(name);
  const crc = zipCrc32(data);
  const local = Buffer.alloc(30 + encodedName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  const file = Buffer.concat([local, compressed]);
  const central = Buffer.alloc(46 + encodedName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  central.writeUInt32LE(0, 42);
  encodedName.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(file.length, 16);
  return Buffer.concat([file, central, eocd]);
}

async function createApp(catalogDir = componentManifestDir(repoRoot), libraryCompile: typeof compiled = compiled) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-library-"));
  const profile = await readBoardProfile(repoRoot);
  const app = await buildApp({
    dataDir,
    repoRoot,
    catalogDir,
    profile,
    nativeAvailable: false,
    reachabilityIntervalMs: 0,
    libraryCompile,
  });
  closers.push(app);
  return { app, dataDir, profile };
}

function files(entries: { name: string; data: Buffer }[]) {
  return {
    files: entries.map((entry) => ({ name: entry.name, contentBase64: entry.data.toString("base64") })),
  };
}

const componentBody = {
  name: "DHT11 Temperature and Humidity",
  description: "Reads temperature and humidity from a single-wire sensor.",
  type: "sensor" as const,
  gpio: [{ name: "data_gpio", gpio: 4, description: "Single-wire sensor data" }],
  retain: [] as string[],
};

async function stageAndValidate(app: { inject: Function }, extra: Record<string, unknown> = {}) {
  const staged = await app.inject({
    method: "POST",
    url: "/api/firmware-library/stage",
    payload: files(componentUploads()),
  });
  const stageId = staged.json().stageId as string;
  const validated = await app.inject({
    method: "POST",
    url: "/api/firmware-library/validate",
    payload: { ...componentBody, ...extra, stageId, componentId: null },
  });
  return { stageId, validated, body: validated.json() as LibraryValidationResponse };
}

describe("firmware library API", () => {
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((app) => app.close()));
  });

  it("saves a validated custom component and does not create a firmware package", async () => {
    const { app, dataDir } = await createApp();
    const beforeBuilds = await readFile(path.join(dataDir, "builds.json"), "utf8").catch(() => "");
    const beforeNodes = await readFile(path.join(dataDir, "nodes.json"), "utf8").catch(() => "");
    const { stageId, validated, body } = await stageAndValidate(app);
    expect(validated.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.nativeCompile).toBe(true);
    expect(body.issues.some((issue) => issue.level === "warning" || issue.level === "error")).toBe(false);

    const created = await app.inject({
      method: "POST",
      url: "/api/firmware-library",
      payload: { ...componentBody, stageId, fingerprint: body.fingerprint },
    });
    expect(created.statusCode).toBe(201);
    const component = created.json().component as LibraryComponent;
    expect(component.id).toMatch(/^custom-[a-f0-9]{12}$/);
    expect(component.provenance).toBe("custom");
    expect(component.revision).toBe(1);
    expect(component.validation.nativeCompile).toBe(true);
    expect(created.json()).not.toHaveProperty("job");
    const stored = await readFile(path.join(dataDir, "firmware-library", "components", component.id, "current", "sensor.c"), "utf8");
    expect(stored).toContain("data_gpio");
    expect(await readFile(path.join(dataDir, "builds.json"), "utf8").catch(() => "")).toBe(beforeBuilds);
    expect(await readFile(path.join(dataDir, "nodes.json"), "utf8").catch(() => "")).toBe(beforeNodes);

    const listed = await app.inject({ method: "GET", url: "/api/firmware-library" });
    expect(listed.json().components.map((item: LibraryComponent) => item.id)).toEqual([component.id]);
  });

  it("rejects create and update when validation still has a warning", async () => {
    let calls = 0;
    const { app } = await createApp(componentManifestDir(repoRoot), async () => {
      calls += 1;
      if (calls <= 2) return { available: true, ran: true, success: true, diagnostics: [] };
      return { available: true, ran: true, success: true, diagnostics: [{ level: "warning", message: "unused variable" }] };
    });
    const saved = await stageAndValidate(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/firmware-library",
      payload: { ...componentBody, stageId: saved.stageId, fingerprint: saved.body.fingerprint },
    });
    expect(created.statusCode).toBe(201);
    const component = created.json().component as LibraryComponent;
    const edited = await app.inject({
      method: "POST",
      url: "/api/firmware-library/validate",
      payload: {
        ...componentBody,
        description: "Updated description for the same sensor.",
        stageId: null,
        componentId: component.id,
        retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().ok).toBe(false);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/firmware-library/${component.id}`,
      payload: {
        ...componentBody,
        description: "Updated description for the same sensor.",
        stageId: null,
        retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
        fingerprint: edited.json().fingerprint ?? "a".repeat(64),
        baseRevision: 1,
      },
    });
    expect(updated.statusCode).toBe(400);
    expect(updated.json().error.code).toBe("validation_failed");
    expect(updated.json().error.message).toMatch(/Resolve all 1 validation warning/);

    const { app: warned } = await createApp(componentManifestDir(repoRoot), async () => ({
      available: true, ran: true, success: false, diagnostics: [{ level: "error", message: "sensor.c:1:1: error: expected declaration" }],
    }));
    const failed = await stageAndValidate(warned);
    expect(failed.body.ok).toBe(false);
    const rejected = await warned.inject({
      method: "POST",
      url: "/api/firmware-library",
      payload: { ...componentBody, stageId: failed.stageId, fingerprint: "b".repeat(64) },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("validation_failed");
  });

  it("keeps the same id when a validated edit is saved and rejects a stale fingerprint", async () => {
    const { app } = await createApp();
    const first = await stageAndValidate(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/firmware-library",
      payload: { ...componentBody, stageId: first.stageId, fingerprint: first.body.fingerprint },
    });
    const component = created.json().component as LibraryComponent;
    const edited = await app.inject({
      method: "POST",
      url: "/api/firmware-library/validate",
      payload: {
        ...componentBody,
        name: "DHT11 Temperature and Humidity",
        description: "Updated description for the same sensor.",
        stageId: null,
        componentId: component.id,
        retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
      },
    });
    expect(edited.statusCode).toBe(200);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/firmware-library/${component.id}`,
      payload: {
        ...componentBody,
        description: "Updated description for the same sensor.",
        stageId: null,
        retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
        fingerprint: edited.json().fingerprint,
        baseRevision: 1,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().component.id).toBe(component.id);
    expect(updated.json().component.revision).toBe(2);
    const listed = await app.inject({ method: "GET", url: "/api/firmware-library" });
    expect(listed.json().components).toHaveLength(1);

    const stale = await app.inject({
      method: "PUT",
      url: `/api/firmware-library/${component.id}`,
      payload: {
        ...componentBody,
        description: "A different description",
        stageId: null,
        retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
        fingerprint: edited.json().fingerprint,
        baseRevision: 2,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_validation");
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/firmware-library/${component.id}`,
      payload: {
        ...componentBody,
        description: "Updated description for the same sensor.",
        stageId: null,
        retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
        fingerprint: edited.json().fingerprint,
        baseRevision: 1,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("component_conflict");
  });

  it("rejects invalid metadata, unsafe archives, and bad GPIO assignments", async () => {
    const { app } = await createApp();
    const blank = await app.inject({
      method: "POST",
      url: "/api/firmware-library/validate",
      payload: { ...componentBody, name: " ", description: " ", stageId: null, componentId: null },
    });
    expect(blank.statusCode).toBe(400);
    const script = await app.inject({
      method: "POST",
      url: "/api/firmware-library/stage",
      payload: files([{ name: "install.sh", data: Buffer.from("echo") }]),
    });
    expect(script.statusCode).toBe(400);
    expect(script.json().error.code).toBe("unsupported_file");
    const traversal = await app.inject({
      method: "POST",
      url: "/api/firmware-library/stage",
      payload: files([{ name: "escape.zip", data: packZip("../iotedu_core.h", Buffer.from("nope")) }]),
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe("unsafe_archive");
    const staged = await stageAndValidate(app, { gpio: [{ name: "data_gpio", gpio: 9, description: "" }] });
    expect(staged.body.ok).toBe(false);
    expect(staged.body.issues.some((issue) => issue.code === "gpio_reserved")).toBe(true);
    const duplicate = await stageAndValidate(app, {
      gpio: [
        { name: "data_gpio", gpio: 4, description: "" },
        { name: "data_gpio", gpio: 5, description: "" },
      ],
    });
    expect(duplicate.body.issues.some((issue) => issue.code === "gpio_duplicate_name")).toBe(true);
  });

  it("does not list experimental catalogue entries and refuses approved edits", async () => {
    const { app } = await createApp();
    const library = await app.inject({ method: "GET", url: "/api/firmware-library" });
    const ids = library.json().components.map((item: { id: string }) => item.id);
    expect(ids).not.toEqual(expect.arrayContaining(["iotedu-core", "iotedu-dht11", "iotedu-rgb", "iotedu-pir", "iotedu-ldr"]));
    const catalog = await app.inject({ method: "GET", url: "/api/catalog" });
    expect(catalog.json().components.map((item: { id: string }) => item.id)).toContain("iotedu-dht11");

    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-approved-"));
    const catalogDir = path.join(dataDir, "catalog");
    await mkdir(catalogDir);
    const approved: ComponentManifest = {
      id: "approved-temp",
      name: "Approved Temp Sensor",
      description: "Approved catalogue sensor.",
      type: "sensor",
      version: "1.0.0",
      status: "verified",
      source: "local",
      target: "esp32h2",
      idfCompatibility: ">=5.4.1 <5.5",
      selectableForBuild: false,
      firmware: {
        idfComponentDir: "firmware/components/approved_temp",
        registerFunction: "approved_temp_register",
        requires: [],
        kconfig: [{ key: "CONFIG_APPROVED_TEMP_PIN", pinName: "TEMP_DATA", default: 4 }],
        matter: { endpoints: [], clusters: [] },
      },
    };
    const experimental: ComponentManifest = { ...approved, id: "experimental-temp", name: "Experimental Temp", status: "experimental" };
    await writeFile(path.join(catalogDir, "approved.json"), JSON.stringify(approved));
    await writeFile(path.join(catalogDir, "experimental.json"), JSON.stringify(experimental));
    const approvedApp = await createApp(catalogDir);
    const visible = await approvedApp.app.inject({ method: "GET", url: "/api/firmware-library" });
    expect(visible.json().components.map((item: LibraryComponent) => item.id)).toEqual(["approved-temp"]);
    expect(visible.json().components[0].provenance).toBe("approved");
    expect(visible.json().components[0].gpio).toEqual([{ name: "TEMP_DATA", gpio: 4, description: "CONFIG_APPROVED_TEMP_PIN" }]);
    const edit = await approvedApp.app.inject({
      method: "PUT",
      url: "/api/firmware-library/approved-temp",
      payload: {
        ...componentBody,
        stageId: null,
        retain: [],
        fingerprint: "a".repeat(64),
        baseRevision: 1,
      },
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json().error.code).toBe("approved_readonly");
  });
});

describe("firmware library storage", () => {
  it("persists across a new service, snapshots revisions, and rolls back a failed write", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-store-"));
    const profile = JSON.parse(await readFile(path.join(repositoryPaths(repoRoot).boardProfilesRoot, "esp32h2.json"), "utf8")) as BoardProfile;
    const corePath = path.join(repositoryPaths(repoRoot).firmwareComponentsRoot, "iotedu_core", "CMakeLists.txt");
    const core = await readFile(corePath);
    const service = new FirmwareLibraryService(dataDir, profile, async () => [], { compile: compiled });
    const staged = await service.stage(componentUploads().map((file) => ({ name: file.name, contentBase64: file.data.toString("base64") })));
    const validated = await service.validate({ ...componentBody, stageId: staged.stageId, componentId: null });
    expect(validated.fingerprint).toBeTruthy();
    const created = await service.create({ ...componentBody, stageId: staged.stageId, fingerprint: validated.fingerprint ?? "" });
    const reloaded = new FirmwareLibraryService(dataDir, profile, async () => [], { compile: compiled });
    expect((await reloaded.list()).map((item) => item.id)).toEqual([created.id]);

    const renamed = await reloaded.validate({
      ...componentBody,
      description: "Updated description for the same sensor.",
      stageId: null,
      componentId: created.id,
      retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
    });
    const updated = await reloaded.update(created.id, {
      ...componentBody,
      description: "Updated description for the same sensor.",
      stageId: null,
      retain: ["sensor.c", "sensor.h", "CMakeLists.txt"],
      fingerprint: renamed.fingerprint ?? "",
      baseRevision: created.revision,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.revision).toBe(2);
    const snapshot = JSON.parse(await readFile(path.join(
      dataDir,
      "firmware-library",
      "components",
      created.id,
      "revisions",
      "1",
      "record.json",
    ), "utf8")) as LibraryComponent;
    expect(snapshot.description).toBe(componentBody.description);
    expect(await readFile(path.join(dataDir, "firmware-library", "components", created.id, "revisions", "1", "files", "sensor.c"), "utf8")).toContain("data_gpio");

    const failing = new FirmwareLibraryService(dataDir, profile, async () => [], { failIndexWrite: true, compile: compiled });
    const changedStage = await failing.stage(componentUploads(`${sourceText}/* changed */\n`).map((file) => ({ name: file.name, contentBase64: file.data.toString("base64") })));
    const next = await failing.validate({
      ...componentBody,
      name: "Should Not Publish",
      description: "This edit must roll back.",
      stageId: changedStage.stageId,
      componentId: created.id,
      retain: [],
    });
    await expect(failing.update(created.id, {
      ...componentBody,
      name: "Should Not Publish",
      description: "This edit must roll back.",
      stageId: changedStage.stageId,
      retain: [],
      fingerprint: next.fingerprint ?? "",
      baseRevision: 2,
    })).rejects.toMatchObject({ code: "save_failed" });
    const after = await reloaded.get(created.id);
    expect(after?.name).toBe(componentBody.name);
    expect(after?.revision).toBe(2);
    expect(await readFile(path.join(dataDir, "firmware-library", "components", created.id, "current", "sensor.c"), "utf8")).not.toContain("changed");
    expect(await readFile(corePath)).toEqual(core);
    const escaped = packZip("../../firmware/components/iotedu_core/CMakeLists.txt", Buffer.from("changed"));
    await expect(service.stage([{ name: "bad.zip", contentBase64: escaped.toString("base64") }])).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(await readFile(corePath)).toEqual(core);
    expect(await readdir(path.join(repositoryPaths(repoRoot).firmwareComponentsRoot, "iotedu_core"))).not.toContain("bad.zip");
  });
});
