import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BuildJob } from "@iotedu/contracts";
import { configuredFirmwareArchive, expandHomePath, repositoryPaths } from "@iotedu/contracts/paths";
import { FirmwareArtifactError, readFirmwareArtifact } from "./firmware-artifacts.js";

export class DevelopmentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentStoreError";
  }
}

export type StartupRuntime = "development" | "production";

export interface StartupPaths {
  runtime: StartupRuntime;
  dataDir: string;
  archiveDir: string;
}

export function applicationSupportDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new DevelopmentStoreError("Set DATA_DIR. No home directory is available.");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "IoT.Edu");
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "IoT.Edu");
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "iotedu");
}

export function resolveStartupPaths(input: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): StartupPaths {
  const env = input.env ?? process.env;
  const runtime: StartupRuntime = env.IOTEDU_RUNTIME === "development" ? "development" : "production";
  const archiveDir = configuredFirmwareArchive(env);
  const configured = expandHomePath(env.DATA_DIR?.trim() ?? "", env);
  if (configured) {
    return {
      runtime,
      dataDir: path.isAbsolute(configured) ? configured : path.resolve(input.repoRoot, configured),
      archiveDir,
    };
  }
  if (runtime === "development") {
    return { runtime, dataDir: repositoryPaths(input.repoRoot).applicationDataRoot, archiveDir };
  }
  return { runtime, dataDir: applicationSupportDir(env, input.platform), archiveDir };
}

export async function assertConfiguredDataDirectory(dataDir: string): Promise<void> {
  try {
    const info = await stat(dataDir);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || (error instanceof Error && error.message === "not a directory")) {
      throw new DevelopmentStoreError(
        `The application data directory does not exist (${dataDir}). IoT.Edu will not create a new Matter controller identity.`,
      );
    }
    throw new DevelopmentStoreError(
      `The application data directory could not be read (${dataDir}). IoT.Edu will not create a new Matter controller identity.`,
    );
  }
}

export interface FirmwareStartupDiagnostic {
  buildId: string;
  artifact: string;
  code: "artifact_missing" | "artifact_mismatch" | "archive_unavailable" | "rejected_path";
  message: string;
}

export async function assertDevelopmentStore(input: { dataDir: string; archiveDir: string }): Promise<FirmwareStartupDiagnostic[]> {
  await assertConfiguredDataDirectory(input.dataDir);
  const buildsFile = path.join(input.dataDir, "builds.json");
  await requireFile(buildsFile, `The development data directory has no builds.json (${buildsFile}). IoT.Edu will not start against an empty store.`);
  const libraryIndex = path.join(input.dataDir, "firmware-library", "index.json");
  await requireFile(libraryIndex, `The firmware library is not accessible (${libraryIndex}). Firmware readiness will not be presented.`);
  if (!input.archiveDir) {
    throw new DevelopmentStoreError("IOTEDU_FIRMWARE_ARCHIVE is not set. Development startup does not choose an archive location.");
  }
  try {
    const archive = await stat(input.archiveDir);
    if (!archive.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new DevelopmentStoreError(`The firmware archive is not accessible (${input.archiveDir}). Another firmware version was not substituted.`);
  }
  let jobs: BuildJob[];
  try {
    const parsed = JSON.parse(await readFile(buildsFile, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not a list");
    jobs = parsed as BuildJob[];
  } catch {
    throw new DevelopmentStoreError(`builds.json could not be read (${buildsFile}).`);
  }
  const diagnostics: FirmwareStartupDiagnostic[] = [];
  for (const job of jobs) {
    if (job.status !== "succeeded" || job.simulated) continue;
    if (job.verification !== "compiled" && job.verification !== "hardware_verified") continue;
    const image = job.artifacts?.find((item) => item.name === "sensors.bin" && !item.simulated);
    if (!image || !/^[a-f0-9]{64}$/.test(image.sha256)) {
      throw new DevelopmentStoreError(`Build ${job.id} is recorded as compiled but has no verifiable application image. Firmware readiness will not be presented.`);
    }
    try {
      await readFirmwareArtifact({
        dataDir: input.dataDir,
        archiveDir: input.archiveDir,
        buildId: job.id,
        name: image.name,
        relativePath: image.relativePath,
        expectedSha256: image.sha256,
        verify: true,
      });
    } catch (error) {
      if (!(error instanceof FirmwareArtifactError)) throw error;
      diagnostics.push({
        buildId: job.id,
        artifact: image.name,
        code: error.code,
        message: error.message,
      });
    }
  }
  return diagnostics;
}

async function requireFile(file: string, message: string): Promise<void> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new DevelopmentStoreError(message);
  }
}
