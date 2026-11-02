import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { componentManifestDir } from "@iotedu/contracts/paths";
import { LocalCatalogRepository } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestDir = componentManifestDir(repoRoot);

describe("local catalogue", () => {
  const catalog = new LocalCatalogRepository(manifestDir, repoRoot);

  it("loads every local manifest and validates", async () => {
    const items = await catalog.list();
    expect(items.map((item) => item.id).sort()).toEqual([
      "iotedu-core",
      "iotedu-dht11",
      "iotedu-endpoint-templates",
      "iotedu-ldr",
      "iotedu-pir",
      "iotedu-rgb",
    ]);
    const validation = await catalog.validate();
    expect(validation.ok).toBe(true);
  });

  it("searches offline by name and cluster", async () => {
    const byName = await catalog.search("DHT11 Driver");
    expect(byName.map((item) => item.id)).toEqual(["iotedu-dht11"]);
    const byCluster = await catalog.search("TemperatureMeasurement");
    expect(byCluster.map((item) => item.id)).toEqual(["iotedu-dht11"]);
  });

  it("does not offer planned drivers for a build", async () => {
    const planned = await catalog.search("", "planned");
    expect(planned.every((item) => item.selectableForBuild === false)).toBe(true);
    expect(planned.map((item) => item.id).sort()).toEqual(["iotedu-ldr", "iotedu-pir", "iotedu-rgb"]);
  });
});
