import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "./load-env.js";

const KEYS = ["IOTEDU_TEST_IDF_PATH", "IOTEDU_TEST_DATA_DIR", "IOTEDU_TEST_URL"];

describe(".env loading", () => {
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it("expands ~ in path settings only, and never overrides the shell", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "iotedu-env-"));
    const file = path.join(dir, ".env");
    await writeFile(file, "IOTEDU_TEST_IDF_PATH=~/esp/esp-idf-v5.4.1\nIOTEDU_TEST_URL=~/not-a-path\nIOTEDU_TEST_DATA_DIR=~/kept\n");
    process.env.IOTEDU_TEST_DATA_DIR = "/from/shell";
    await loadEnvFile(file);
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(process.env.IOTEDU_TEST_IDF_PATH).toBe(path.join(home, "esp", "esp-idf-v5.4.1"));
    expect(process.env.IOTEDU_TEST_URL).toBe("~/not-a-path");
    expect(process.env.IOTEDU_TEST_DATA_DIR).toBe("/from/shell");
  });
});
