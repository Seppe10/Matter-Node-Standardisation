import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ComponentManifest } from "@iotedu/contracts";
import { repositoryPaths } from "@iotedu/contracts/paths";
import { approvedLibraryRecords, detectGpioConflicts, extractSafeZip, validateLibraryComponent, zipCrc32, type BoardProfile } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const profile = JSON.parse(readFileSync(path.join(repositoryPaths(repoRoot).boardProfilesRoot, "esp32h2.json"), "utf8")) as BoardProfile;

function source(text: string, name = "sensor.c") {
  return [{ name, data: Buffer.from(text) }];
}

function packZip(entries: { name: string; data: Buffer; method?: 0 | 8; external?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const crc = zipCrc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const file = Buffer.concat([local, compressed]);
    locals.push(file);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.external ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += file.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const compiled = { available: true, ran: true, success: true, diagnostics: [] };

function componentFiles(body = "static const int data_gpio = 4;\n") {
  return [
    { name: "sensor.c", data: Buffer.from(`#include "sensor.h"\n${body}\nesp_err_t sensor_init(uint16_t endpoint_id) { (void)endpoint_id; (void)data_gpio; return 0; }\n`) },
    { name: "sensor.h", data: Buffer.from("#pragma once\n#include \"esp_err.h\"\nesp_err_t sensor_init(uint16_t endpoint_id);\n") },
    { name: "CMakeLists.txt", data: Buffer.from("idf_component_register(SRCS \"sensor.c\" INCLUDE_DIRS \".\")\n") },
  ];
}

const valid = {
  name: "DHT11 Temperature and Humidity",
  description: "Reads temperature and humidity from a single-wire sensor.",
  type: "sensor",
  gpio: [{ name: "data_gpio", gpio: 4, description: "Single-wire sensor data" }],
  files: componentFiles(),
  profile,
  namesTaken: [],
  compile: compiled,
};

describe("firmware library validation", () => {
  it("enables a save only after a clean native compile and a verified interface", () => {
    const result = validateLibraryComponent(valid);
    expect(result.ok).toBe(true);
    expect(result.nativeCompile).toBe(true);
    expect(result.integration?.functionName).toBe("sensor_init");
    expect(result.issues.some((issue) => issue.level === "error" || issue.level === "warning")).toBe(false);
    const warned = validateLibraryComponent({ ...valid, compile: { ...compiled, diagnostics: [{ level: "warning", message: "unused variable" }] } });
    expect(warned.ok).toBe(false);
    expect(warned.fingerprint).toBeNull();
    const unavailable = validateLibraryComponent({ ...valid, compile: { available: false, ran: false, success: false, diagnostics: [] } });
    expect(unavailable.issues.some((issue) => issue.code === "native_compile_unavailable" && issue.level === "error")).toBe(true);
  });

  it("changes the fingerprint when the classification or source changes", () => {
    const sensor = validateLibraryComponent(valid);
    const actuator = validateLibraryComponent({ ...valid, type: "actuator" });
    const renamed = validateLibraryComponent({ ...valid, name: "Other name" });
    expect(sensor.fingerprint).not.toBe(actuator.fingerprint);
    expect(sensor.fingerprint).not.toBe(renamed.fingerprint);
  });

  it("rejects empty metadata, duplicate names, and keeps a component's own name", () => {
    expect(validateLibraryComponent({ ...valid, name: "   ", description: " " }).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid_name", "invalid_description"]),
    );
    expect(validateLibraryComponent({ ...valid, namesTaken: ["dht11 temperature and humidity"] }).ok).toBe(false);
    expect(validateLibraryComponent({
      ...valid,
      namesTaken: ["DHT11 Temperature and Humidity"],
      ownName: "dht11 temperature and humidity",
    }).ok).toBe(true);
  });

  it("rejects an unsupported file, a missing C file, and a missing CMake source", () => {
    expect(validateLibraryComponent({ ...valid, files: source("int data_gpio = 4;\n", "notes.py") }).issues
      .some((issue) => issue.code === "unsupported_file")).toBe(true);
    expect(validateLibraryComponent({ ...valid, files: source("int data_gpio = 4;\n", "sensor.h") }).issues
      .some((issue) => issue.code === "missing_source")).toBe(true);
    const cmake = Buffer.from('idf_component_register(SRCS "missing.c")\n');
    const result = validateLibraryComponent({
      ...valid,
      files: [...valid.files.filter((file) => file.name !== "CMakeLists.txt"), { name: "CMakeLists.txt", data: cmake }],
    });
    expect(result.issues.some((issue) => issue.code === "missing_file" && issue.message.includes("missing.c"))).toBe(true);
  });

  it("rejects GPIO values the ESP32-H2 board profile does not allow", () => {
    const reserved = validateLibraryComponent({ ...valid, gpio: [{ name: "data_gpio", gpio: 9, description: "" }] });
    expect(reserved.issues.some((issue) => issue.code === "gpio_reserved" && issue.message.includes("factory-reset"))).toBe(true);
    const range = validateLibraryComponent({ ...valid, gpio: [{ name: "data_gpio", gpio: 99, description: "" }] });
    expect(range.issues.some((issue) => issue.code === "gpio_out_of_range")).toBe(true);
    const duplicate = validateLibraryComponent({
      ...valid,
      files: source("static int data_gpio = 4;\nstatic int clock_gpio = 4;\n"),
      gpio: [
        { name: "data_gpio", gpio: 4, description: "" },
        { name: "clock_gpio", gpio: 4, description: "" },
      ],
    });
    expect(duplicate.issues.some((issue) => issue.code === "gpio_conflict")).toBe(true);
    const profilePins = detectGpioConflicts(profile, [
      { componentId: "library", pinName: "data_gpio", gpio: 9 },
    ]);
    expect(profilePins.some((issue) => issue.code === "gpio_reserved")).toBe(true);
  });

  it("rejects a GPIO mapping the uploaded source does not reference", () => {
    const result = validateLibraryComponent({
      ...valid,
      files: source("static const int data_gpio = 4;\n"),
      gpio: [{ name: "clock_gpio", gpio: 12, description: "" }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "gpio_unreferenced" && issue.message.includes("clock_gpio"))).toBe(true);
  });

  it("keeps a missing pin number as a warning that blocks saving", () => {
    const result = validateLibraryComponent({
      ...valid,
      files: [
        ...componentFiles("static const int data_gpio = CONFIG_DATA_GPIO;\n"),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "gpio_not_in_source" && issue.level === "warning")).toBe(true);
  });

  it("recognises an initialisation function and an ESP32-H2 ADC channel", () => {
    const driver = Buffer.from("#include \"photosensitive_sensor.h\"\nstatic const int PHOTOSENSITIVE_ADC_CHANNEL = ADC_CHANNEL_3;\nesp_err_t photosensitive_sensor_init(uint16_t endpoint_id) { (void)endpoint_id; (void)PHOTOSENSITIVE_ADC_CHANNEL; return 0; }\n");
    const header = Buffer.from("#pragma once\n#include \"esp_err.h\"\nesp_err_t photosensitive_sensor_init(uint16_t endpoint_id);\n");
    const cmake = Buffer.from("idf_component_register(SRCS \"photosensitive_sensor.cpp\" INCLUDE_DIRS \".\")\n");
    const matched = validateLibraryComponent({
      ...valid,
      files: [
        { name: "photosensitive_sensor.cpp", data: driver },
        { name: "photosensitive_sensor.h", data: header },
        { name: "CMakeLists.txt", data: cmake },
      ],
      gpio: [{ name: "Light", gpio: 4, description: "ADC channel 3" }],
    });
    expect(matched.integration?.functionName).toBe("photosensitive_sensor_init");
    expect(matched.integration?.endpointOwnedBy).toBe("host");
    expect(matched.issues.some((issue) => issue.code === "gpio_fixed_mismatch")).toBe(false);
    const conflict = validateLibraryComponent({
      ...valid,
      files: matched.files.length ? [
        { name: "photosensitive_sensor.cpp", data: driver },
        { name: "photosensitive_sensor.h", data: header },
        { name: "CMakeLists.txt", data: cmake },
      ] : [],
      gpio: [{ name: "Light", gpio: 7, description: "" }],
    });
    expect(conflict.issues.some((issue) => issue.code === "gpio_fixed_mismatch" && issue.message.includes("GPIO 4"))).toBe(true);
    const application = validateLibraryComponent({
      ...valid,
      files: [
        { name: "photosensitive_sensor.cpp", data: driver },
        { name: "photosensitive_sensor.h", data: header },
        { name: "app_main.cpp", data: Buffer.from("void app_main(void) { photosensitive_sensor_init(1); }\n") },
        { name: "CMakeLists.txt", data: Buffer.from("cmake_minimum_required(VERSION 3.5)\nproject(sensors)\n") },
      ],
      gpio: [{ name: "Light", gpio: 4, description: "" }],
    });
    expect(application.files.map((file) => file.name)).not.toContain("app_main.cpp");
    expect(application.issues.some((issue) => issue.code === "missing_cmake")).toBe(true);
    expect(application.issues.some((issue) => issue.code === "host_application_excluded" && issue.level === "info")).toBe(true);
    const projectCmake = Buffer.from("cmake_minimum_required(VERSION 3.5)\nproject(sensors)\n");
    const mainCmake = Buffer.from('idf_component_register(SRC_DIRS "." "drivers" INCLUDE_DIRS "." "drivers" PRIV_REQUIRES esp_adc esp_matter)\n');
    const supplied = validateLibraryComponent({
      ...valid,
      files: [
        { name: "CMakeLists.txt", data: projectCmake },
        { name: "main/CMakeLists.txt", data: mainCmake },
        { name: "main/app_main.cpp", data: Buffer.from("void app_main(void) { photosensitive_sensor_init(1); }\n") },
        { name: "main/drivers/photosensitive_sensor.cpp", data: driver },
        { name: "main/drivers/photosensitive_sensor.h", data: header },
        { name: "main/Kconfig.projbuild", data: Buffer.from("menu \"Pins\"\nendmenu\n") },
      ],
      gpio: [{ name: "Light", gpio: 4, description: "" }],
    });
    expect(supplied.files.map((file) => file.name)).toEqual([
      "main/drivers/photosensitive_sensor.cpp",
      "main/drivers/photosensitive_sensor.h",
      "main/Kconfig.projbuild",
    ]);
    expect(supplied.integration?.functionName).toBe("photosensitive_sensor_init");
    expect(supplied.issues.some((issue) => issue.code === "missing_cmake" && issue.level === "error")).toBe(true);
    expect(supplied.ok).toBe(false);
  });

  it("rejects another chip target", () => {
    const result = validateLibraryComponent({
      ...valid,
      files: source('#define CONFIG_IDF_TARGET="esp32s3"\nstatic const int data_gpio = 4;\n'),
    });
    expect(result.issues.some((issue) => issue.code === "unsupported_target")).toBe(true);
  });

  it("does not turn a verified core or an experimental driver into approved code", () => {
    const experimental = {
      id: "iotedu-dht11",
      name: "DHT11 Driver",
      description: "Experimental driver",
      type: "sensor",
      version: "1.0.0",
      status: "experimental",
      source: "local",
      target: "esp32h2",
      idfCompatibility: ">=5.4.1 <5.5",
      selectableForBuild: true,
      firmware: null,
    } satisfies ComponentManifest;
    const core = { ...experimental, id: "iotedu-core", type: "core", status: "verified" } satisfies ComponentManifest;
    const approved = {
      ...experimental,
      id: "approved-temp",
      status: "verified",
      firmware: {
        idfComponentDir: "firmware/components/approved_temp",
        registerFunction: "approved_temp_register",
        requires: [],
        kconfig: [{ key: "CONFIG_APPROVED_TEMP_PIN", pinName: "TEMP_DATA", default: 4 }],
        matter: { endpoints: [], clusters: [] },
      },
    } satisfies ComponentManifest;
    expect(approvedLibraryRecords([experimental, core, approved]).map((item) => item.id)).toEqual(["approved-temp"]);
  });
});

describe("safe zip extraction", () => {
  it("unpacks stored and deflated source files", () => {
    const stored = extractSafeZip(packZip([{ name: "sensor.c", data: Buffer.from("int data_gpio = 4;\n") }]));
    const deflated = extractSafeZip(packZip([{ name: "sensor.c", data: Buffer.from("int data_gpio = 4;\n"), method: 8 }]));
    expect(stored[0]?.data.toString()).toBe("int data_gpio = 4;\n");
    expect(deflated[0]?.data.toString()).toBe("int data_gpio = 4;\n");
  });

  it("rejects path traversal, symlinks, and unsupported contents", () => {
    expect(() => extractSafeZip(packZip([{ name: "../iotedu_core.h", data: Buffer.from("nope") }]))).toThrow(/escapes/);
    expect(() => extractSafeZip(packZip([{ name: "/tmp/sensor.c", data: Buffer.from("int x;") }]))).toThrow(/escapes/);
    expect(() => extractSafeZip(packZip([{
      name: "link.c",
      data: Buffer.from("target"),
      external: Number(0o120755n << 16n),
    }]))).toThrow(/Symbolic links/);
    expect(() => extractSafeZip(packZip([{ name: "install.sh", data: Buffer.from("echo") }]))).toThrow(/not an allowed source file/);
    const nested = extractSafeZip(packZip([
      { name: "driver/CMakeLists.txt", data: Buffer.from("idf_component_register(SRCS \"driver/sensor.c\")\n") },
      { name: "driver/sensor.c", data: Buffer.from("int data_gpio = 4;\n") },
      { name: "driver/Kconfig", data: Buffer.from("menu \"Pins\"\nendmenu\n") },
      { name: "sdkconfig", data: Buffer.from("CONFIG_IDF_TARGET=\"esp32h2\"\n") },
    ]));
    expect(nested.map((file) => file.name).sort()).toEqual(["driver/CMakeLists.txt", "driver/Kconfig", "driver/sensor.c"]);
  });
});
