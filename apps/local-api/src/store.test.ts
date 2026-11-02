import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonJobRepository, removeOrphanTemporaryFiles } from "./store.js";

describe("OTA job persistence", () => {
  it("keeps every concurrent ledger write and uses a unique temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "iotedu-ledger-"));
    const file = path.join(directory, "ota-jobs.json");
    const jobs = new JsonJobRepository<{ id: string; message: string }>(file);
    await Promise.all(Array.from({ length: 24 }, (_, index) => jobs.save({ id: `job-${index}`, message: `event-${index}` })));
    const stored = JSON.parse(await readFile(file, "utf8")) as { id: string }[];
    expect(stored).toHaveLength(24);
    expect(new Set(stored.map((job) => job.id)).size).toBe(24);
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names.join(" ")).not.toMatch(/ota-jobs\.json\.\d+\.tmp$/);
  });

  it("preserves the last sequential update and recovers after a leftover temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "iotedu-ledger-"));
    const file = path.join(directory, "ota-jobs.json");
    const jobs = new JsonJobRepository<{ id: string; message: string }>(file);
    for (let index = 0; index < 12; index += 1) {
      await jobs.save({ id: "job-1", message: `event-${index}` });
    }
    expect((await jobs.list())[0]?.message).toBe("event-11");
    await writeFile(`${file}.999.orphan.tmp`, "not json");
    await removeOrphanTemporaryFiles(directory);
    expect(await readdir(directory)).toEqual(["ota-jobs.json"]);
    expect((await jobs.list())[0]?.message).toBe("event-11");
  });

  it("reads a missing, empty, or corrupt history as an empty list and still saves a new record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "iotedu-sessions-"));
    const file = path.join(directory, "programmer-sessions.json");
    const jobs = new JsonJobRepository<{ id: string }>(file, { tolerant: true });
    expect(await jobs.list()).toEqual([]);
    await writeFile(file, "");
    expect(await jobs.list()).toEqual([]);
    await writeFile(file, "{");
    expect(await jobs.list()).toEqual([]);
    await writeFile(file, "{\"not\":\"an array\"}");
    expect(await jobs.list()).toEqual([]);
    await jobs.save({ id: "fresh" });
    expect(await jobs.list()).toEqual([{ id: "fresh" }]);
  });
});
