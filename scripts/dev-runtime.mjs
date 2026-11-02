import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryPaths } from "../packages/contracts/src/repository-paths.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Development startup needs a command.");
  process.exit(1);
}

function configuredArchive() {
  const current = process.env.IOTEDU_FIRMWARE_ARCHIVE?.trim();
  if (current) return current;
  try {
    const text = readFileSync(path.join(repoRoot, "apps", "local-api", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1 || trimmed.slice(0, separator) !== "IOTEDU_FIRMWARE_ARCHIVE") continue;
      return trimmed.slice(separator + 1).trim();
    }
  } catch {
    return "";
  }
  return "";
}

const explicitData = process.env.DATA_DIR?.trim();
const dataDir = !explicitData
  ? repositoryPaths(repoRoot).applicationDataRoot
  : path.isAbsolute(explicitData)
    ? explicitData
    : path.resolve(repoRoot, explicitData);
const env = {
  ...process.env,
  IOTEDU_RUNTIME: "development",
  DATA_DIR: dataDir,
};
const archive = configuredArchive();
if (archive) env.IOTEDU_FIRMWARE_ARCHIVE = archive;

const child = spawn(command, args, {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
