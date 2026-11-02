import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, readBoardProfile, startupLog } from "./app.js";
import { loadEnvFile } from "./load-env.js";
import { componentManifestDir } from "@iotedu/contracts/paths";
import { assertConfiguredDataDirectory, assertDevelopmentStore, resolveStartupPaths } from "./startup-config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
await loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env"));
const startup = resolveStartupPaths({ repoRoot });
startupLog("configuration", {
  runtime: startup.runtime,
  host: process.env.IOTEDU_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3847),
  dataDir: startup.dataDir,
  firmwareArchiveConfigured: Boolean(startup.archiveDir),
  matterMode: process.env.MATTER_MODE === "mock" ? "mock" : "live",
});
if (process.env.DATA_DIR?.trim() || startup.runtime === "development") {
  try {
    await assertConfiguredDataDirectory(startup.dataDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The application data directory does not exist.");
    process.exit(1);
  }
}
if (startup.runtime === "development") {
  try {
    const diagnostics = await assertDevelopmentStore(startup);
    startupLog("development-store", {
      state: diagnostics.length === 0 ? "verified" : "artifacts-unavailable",
      unavailableArtifacts: diagnostics.length,
    });
    for (const item of diagnostics) {
      console.error(JSON.stringify({ source: "iotedu-api", event: "firmware-artifact", buildId: item.buildId, artifact: item.artifact, code: item.code, message: item.message }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The development store could not be verified.";
    console.error(message);
    process.exit(1);
  }
}

const host = process.env.IOTEDU_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1") {
  throw new Error("Refusing to bind the administrative API outside 127.0.0.1");
}

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? reason.message : "unknown";
  console.error(JSON.stringify({ source: "iotedu-api", message: "A background task failed. The API process stayed up.", detail }));
});

const port = Number(process.env.PORT ?? 3847);
const profile = await readBoardProfile(repoRoot);
const app = await buildApp({
  dataDir: startup.dataDir,
  repoRoot,
  catalogDir: componentManifestDir(repoRoot),
  profile,
  matterMode: process.env.MATTER_MODE === "mock" ? "mock" : "live",
  firmwareArchiveDir: startup.archiveDir || undefined,
});

startupLog("http", { state: "binding", host, port });
await app.listen({ host, port });
startupLog("http", { state: "listening", host, port });

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  startupLog("http", { state: "closing" });
  app.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
