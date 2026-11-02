import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildJob } from "@iotedu/contracts";

export type FirmwarePackageLocation = "local" | "archived" | "unflashable" | "unavailable";

export class FirmwareArtifactError extends Error {
  constructor(
    message: string,
    readonly code: "artifact_missing" | "artifact_mismatch" | "archive_unavailable" | "rejected_path",
  ) {
    super(message);
    this.name = "FirmwareArtifactError";
  }
}

export function firmwareArchiveDir(): string {
  return process.env.IOTEDU_FIRMWARE_ARCHIVE?.trim() ?? "";
}

export interface ResolvedFirmwareArtifact {
  buildId: string;
  name: string;
  source: "local" | "archived";
  bytes: Buffer;
  sha256: string;
  absolutePath: string;
}

interface ArtifactRequest {
  dataDir: string;
  buildId: string;
  name: string;
  relativePath?: string | null;
  expectedSha256?: string | null;
  verify?: boolean;
  archiveDir?: string;
}

export async function readFirmwareArtifact(input: ArtifactRequest): Promise<ResolvedFirmwareArtifact> {
  const located = await locateFirmwareArtifact(input);
  if (!located) throw await unavailable(input);
  const bytes = await readFile(located.absolutePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.verify !== false && isSha256(input.expectedSha256) && sha256 !== input.expectedSha256) {
    throw new FirmwareArtifactError(
      `${input.name} for build ${input.buildId} does not match its recorded SHA-256. Another firmware version was not substituted.`,
      "artifact_mismatch",
    );
  }
  return { buildId: input.buildId, name: input.name, source: located.source, bytes, sha256, absolutePath: located.absolutePath };
}

export async function openFirmwarePackage(input: {
  dataDir: string;
  buildId: string;
  files: { name: string; relativePath?: string | null; expectedSha256?: string | null }[];
  archiveDir?: string;
}): Promise<{ directory: string; source: "local" | "archived"; cleanup: () => Promise<void> }> {
  const resolved = [];
  for (const file of input.files) {
    resolved.push(await readFirmwareArtifact({
      dataDir: input.dataDir,
      archiveDir: input.archiveDir,
      buildId: input.buildId,
      name: file.name,
      relativePath: file.relativePath,
      expectedSha256: file.expectedSha256,
      verify: true,
    }));
  }
  const directories = new Set(resolved.map((file) => path.dirname(file.absolutePath)));
  if (resolved.every((file) => file.source === "local") && directories.size === 1) {
    return { directory: [...directories][0] ?? "", source: "local", cleanup: async () => undefined };
  }
  const directory = await mkdtemp(path.join(tmpdir(), "iotedu-firmware-"));
  try {
    for (const file of resolved) {
      const destination = path.join(directory, file.name);
      if (path.dirname(destination) !== directory) {
        throw new FirmwareArtifactError(`Refusing to stage ${file.name} outside the temporary package directory.`, "rejected_path");
      }
      await writeFile(destination, file.bytes);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    source: "archived",
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function classifyFirmwareStorage(input: {
  dataDir: string;
  job: BuildJob;
  archiveDir?: string;
}): Promise<FirmwarePackageLocation> {
  if (input.job.simulated || input.job.status !== "succeeded" || (input.job.verification !== "compiled" && input.job.verification !== "hardware_verified")) {
    return "unflashable";
  }
  const artifacts = input.job.artifacts.filter((artifact) => !artifact.simulated && artifact.name !== "build.log");
  if (artifacts.length === 0) return "unflashable";
  let archived = false;
  for (const artifact of artifacts) {
    const presence = await artifactPresence({
      dataDir: input.dataDir,
      archiveDir: input.archiveDir,
      buildId: input.job.id,
      name: artifact.name,
      relativePath: artifact.relativePath,
      expectedSha256: artifact.sha256,
    });
    if (presence === "missing" || presence === "mismatch") return "unavailable";
    if (presence === "archived") archived = true;
  }
  return archived ? "archived" : "local";
}

async function locateFirmwareArtifact(input: ArtifactRequest): Promise<{ source: "local" | "archived"; absolutePath: string } | null> {
  const buildId = safeBuildId(input.buildId);
  const name = safeName(input.name);
  const local = await activeFile(input.dataDir, buildId, name, input.relativePath);
  if (local) return { source: "local", absolutePath: local };
  const archived = await fileInside(input.archiveDir ?? firmwareArchiveDir(), path.join(buildId, "artifacts", name));
  if (archived) return { source: "archived", absolutePath: archived };
  return null;
}

async function artifactPresence(input: ArtifactRequest): Promise<"local" | "archived" | "missing" | "mismatch"> {
  const located = await locateFirmwareArtifact(input);
  if (!located) return "missing";
  if (!isSha256(input.expectedSha256)) return located.source;
  const sha256 = createHash("sha256").update(await readFile(located.absolutePath)).digest("hex");
  if (sha256 !== input.expectedSha256) return "mismatch";
  return located.source;
}

async function activeFile(dataDir: string, buildId: string, name: string, relativePath?: string | null): Promise<string | null> {
  if (relativePath) {
    const recorded = await fileInside(dataDir, relativePath);
    if (recorded && path.basename(recorded) === name) return recorded;
  }
  return fileInside(dataDir, path.join("builds", buildId, "artifacts", name));
}

async function fileInside(root: string, relative: string): Promise<string | null> {
  if (!root || !relative || relative.split(/[\\/]/).includes("..")) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return null;
  }
  const absolute = path.resolve(rootReal, relative);
  if (absolute !== rootReal && !absolute.startsWith(`${rootReal}${path.sep}`)) return null;
  try {
    const fileReal = await realpath(absolute);
    if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) return null;
    return fileReal;
  } catch {
    return null;
  }
}

async function unavailable(input: ArtifactRequest): Promise<FirmwareArtifactError> {
  const archiveDir = input.archiveDir ?? firmwareArchiveDir();
  try {
    await realpath(archiveDir);
  } catch {
    return new FirmwareArtifactError(
      `${input.name} for build ${input.buildId} is not in the local build directory, and the firmware archive is not available. Another firmware version was not substituted.`,
      "archive_unavailable",
    );
  }
  return new FirmwareArtifactError(
    `${input.name} for build ${input.buildId} is not in the local build directory or the firmware archive. Another firmware version was not substituted.`,
    "artifact_missing",
  );
}

function safeBuildId(buildId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(buildId) || buildId.includes("..")) {
    throw new FirmwareArtifactError("The build identifier cannot be resolved.", "rejected_path");
  }
  return buildId;
}

function safeName(name: string): string {
  if (!name || name !== path.basename(name) || name.includes("..")) {
    throw new FirmwareArtifactError("The artifact name cannot be resolved.", "rejected_path");
  }
  return name;
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
