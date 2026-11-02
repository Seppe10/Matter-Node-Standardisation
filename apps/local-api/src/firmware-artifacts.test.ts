import { createHash } from "node:crypto";
import { access, cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBootHeader } from "@iotedu/firmware-builder/recovery";
import { compilationDecision } from "@iotedu/firmware-builder/firmware-release";
import type { BuildJob } from "@iotedu/contracts";
import { componentManifestDir, repositoryPaths } from "@iotedu/contracts/paths";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, readBoardProfile } from "./app.js";
import { dht11PackageRecall, verifyRecordedImage } from "./catalogue-compose.js";
import { CatalogueError } from "./catalogue-store.js";
import {
  classifyFirmwareStorage,
  FirmwareArtifactError,
  openFirmwarePackage,
  readFirmwareArtifact,
} from "./firmware-artifacts.js";

async function configuredArchive(): Promise<string | null> {
  const current = process.env.IOTEDU_FIRMWARE_ARCHIVE?.trim();
  if (current) return current;
  try {
    const text = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("IOTEDU_FIRMWARE_ARCHIVE=")) continue;
      return trimmed.slice("IOTEDU_FIRMWARE_ARCHIVE=".length).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const port = "/dev/cu.usbmodem143401";
const applicationData = repositoryPaths(repoRoot).applicationDataRoot;
const closers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((app) => app.close()));
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function job(id: string, name: string, bytes: Buffer, relativePath: string): BuildJob {
  const now = "2026-10-31T00:00:00.000Z";
  return {
    id,
    simulated: false,
    verification: "compiled",
    status: "succeeded",
    request: {
      mode: "native",
      codeSource: "approved",
      nodeId: null,
      hardware: "esp32h2",
      baseFirmwareId: "matter-core-iotedu",
      componentIds: ["custom-dht11"],
      pins: [{ componentId: "custom-dht11", pinName: "DHT11_DATA", gpio: 4 }],
      softwareVersion: 5,
      softwareVersionString: "1.4.0",
      uploadId: null,
      confirm: true,
    },
    validation: { ok: true, issues: [] },
    logs: [],
    artifacts: [{ name, relativePath, sha256: sha256(bytes), size: bytes.length, simulated: false, deployable: true }],
    partitionLayoutId: null,
    durationMs: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function flashPackage(directory: string): Promise<Record<string, Buffer>> {
  const bootloader = encodeBootHeader({ mode: 2, speed: 0xf, size: 2 });
  const table = Buffer.from("partition-table");
  const otadata = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const application = encodeBootHeader({ mode: 2, speed: 0xf, size: 2 });
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
  const files: Record<string, Buffer> = {
    "bootloader.bin": bootloader,
    "partition-table.bin": table,
    "ota_data_initial.bin": otadata,
    "sensors.bin": application,
    "usb-image.bin": merged,
    "flasher_args.json": Buffer.from(`${JSON.stringify(flasher)}\n`),
  };
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes);
  return files;
}

async function varyPackage(directory: string, files: Record<string, Buffer>, marker: number): Promise<Record<string, Buffer>> {
  const sensors = Buffer.concat([files["sensors.bin"] ?? Buffer.alloc(0), Buffer.from([marker])]);
  const usb = Buffer.concat([files["usb-image.bin"] ?? Buffer.alloc(0), Buffer.from([marker])]);
  const next = { ...files, "sensors.bin": sensors, "usb-image.bin": usb };
  await writeFile(path.join(directory, "sensors.bin"), sensors);
  await writeFile(path.join(directory, "usb-image.bin"), usb);
  return next;
}

function packageJob(id: string, componentId: string, version: string, softwareVersion: number, files: Record<string, Buffer>): BuildJob {
  const record = job(id, "sensors.bin", files["sensors.bin"] ?? Buffer.alloc(0), `builds/${id}/artifacts/sensors.bin`);
  record.request.componentIds = [componentId];
  record.request.softwareVersion = softwareVersion;
  record.request.softwareVersionString = version;
  record.artifacts = Object.entries(files).map(([name, bytes]) => ({
    name,
    relativePath: `builds/${id}/artifacts/${name}`,
    sha256: sha256(bytes),
    size: bytes.length,
    simulated: false,
    deployable: true,
  }));
  return record;
}

describe("firmware artifact resolver", () => {
  it("reads an active package, an archived package, and refuses a corrupt local file", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-active-"));
    const archiveDir = await mkdtemp(path.join(tmpdir(), "iotedu-archive-"));
    const activeBytes = Buffer.from("active-firmware");
    const archivedBytes = Buffer.from("archived-firmware");
    const active = job("active-build", "sensors.bin", activeBytes, "builds/active-build/artifacts/sensors.bin");
    const archived = job("archived-build", "sensors.bin", archivedBytes, "builds/archived-build/artifacts/sensors.bin");
    await mkdir(path.dirname(path.join(dataDir, active.artifacts[0]!.relativePath)), { recursive: true });
    await writeFile(path.join(dataDir, active.artifacts[0]!.relativePath), activeBytes);
    await mkdir(path.join(archiveDir, "archived-build/artifacts"), { recursive: true });
    await mkdir(path.join(archiveDir, "active-build/artifacts"), { recursive: true });
    await writeFile(path.join(archiveDir, "archived-build/artifacts/sensors.bin"), archivedBytes);
    await writeFile(path.join(archiveDir, "active-build/artifacts/sensors.bin"), activeBytes);

    const activeRead = await readFirmwareArtifact({
      dataDir,
      archiveDir,
      buildId: active.id,
      name: "sensors.bin",
      relativePath: active.artifacts[0]!.relativePath,
      expectedSha256: active.artifacts[0]!.sha256,
    });
    expect(activeRead.source).toBe("local");
    expect(activeRead.sha256).toBe(active.artifacts[0]!.sha256);
    expect(activeRead.bytes.equals(activeBytes)).toBe(true);

    const archivedRead = await readFirmwareArtifact({
      dataDir,
      archiveDir,
      buildId: archived.id,
      name: "sensors.bin",
      relativePath: archived.artifacts[0]!.relativePath,
      expectedSha256: archived.artifacts[0]!.sha256,
    });
    expect(archivedRead.source).toBe("archived");
    expect(archivedRead.bytes.equals(archivedBytes)).toBe(true);
    expect(await classifyFirmwareStorage({ dataDir, job: active, archiveDir })).toBe("local");
    expect(await classifyFirmwareStorage({ dataDir, job: archived, archiveDir })).toBe("archived");

    await writeFile(path.join(dataDir, active.artifacts[0]!.relativePath), Buffer.from("corrupt"));
    expect(await classifyFirmwareStorage({ dataDir, job: active, archiveDir })).toBe("unavailable");
    await expect(readFirmwareArtifact({
      dataDir,
      archiveDir,
      buildId: active.id,
      name: "sensors.bin",
      relativePath: active.artifacts[0]!.relativePath,
      expectedSha256: active.artifacts[0]!.sha256,
    })).rejects.toMatchObject({ code: "artifact_mismatch" });
  });

  it("reports a controlled error when the archive and the active package are both missing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-empty-"));
    const missingArchive = path.join(dataDir, "no-archive");
    await expect(readFirmwareArtifact({
      dataDir,
      archiveDir: missingArchive,
      buildId: "missing-build",
      name: "sensors.bin",
      relativePath: "builds/missing-build/artifacts/sensors.bin",
    })).rejects.toBeInstanceOf(FirmwareArtifactError);
    await expect(readFirmwareArtifact({
      dataDir,
      archiveDir: missingArchive,
      buildId: "missing-build",
      name: "sensors.bin",
    })).rejects.toMatchObject({ code: "archive_unavailable" });
    await mkdir(path.join(dataDir, "empty-archive"), { recursive: true });
    await expect(readFirmwareArtifact({
      dataDir,
      archiveDir: path.join(dataDir, "empty-archive"),
      buildId: "missing-build",
      name: "sensors.ota",
    })).rejects.toMatchObject({ code: "artifact_missing" });
  });

  it("stages an archived USB package without copying it back into the build directory", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-plan-"));
    const archiveDir = await mkdtemp(path.join(tmpdir(), "iotedu-plan-archive-"));
    const buildId = "archived-plan";
    const files = await flashPackage(path.join(archiveDir, buildId, "artifacts"));
    const names = Object.keys(files);
    const record = job(buildId, "sensors.bin", files["sensors.bin"]!, `builds/${buildId}/artifacts/sensors.bin`);
    record.artifacts = names.map((name) => ({
      name,
      relativePath: `builds/${buildId}/artifacts/${name}`,
      sha256: sha256(files[name]!),
      size: files[name]!.length,
      simulated: false,
      deployable: name === "sensors.ota",
    }));
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([record]));
    const opened = await openFirmwarePackage({
      dataDir,
      archiveDir,
      buildId,
      files: record.artifacts.map((artifact) => ({ name: artifact.name, relativePath: artifact.relativePath, expectedSha256: artifact.sha256 })),
    });
    expect(opened.source).toBe("archived");
    expect(opened.directory.startsWith(path.join(dataDir, "builds"))).toBe(false);
    await opened.cleanup();
    await expect(access(opened.directory)).rejects.toThrow();
    await expect(access(path.join(dataDir, "builds", buildId))).rejects.toThrow();

    const profile = await readBoardProfile(repoRoot);
    const app = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile,
      nativeAvailable: false,
      firmwareArchiveDir: archiveDir,
      listPorts: async () => [port],
    });
    closers.push(app);
    const plan = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId, port } });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().regions.map((region: { offset: string }) => region.offset)).toEqual(["0x0", "0xc000", "0x1d000", "0x20000"]);
    expect(plan.json().preserved).toEqual(["nvs", "nvs_keys", "fctry", "esp_secure_cert", "phy_init"]);
    const listed = await app.inject({ method: "GET", url: "/api/builds" });
    expect(listed.json().jobs[0].packageLocation).toBe("archived");
    const missing = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: "not-a-package", port } });
    expect(missing.statusCode).toBe(404);

    const absent = await mkdtemp(path.join(tmpdir(), "iotedu-no-archive-"));
    const blocked = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile,
      nativeAvailable: false,
      firmwareArchiveDir: path.join(absent, "missing"),
      listPorts: async () => [port],
    });
    closers.push(blocked);
    const refused = await blocked.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId, port } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("archive_unavailable");
    expect(refused.json().error.message).toMatch(/not substituted/);
  });

  it("keeps DHT11 and Node Type reuse working when the package exists only in the archive", async () => {
    const buildsFile = path.join(applicationData, "builds.json");
    const externalArchive = await configuredArchive();
    let present = Boolean(externalArchive);
    try {
      if (externalArchive) await access(buildsFile);
    } catch {
      present = false;
    }
    if (!present || !externalArchive) return;
    const jobs = JSON.parse(await readFile(buildsFile, "utf8")) as BuildJob[];
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-recall-"));
    for (const id of ["87e7ff73-5342-42d9-9fdf-25e7c57dac1f", "b88bfcf1-af2a-433b-9db0-061ab0ee8a24"]) {
      const stored = jobs.find((item) => item.id === id);
      expect(stored).toBeTruthy();
      const recalled = await dht11PackageRecall(dataDir, stored!, externalArchive);
      expect(recalled?.applicationSha256).toBe(stored!.artifacts.find((item) => item.name === "sensors.bin")?.sha256);
      expect(recalled?.otaSha256).toBe(stored!.artifacts.find((item) => item.name === "sensors.ota")?.sha256);
    }
    const archivedRelease = jobs.find((item) => item.id === "626b625b-8a0b-4599-88b6-781913fadc6a");
    const applicationSha = archivedRelease?.artifacts.find((item) => item.name === "sensors.bin")?.sha256 ?? null;
    await verifyRecordedImage(dataDir, archivedRelease!, applicationSha, externalArchive);
    const decision = compilationDecision({
      recipeFingerprint: "archived-recipe",
      releases: [{
        state: "release_candidate",
        softwareVersion: archivedRelease!.request.softwareVersion,
        softwareVersionString: archivedRelease!.request.softwareVersionString,
        recipeFingerprint: "archived-recipe",
        buildId: archivedRelease!.id,
        applicationSha256: applicationSha,
      }],
      buildRunning: false,
      intent: "reuse",
    });
    expect(decision.action).toBe("reuse");
    if (decision.action === "reuse") expect(decision.release.buildId).toBe(archivedRelease!.id);
    await expect(verifyRecordedImage(dataDir, archivedRelease!, applicationSha, path.join(dataDir, "missing-archive"))).rejects.toBeInstanceOf(CatalogueError);
  });

  it("plans the retained 1.10.0 package from local storage or the archive, and an older package from the archive", async () => {
    const buildsFile = path.join(applicationData, "builds.json");
    const activeId = "c6732bb6-5b24-4384-bc69-1e05f8747a14";
    const archivedId = "626b625b-8a0b-4599-88b6-781913fadc6a";
    const externalArchive = await configuredArchive();
    const localRgb = path.join(applicationData, "builds", activeId, "artifacts/sensors.ota");
    let rgbLocation: "local" | "archived" = "archived";
    let present = Boolean(externalArchive);
    try {
      if (!externalArchive) throw new Error("archive unset");
      await access(path.join(externalArchive, archivedId, "artifacts/sensors.ota"));
      await access(buildsFile);
      try {
        await access(localRgb);
        rgbLocation = "local";
      } catch {
        await access(path.join(externalArchive, activeId, "artifacts/sensors.ota"));
      }
    } catch {
      present = false;
    }
    if (!present || !externalArchive) return;
    const jobs = JSON.parse(await readFile(buildsFile, "utf8")) as BuildJob[];
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-retained-"));
    const archiveDir = await mkdtemp(path.join(tmpdir(), "iotedu-retained-archive-"));
    if (rgbLocation === "local") {
      await cp(path.join(applicationData, "builds", activeId), path.join(dataDir, "builds", activeId), { recursive: true });
    } else {
      await cp(path.join(externalArchive, activeId), path.join(archiveDir, activeId), { recursive: true });
    }
    await cp(path.join(externalArchive, archivedId), path.join(archiveDir, archivedId), { recursive: true });
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify(jobs.filter((item) => item.id === activeId || item.id === archivedId)));
    const profile = await readBoardProfile(repoRoot);
    const app = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile,
      nativeAvailable: false,
      firmwareArchiveDir: archiveDir,
      listPorts: async () => [port],
    });
    closers.push(app);
    const activePlan = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: activeId, port } });
    const archivedPlan = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: archivedId, port } });
    expect(activePlan.statusCode).toBe(200);
    expect(archivedPlan.statusCode).toBe(200);
    expect(activePlan.json().softwareVersionString).toBe("1.10.0");
    expect(archivedPlan.json().softwareVersionString).toBe("1.11.0");
    expect(archivedPlan.json().regions.map((region: { artifact: string }) => region.artifact)).toEqual(activePlan.json().regions.map((region: { artifact: string }) => region.artifact));
    const listed = await app.inject({ method: "GET", url: "/api/builds" });
    const locations = new Map((listed.json().jobs as Array<{ id: string; packageLocation: string }>).map((item) => [item.id, item.packageLocation]));
    expect(locations.get(activeId)).toBe(rgbLocation);
    expect(locations.get(archivedId)).toBe("archived");
    const rgbJob = jobs.find((item) => item.id === activeId);
    const rgbImage = rgbJob?.artifacts.find((item) => item.name === "sensors.bin");
    const downloaded = await app.inject({ method: "GET", url: `/api/builds/${activeId}/download/sensors.bin` });
    expect(downloaded.statusCode).toBe(200);
    expect(sha256(Buffer.from(downloaded.rawPayload))).toBe(rgbImage?.sha256);
    await expect(access(path.join(dataDir, "builds", archivedId))).rejects.toThrow();
    if (rgbLocation === "archived") await expect(access(path.join(dataDir, "builds", activeId))).rejects.toThrow();
  });

  it("plans each selected package from its own artifacts and keeps a missing package from stopping the API", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-separate-"));
    const archiveDir = await mkdtemp(path.join(tmpdir(), "iotedu-separate-archive-"));
    const dhtDir = path.join(dataDir, "builds", "dht11-build", "artifacts");
    const rgbDir = path.join(archiveDir, "rgb-build", "artifacts");
    const dhtFiles = await varyPackage(dhtDir, await flashPackage(dhtDir), 0x11);
    const rgbFiles = await varyPackage(rgbDir, await flashPackage(rgbDir), 0x22);
    const dht = packageJob("dht11-build", "custom-dht11", "1.4.0", 5, dhtFiles);
    const rgb = packageJob("rgb-build", "custom-rgb-led", "1.10.0", 11, rgbFiles);
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([dht, rgb]));
    const profile = await readBoardProfile(repoRoot);
    const app = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile,
      nativeAvailable: false,
      firmwareArchiveDir: archiveDir,
      listPorts: async () => [port],
    });
    closers.push(app);
    const dhtPlan = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: "dht11-build", port } });
    const rgbPlan = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: "rgb-build", port } });
    expect(dhtPlan.statusCode).toBe(200);
    expect(rgbPlan.statusCode).toBe(200);
    expect(dhtPlan.json().softwareVersionString).toBe("1.4.0");
    expect(rgbPlan.json().softwareVersionString).toBe("1.10.0");
    const dhtImage = await app.inject({ method: "GET", url: "/api/builds/dht11-build/download/sensors.bin" });
    const rgbImage = await app.inject({ method: "GET", url: "/api/builds/rgb-build/download/sensors.bin" });
    expect(sha256(Buffer.from(dhtImage.rawPayload))).toBe(sha256(dhtFiles["sensors.bin"]!));
    expect(sha256(Buffer.from(rgbImage.rawPayload))).toBe(sha256(rgbFiles["sensors.bin"]!));
    expect(sha256(Buffer.from(dhtImage.rawPayload))).not.toBe(sha256(Buffer.from(rgbImage.rawPayload)));
    const listed = await app.inject({ method: "GET", url: "/api/builds" });
    const locations = new Map((listed.json().jobs as Array<{ id: string; packageLocation: string }>).map((item) => [item.id, item.packageLocation]));
    expect(locations.get("dht11-build")).toBe("local");
    expect(locations.get("rgb-build")).toBe("archived");

    await writeFile(path.join(archiveDir, "rgb-build", "artifacts", "sensors.bin"), Buffer.from("corrupt"));
    const corrupt = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: "rgb-build", port } });
    expect(corrupt.statusCode).toBe(400);
    expect(corrupt.json().error.code).toBe("artifact_mismatch");
    const afterCorrupt = await app.inject({ method: "GET", url: "/api/builds" });
    expect(afterCorrupt.statusCode).toBe(200);
    const corruptLocation = (afterCorrupt.json().jobs as Array<{ id: string; packageLocation: string }>).find((item) => item.id === "rgb-build");
    expect(corruptLocation?.packageLocation).toBe("unavailable");

    const missing = await app.inject({ method: "POST", url: "/api/programmer/plan", payload: { buildId: "absent-build", port } });
    expect(missing.statusCode).toBe(404);
    const stillUp = await app.inject({ method: "GET", url: "/api/builds/dht11-build" });
    expect(stillUp.statusCode).toBe(200);
    expect(stillUp.json().job.packageLocation).toBe("local");
  });
});
