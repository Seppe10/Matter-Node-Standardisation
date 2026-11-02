import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)));

async function sourceText(): Promise<string> {
  const files = (await readdir(src, { recursive: true })).filter((name) => String(name).endsWith(".tsx"));
  const chunks = await Promise.all(files.map((name) => readFile(path.join(src, String(name)), "utf8")));
  return chunks.join("\n");
}

describe("desktop UI boundaries", () => {
  it("does not render a sensor or actuator dashboard", async () => {
    const text = await sourceText();
    expect(text).not.toMatch(/recharts|chart\.js|TemperatureMeasurement|RelativeHumidityMeasurement|actuator control/i);
    expect(text).toContain("Pair New Node");
    expect(text).toContain("Add a smart-home node to IoT.Edu management");
    expect(text).toContain("Add an existing Apple Home device to IoT.Edu");
    expect(text).toContain("APPLE_HOME_STEPS");
    expect(text).toContain("Smart Home Connection");
    expect(text).toContain("Full Flash Erase");
    expect(text).toContain("Settings");
    const app = await readFile(path.join(src, "App.tsx"), "utf8");
    expect(app).not.toContain("<svg");
    expect(text).toContain("Continue to Overview");
    expect(text).toContain("Continue to Pair New Node");
    const labels = [...app.matchAll(/\[\"[^\"]+\", \"([^\"]+)\"/g)].map((match) => match[1]);
    expect(labels).toEqual([
      "Overview",
      "Setup",
      "Smart Home Connection",
      "Pair New Node",
      "Firmware Builder",
      "AI-Assisted Development",
      "Settings",
    ]);
    expect(app).toContain('path="/verify"');
    expect(app).toContain('path="/library"');
    expect(text).toContain("Selected Node");
    expect(text).toContain("Decommission from IoT.Edu");
    expect(text).toContain("Forget Local Record Only");
    expect(text).toContain("Write and Flash Firmware");
    expect(text).toContain("Step 1 — Identify Hardware");
    expect(text).toContain("Step 2 — Configure & Install Firmware");
    expect(text).toContain("Step 3 — Connect to Smart Home");
    expect(text).toContain("Continue to Firmware Installation");
    expect(text).toContain("Confirm Full Flash Erase");
    expect(text).toContain("Flash Erase Complete");
    expect(text).toContain("Backup before erase");
    expect(text).not.toContain("disabled>Full Flash Erase");
  });
});
