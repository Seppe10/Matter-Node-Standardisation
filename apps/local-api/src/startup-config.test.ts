import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryPaths } from "@iotedu/contracts/paths";
import { assertConfiguredDataDirectory, assertDevelopmentStore, resolveStartupPaths } from "./startup-config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

describe("development startup paths", () => {
  it("resolves node-data/data/application from the repository root and keeps explicit overrides", () => {
    const root = path.resolve("/work", "iotedu");
    const development = resolveStartupPaths({
      repoRoot: root,
      env: { IOTEDU_RUNTIME: "development", IOTEDU_FIRMWARE_ARCHIVE: "/archive" },
      platform: "darwin",
    });
    expect(development.runtime).toBe("development");
    expect(development.dataDir).toBe(path.join(root, "node-data", "data", "application"));
    expect(development.archiveDir).toBe("/archive");
    expect(resolveStartupPaths({
      repoRoot: root,
      env: { IOTEDU_RUNTIME: "development", DATA_DIR: "custom/store" },
    }).dataDir).toBe(path.join(root, "custom", "store"));
    expect(resolveStartupPaths({
      repoRoot: root,
      env: { IOTEDU_RUNTIME: "development", DATA_DIR: "/var/iotedu" },
    }).dataDir).toBe("/var/iotedu");
    const production = resolveStartupPaths({
      repoRoot: root,
      env: { HOME: "/Users/example" },
      platform: "darwin",
    });
    expect(production.runtime).toBe("production");
    expect(production.dataDir).toBe(path.join("/Users/example", "Library", "Application Support", "IoT.Edu"));
    expect(production.dataDir).not.toBe(development.dataDir);
  });

  it("does not embed a machine-specific firmware archive path", async () => {
    const source = await readFile(new URL("./firmware-artifacts.ts", import.meta.url), "utf8");
    expect(source).not.toContain("iotedu-firmware-archive");
    expect(source).not.toContain("giuseppestramandinoli");
    expect(source).toContain("IOTEDU_FIRMWARE_ARCHIVE");
  });

  it("reports a missing development store instead of using an empty directory", async () => {
    const missing = path.join(tmpdir(), "iotedu-missing-store-does-not-exist");
    await expect(assertConfiguredDataDirectory(missing)).rejects.toThrow(/will not create a new Matter controller identity/);
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-missing-store-"));
    await expect(assertDevelopmentStore({ dataDir, archiveDir: dataDir })).rejects.toThrow(/builds\.json/);
    await expect(assertDevelopmentStore({ dataDir, archiveDir: "" })).rejects.toThrow(/builds\.json/);
  });

  it("requires the archive and a verifiable application image before firmware readiness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "iotedu-startup-"));
    const dataDir = path.join(root, "data");
    const archiveDir = path.join(root, "archive");
    const buildId = "build-ok";
    const bytes = Buffer.from("dht11-image");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(path.join(dataDir, "firmware-library"), { recursive: true });
    await mkdir(path.join(archiveDir, buildId, "artifacts"), { recursive: true });
    await writeFile(path.join(dataDir, "firmware-library", "index.json"), "{}\n");
    await writeFile(path.join(archiveDir, buildId, "artifacts", "sensors.bin"), bytes);
    const job = {
      id: buildId,
      status: "succeeded",
      simulated: false,
      verification: "compiled",
      artifacts: [{ name: "sensors.bin", relativePath: `builds/${buildId}/artifacts/sensors.bin`, sha256, simulated: false }],
    };
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([job]));
    await expect(assertDevelopmentStore({ dataDir, archiveDir: "" })).rejects.toThrow(/IOTEDU_FIRMWARE_ARCHIVE/);
    await expect(assertDevelopmentStore({ dataDir, archiveDir })).resolves.toEqual([]);
    await expect(assertDevelopmentStore({ dataDir, archiveDir: path.join(root, "absent") })).rejects.toThrow(/not accessible/);
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([]));
    await expect(assertDevelopmentStore({ dataDir, archiveDir })).resolves.toEqual([]);
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([job]));
    await writeFile(path.join(archiveDir, buildId, "artifacts", "sensors.bin"), Buffer.from("corrupt"));
    const corrupt = await assertDevelopmentStore({ dataDir, archiveDir });
    expect(corrupt).toEqual([expect.objectContaining({ buildId, artifact: "sensors.bin", code: "artifact_mismatch" })]);
    await rm(path.join(archiveDir, buildId, "artifacts", "sensors.bin"));
    const missing = await assertDevelopmentStore({ dataDir, archiveDir });
    expect(missing).toEqual([expect.objectContaining({ buildId, artifact: "sensors.bin", code: "artifact_missing" })]);
    await writeFile(path.join(dataDir, "builds.json"), JSON.stringify([{ ...job, artifacts: [{ name: "sensors.bin", simulated: false }] }]));
    await expect(assertDevelopmentStore({ dataDir, archiveDir })).rejects.toThrow(/no verifiable application image/);
  });

  it("checks the application records and configured archive before readiness", async () => {
    const archiveDir = await configuredArchive();
    const dataDir = repositoryPaths(repoRoot).applicationDataRoot;
    try {
      await access(path.join(dataDir, "builds.json"));
      if (!archiveDir) throw new Error("unset");
    } catch {
      return;
    }
    const diagnostics = await assertDevelopmentStore({ dataDir, archiveDir: archiveDir ?? "" });
    expect(Array.isArray(diagnostics)).toBe(true);
  });
});
