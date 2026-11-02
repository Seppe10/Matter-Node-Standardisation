import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { matterJsVersion, openMatterTransport } from "./live.js";

async function credentialDigest(directory: string): Promise<string> {
  const names = (await readdir(directory, { recursive: true })).map(String).filter((name) => !name.endsWith(".tmp") && !name.includes("trace")).sort();
  const files: string[] = [];
  for (const name of names) {
    if (!/rootKeyPair|rootKeyIdentifier|rootCertBytes/.test(name)) continue;
    const info = await stat(path.join(directory, name));
    if (info.isFile()) files.push(name);
  }
  expect(files.length).toBeGreaterThan(0);
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name);
    hash.update(await readFile(path.join(directory, name)));
  }
  return hash.digest("hex");
}

describe("Matter.js controller identity", () => {
  const closers: Array<{ close(): Promise<void> }> = [];
  afterAll(async () => {
    await Promise.all(closers.splice(0).map((transport) => transport.close()));
  });

  it("reopens the same stored credentials", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "iotedu-matterjs-"));
    const first = await openMatterTransport(directory, { create: true });
    closers.push(first);
    const created = await first.ensureStarted({ create: true });
    expect(created.matterJsVersion).toBe("0.18.0");
    expect(matterJsVersion()).toBe("0.18.0");
    expect(created.credentialId).toBeTruthy();
    expect(created.controllerNodeId).toBeTruthy();
    const digest = await credentialDigest(directory);
    await first.close();

    const second = await openMatterTransport(directory, { create: false });
    closers.push(second);
    const restored = await second.ensureStarted({ create: false });
    expect(restored.credentialId).toBe(created.credentialId);
    expect(restored.controllerNodeId).toBe(created.controllerNodeId);
    expect(await credentialDigest(directory)).toBe(digest);
    const again = await openMatterTransport(directory, { create: true });
    const reread = await again.ensureStarted({ create: true });
    expect(reread.credentialId).toBe(restored.credentialId);
    expect(reread.controllerNodeId).toBe(restored.controllerNodeId);
    expect(await credentialDigest(directory)).toBe(digest);
    await second.close();
  }, 120_000);
});
