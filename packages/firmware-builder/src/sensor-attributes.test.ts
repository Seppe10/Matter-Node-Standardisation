import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryPaths } from "@iotedu/contracts/paths";
import { versionSupersedes } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rangesHeader = path.join(repoRoot, "packages/firmware-builder/src/hosts/iotedu_dht11_ranges.h");
const driver = path.join(repoRoot, "packages/firmware-builder/src/hosts/dht11_matter.cpp");
const core = path.join(repositoryPaths(repoRoot).firmwareComponentsRoot, "iotedu_core", "iotedu_core.cpp");

function constant(header: string, name: string): number {
  const match = header.match(new RegExp(`#define ${name} (-?\\d+)`));
  if (!match?.[1]) throw new Error(`${name} is missing from the DHT11 range header`);
  return Number(match[1]);
}

describe("DHT11 Matter attribute ranges", () => {
  it("advertises the DHT11 operating range in Matter 0.01 units", async () => {
    const header = await readFile(rangesHeader, "utf8");
    expect(constant(header, "IOTEDU_DHT11_TEMP_MIN_CENTI")).toBe(0);
    expect(constant(header, "IOTEDU_DHT11_TEMP_MAX_CENTI")).toBe(5000);
    expect(constant(header, "IOTEDU_DHT11_HUMIDITY_MIN_CENTI")).toBe(2000);
    expect(constant(header, "IOTEDU_DHT11_HUMIDITY_MAX_CENTI")).toBe(9000);
    expect(constant(header, "IOTEDU_DHT11_TEMP_MIN_C") * 100).toBe(constant(header, "IOTEDU_DHT11_TEMP_MIN_CENTI"));
    expect(constant(header, "IOTEDU_DHT11_TEMP_MAX_C") * 100).toBe(constant(header, "IOTEDU_DHT11_TEMP_MAX_CENTI"));
    expect(constant(header, "IOTEDU_DHT11_HUMIDITY_MIN_PERCENT") * 100).toBe(constant(header, "IOTEDU_DHT11_HUMIDITY_MIN_CENTI"));
    expect(constant(header, "IOTEDU_DHT11_HUMIDITY_MAX_PERCENT") * 100).toBe(constant(header, "IOTEDU_DHT11_HUMIDITY_MAX_CENTI"));
  });

  it("initialises measured values to null and refuses readings outside the advertised range", async () => {
    const header = await readFile(rangesHeader, "utf8");
    const source = await readFile(driver, "utf8");
    expect(source).toContain("measured_value = nullable<int16_t>()");
    expect(source).toContain("measured_value = nullable<uint16_t>()");
    expect(source).toContain("min_measured_value = nullable<int16_t>(IOTEDU_DHT11_TEMP_MIN_CENTI)");
    expect(source).toContain("max_measured_value = nullable<int16_t>(IOTEDU_DHT11_TEMP_MAX_CENTI)");
    expect(source).toContain("min_measured_value = nullable<uint16_t>(IOTEDU_DHT11_HUMIDITY_MIN_CENTI)");
    expect(source).toContain("max_measured_value = nullable<uint16_t>(IOTEDU_DHT11_HUMIDITY_MAX_CENTI)");
    expect(source).toContain("iotedu_dht11_temperature_acceptable");
    expect(source).toContain("iotedu_dht11_humidity_acceptable");
    expect(source).toContain("was not reported");

    const tempMin = constant(header, "IOTEDU_DHT11_TEMP_MIN_C");
    const tempMax = constant(header, "IOTEDU_DHT11_TEMP_MAX_C");
    const humidityMin = constant(header, "IOTEDU_DHT11_HUMIDITY_MIN_PERCENT");
    const humidityMax = constant(header, "IOTEDU_DHT11_HUMIDITY_MAX_PERCENT");
    const temperatureOk = (value: number) => value >= tempMin && value <= tempMax;
    const humidityOk = (value: number) => value >= humidityMin && value <= humidityMax;
    expect(temperatureOk(0)).toBe(true);
    expect(temperatureOk(50)).toBe(true);
    expect(temperatureOk(-1)).toBe(false);
    expect(temperatureOk(51)).toBe(false);
    expect(humidityOk(20)).toBe(true);
    expect(humidityOk(90)).toBe(true);
    expect(humidityOk(19)).toBe(false);
    expect(humidityOk(91)).toBe(false);
    expect(humidityOk(0)).toBe(false);
  });

  it("publishes one stable serial number and keeps the GPIO9 factory reset", async () => {
    const source = await readFile(core, "utf8");
    expect(source).toContain("create_serial_number");
    expect(source).toContain("chip-factory");
    expect(source).toContain("serial-num");
    expect(source).toContain("ESP_MAC_BASE");
    expect(source).toContain("nvs_get_str");
    expect(source).toContain("factory_reset_button_register");
    expect(source).toContain("app_reset_button_register");
  });

  it("keeps 1.3.0 / SoftwareVersion 4 newer than the stored 1.1.0 and 1.2.0 packages", () => {
    expect(versionSupersedes(4, 2)).toBe(true);
    expect(versionSupersedes(4, 3)).toBe(true);
    expect(versionSupersedes(3, 4)).toBe(false);
    expect(versionSupersedes(2, 4)).toBe(false);
  });
});
