import path from "node:path";

export interface RepositoryPaths {
  repositoryRoot: string;
  nodeDataRoot: string;
  boardProfilesRoot: string;
  catalogueRoot: string;
  componentManifestsRoot: string;
  firmwareRoot: string;
  firmwareTemplateRoot: string;
  firmwareComponentsRoot: string;
  applicationDataRoot: string;
  buildHistoryRoot: string;
  programmerSessionsFile: string;
  matterControllerRoot: string;
}

/** Paths for repository resources. An explicit DATA_DIR still overrides applicationDataRoot. */
export function repositoryPaths(repoRoot: string): RepositoryPaths {
  const repositoryRoot = path.resolve(repoRoot);
  const nodeDataRoot = path.join(repositoryRoot, "node-data");
  const firmwareRoot = path.join(nodeDataRoot, "firmware");
  const applicationDataRoot = path.join(nodeDataRoot, "data", "application");
  return {
    repositoryRoot,
    nodeDataRoot,
    boardProfilesRoot: path.join(nodeDataRoot, "board-profiles"),
    catalogueRoot: path.join(nodeDataRoot, "catalogue"),
    componentManifestsRoot: path.join(nodeDataRoot, "component-manifests"),
    firmwareRoot,
    firmwareTemplateRoot: path.join(firmwareRoot, "template"),
    firmwareComponentsRoot: path.join(firmwareRoot, "components"),
    applicationDataRoot,
    buildHistoryRoot: path.join(applicationDataRoot, "builds"),
    programmerSessionsFile: path.join(applicationDataRoot, "programmer-sessions.json"),
    matterControllerRoot: path.join(applicationDataRoot, "matter-controller"),
  };
}

export function boardProfileFile(repoRoot: string): string {
  return path.join(repositoryPaths(repoRoot).boardProfilesRoot, "esp32h2.json");
}

export function componentManifestDir(repoRoot: string): string {
  return path.join(repositoryPaths(repoRoot).componentManifestsRoot, "manifests");
}

/** Expand a leading ~ to the home folder. .env files and Windows shells do not do this themselves. */
export function expandHomePath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || "";
  if (!home || !/^~(?=$|[\\/])/.test(value)) return value;
  return path.join(home, value.slice(1).replace(/^[\\/]+/, ""));
}

export function configuredFirmwareArchive(env: NodeJS.ProcessEnv = process.env): string {
  return expandHomePath(env.IOTEDU_FIRMWARE_ARCHIVE?.trim() ?? "", env);
}
