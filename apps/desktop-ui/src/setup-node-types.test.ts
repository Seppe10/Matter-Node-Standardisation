import { describe, expect, it } from "vitest";
import {
  choosePackages,
  flashBytesFromLabel,
  initialNodeTypeId,
  installationAllowed,
  packageAfterTypeChange,
  selectedPackage,
  wiringFor,
  type SetupNodeType,
} from "./setup-node-types.js";

const dht11Package = {
  buildId: "87e7ff73-5342-42d9-9fdf-25e7c57dac1f",
  softwareVersion: 5,
  softwareVersionString: "1.4.0",
  buildStatus: "succeeded",
  releaseState: "release_candidate" as const,
  legacy: false,
  hardware: "esp32h2",
  pins: [{ name: "DHT11_DATA", gpio: 4 }],
  hashVerified: true,
  identityVerified: true,
  deviceRevision: 2,
  coreRevision: null,
  endpoints: ["temperature_sensor", "humidity_sensor"],
};

const olderPackage = {
  ...dht11Package,
  buildId: "older",
  softwareVersion: 4,
  softwareVersionString: "1.3.0",
  releaseState: "legacy" as const,
  legacy: true,
  identityVerified: false,
  deviceRevision: null,
  endpoints: [],
};

function type(overrides: Partial<SetupNodeType> = {}): SetupNodeType {
  return {
    id: "environmental-dht11",
    name: "Environmental Sensor — DHT11",
    description: "Temperature and humidity.",
    category: "sensor",
    target: "esp32h2",
    status: "compiled",
    statusLabel: "Compiled / Available",
    pendingReason: null,
    matterCore: { id: "matter-core-iotedu", name: "Matter core", revision: 2 },
    device: { id: "custom-dht11", name: "DHT11", revision: 2, validationState: "validated" },
    gpio: [{ name: "data", gpio: 4, description: "Single-wire data" }],
    endpoints: ["temperature_sensor", "humidity_sensor"],
    packages: [dht11Package],
    ...overrides,
  };
}

const ready = {
  chipModel: "ESP32-H2",
  flashLabel: "4 MB",
  requiredFlashBytes: 4_194_304,
  identified: true,
  planReady: true,
};

describe("setup node types", () => {
  it("starts with no Node Type selected", () => {
    expect(initialNodeTypeId()).toBeNull();
    expect(installationAllowed({ ...ready, nodeType: null, package: null }).allowed).toBe(false);
  });

  it("shows one package without requiring a choice and several packages as a choice", () => {
    expect(choosePackages(type()).kind).toBe("single");
    expect(choosePackages(type({ packages: [dht11Package, olderPackage] })).kind).toBe("many");
    expect(choosePackages(type({ status: "pending", packages: [], pendingReason: "Source validation is outstanding." })).kind).toBe("none");
  });

  it("clears the package when the Node Type changes and keeps a single package", () => {
    expect(packageAfterTypeChange(type({ packages: [dht11Package, olderPackage] }))).toBeNull();
    expect(packageAfterTypeChange(type())).toBe(dht11Package.buildId);
    expect(selectedPackage(type({ packages: [dht11Package, olderPackage] }), olderPackage.buildId)?.softwareVersionString).toBe("1.3.0");
    expect(selectedPackage(type(), olderPackage.buildId)).toBeNull();
  });

  it("shows the compiled pin rather than a separately edited GPIO", () => {
    const wiring = wiringFor(type(), dht11Package);
    expect(wiring).toEqual([{ name: "data", gpio: 4, description: "Single-wire data", source: "compiled-package" }]);
  });

  it("blocks pending types, the wrong chip, a small flash, and a bad hash", () => {
    const pending = type({ status: "pending", packages: [], pendingReason: "Source validation is outstanding." });
    expect(installationAllowed({ ...ready, nodeType: pending, package: null }).reason).toMatch(/Source validation/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: dht11Package, chipModel: "ESP32" }).allowed).toBe(false);
    expect(installationAllowed({ ...ready, nodeType: type(), package: dht11Package, flashLabel: "2 MB" }).reason).toMatch(/enough flash/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, hashVerified: false } }).reason).toMatch(/hash/);
    expect(flashBytesFromLabel("4 MB")).toBe(4_194_304);
  });

  it("installs a verified DHT11 package and refuses a revision, endpoint, board, or GPIO mismatch", () => {
    expect(installationAllowed({ ...ready, nodeType: type(), package: dht11Package }).allowed).toBe(true);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, identityVerified: false } }).reason).toMatch(/component revision/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, deviceRevision: 1 } }).reason).toMatch(/component revision/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, coreRevision: 1 } }).reason).toMatch(/Matter core/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, endpoints: ["temperature_sensor"] } }).reason).toMatch(/Matter endpoints/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, hardware: "esp32" } }).reason).toMatch(/board/);
    expect(installationAllowed({ ...ready, nodeType: type(), package: { ...dht11Package, pins: [{ name: "DHT11_DATA", gpio: 5 }] } }).reason).toMatch(/GPIO/);
  });
});
