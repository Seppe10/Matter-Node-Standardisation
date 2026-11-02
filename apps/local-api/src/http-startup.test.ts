import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeRepository } from "@iotedu/contracts";
import { componentManifestDir } from "@iotedu/contracts/paths";
import { MockMatterManagementService } from "@iotedu/matter-controller";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, readBoardProfile } from "./app.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const nodes = {
  async list() { return []; },
  async getById() { return null; },
  async save() {},
  async delete() {},
} as NodeRepository;

class HangingMatter extends MockMatterManagementService {
  override restore(): Promise<void> {
    return new Promise(() => undefined);
  }
}

describe("HTTP startup", () => {
  const closers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((app) => app.close()));
  });

  it("answers HTTP while a live Matter restore has not finished", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-http-"));
    const profile = await readBoardProfile(repoRoot);
    const app = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile,
      nativeAvailable: false,
      matterMode: "live",
      matter: new HangingMatter(nodes),
      reachabilityIntervalMs: 0,
      auth: "off",
    });
    closers.push(app);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, bind: "127.0.0.1" });
  });
});
