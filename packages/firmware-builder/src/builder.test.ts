import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryPaths } from "@iotedu/contracts/paths";
import {
  appFitsPartition,
  detectGpioConflicts,
  firmwareCompatibilityIssues,
  parseOtaShow,
  parsePartitionCsv,
  partitionLayoutId,
  readAppDescription,
  renderVersionSdkconfig,
  selectionIssues,
  versionSupersedes,
  type BoardProfile,
} from "./index.js";
import type { ComponentManifest } from "@iotedu/contracts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const profile: BoardProfile = {
  id: "esp32h2-devkitm-1",
  target: "esp32h2",
  gpioMin: 0,
  gpioMax: 27,
  reservedGpio: [
    { gpio: 8, reason: "strapping" },
    { gpio: 9, reason: "BOOT" },
  ],
  flashSizeBytes: 4 * 1024 * 1024,
  bootloaderOffset: 0,
  partitionTableOffset: 0xc000,
};

describe("firmware checks", () => {
  it("parses the reference partition table and keeps a stable layout id", async () => {
    const text = await readFile(path.join(repositoryPaths(repoRoot).firmwareTemplateRoot, "partitions.csv"), "utf8");
    const rows = parsePartitionCsv(text);
    const ota0 = rows.find((row) => row.name === "ota_0");
    const ota1 = rows.find((row) => row.name === "ota_1");
    const otadata = rows.find((row) => row.name === "otadata");
    expect(ota0).toMatchObject({ offset: 0x20000, size: 0x1e0000 });
    expect(ota1).toMatchObject({ offset: 0x200000, size: 0x1e0000 });
    expect(otadata?.offset).toBe(0x1d000);
    const id = partitionLayoutId({
      partitions: rows,
      flashSizeBytes: profile.flashSizeBytes,
      bootloaderOffset: profile.bootloaderOffset,
      partitionTableOffset: profile.partitionTableOffset,
    });
    expect(id).toHaveLength(64);
    expect(id).toBe(
      partitionLayoutId({
        partitions: rows,
        flashSizeBytes: profile.flashSizeBytes,
        bootloaderOffset: profile.bootloaderOffset,
        partitionTableOffset: profile.partitionTableOffset,
      }),
    );
  });

  it("rejects DHT11 and another driver sharing GPIO4, and reserved pins", () => {
    const issues = detectGpioConflicts(profile, [
      { componentId: "iotedu-dht11", pinName: "DHT11_DATA", gpio: 4 },
      { componentId: "iotedu-ldr", pinName: "LDR_ADC", gpio: 4 },
      { componentId: "iotedu-dht11", pinName: "DHT11_DATA_BAD", gpio: 9 },
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(["gpio_conflict", "gpio_reserved"]);
  });

  it("injects one aligned version snippet", () => {
    const text = renderVersionSdkconfig(2, "1.1");
    expect(text).toContain('CONFIG_APP_PROJECT_VER="1.1"');
    expect(text).toContain("CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=2");
    expect(text).toContain('set(PROJECT_VER "1.1")');
    expect(text).toContain("set(PROJECT_VER_NUMBER 2)");
  });

  it("blocks planned components and docker mode, and accepts a ready native driver", () => {
    const ldr = {
      id: "iotedu-ldr",
      name: "LDR",
      status: "planned",
      selectableForBuild: false,
      type: "sensor",
      firmware: null,
    } as ComponentManifest;
    const dht = {
      id: "iotedu-dht11",
      name: "DHT11",
      status: "experimental",
      selectableForBuild: true,
      type: "sensor",
      firmware: { registerFunction: "iotedu_dht11_register" },
    } as ComponentManifest;
    const planned = selectionIssues([ldr], ["iotedu-ldr"], "native");
    expect(planned.some((issue) => issue.code === "component_not_buildable")).toBe(true);
    expect(planned.some((issue) => issue.code === "toolchain_mode_unavailable")).toBe(false);
    expect(selectionIssues([dht], ["iotedu-dht11"], "docker").some((issue) => issue.code === "toolchain_mode_unavailable")).toBe(true);
    expect(selectionIssues([dht], ["iotedu-dht11"], "native")).toEqual([]);
  });

  it("treats a generated package version as newer than installed firmware", () => {
    expect(versionSupersedes(2, 1)).toBe(true);
    expect(versionSupersedes(1, 1)).toBe(false);
    expect(versionSupersedes(1, 2)).toBe(false);
  });

  it("reads an application description and a Matter OTA header", () => {
    const binary = Buffer.alloc(160);
    binary.writeUInt32LE(0xabcd5432, 32);
    binary.write("1.1.0", 48, "utf8");
    binary.write("sensors", 80, "utf8");
    binary.write("v5.4.1", 144, "utf8");
    expect(readAppDescription(binary)).toEqual({ version: "1.1.0", project: "sensors", idf: "v5.4.1" });
    const shown = parseOtaShow([
      "Magic: 1beef11e",
      "Total Size: 10",
      "Header Size: 4",
      "Header TLV:",
      "  [0] Vendor Id: 65521 (0xfff1)",
      "  [1] Product Id: 32768 (0x8000)",
      "  [2] Version: 2 (0x2)",
      "  [3] Version String: 1.1.0",
    ].join("\n"));
    expect(shown).toEqual({ vendorId: 65521, productId: 32768, version: 2, versionString: "1.1.0" });
  });

  it("rejects a package whose Matter OTA header disagrees with the compiled version", () => {
    const sdkconfig = [
      'CONFIG_IDF_TARGET="esp32h2"',
      "CONFIG_ENABLE_OTA_REQUESTOR=y",
      "CONFIG_MAX_FABRICS=5",
      "CONFIG_OPENTHREAD_ENABLED=y",
      "CONFIG_IOTEDU_DHT11_PIN=4",
      "CONFIG_APP_PROJECT_VER_FROM_CONFIG=y",
      'CONFIG_APP_PROJECT_VER="1.1.0"',
      "CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=2",
      "CONFIG_DEVICE_VENDOR_ID=0xFFF1",
      "CONFIG_DEVICE_PRODUCT_ID=0x8000",
    ].join("\n");
    const mismatch = firmwareCompatibilityIssues({
      sdkconfig,
      layoutId: "same",
      expectedLayoutId: "same",
      softwareVersion: 2,
      softwareVersionString: "1.1.0",
      dht11Gpio: 4,
      appBytes: 1591904,
      slotBytes: 0x1e0000,
      appVersion: "1.1.0",
      appProject: "sensors",
      ota: { vendorId: 0xfff1, productId: 0x8000, version: 1, versionString: "1.0" },
      vendorId: 0xfff1,
      productId: 0x8000,
      dependencyLockMatchesReference: true,
    });
    expect(mismatch.some((issue) => issue.code === "ota_header_mismatch")).toBe(true);
    const match = firmwareCompatibilityIssues({
      sdkconfig,
      layoutId: "same",
      expectedLayoutId: "same",
      softwareVersion: 2,
      softwareVersionString: "1.1.0",
      dht11Gpio: 4,
      appBytes: 1591904,
      slotBytes: 0x1e0000,
      appVersion: "1.1.0",
      appProject: "sensors",
      ota: { vendorId: 0xfff1, productId: 0x8000, version: 2, versionString: "1.1.0" },
      vendorId: 0xfff1,
      productId: 0x8000,
      dependencyLockMatchesReference: true,
    });
    expect(match).toEqual([]);
    const light = firmwareCompatibilityIssues({
      sdkconfig: sdkconfig.replace("CONFIG_IOTEDU_DHT11_PIN=4", "CONFIG_IOTEDU_LIGHT_ADC_GPIO=4").replace("CONFIG_DEVICE_PRODUCT_ID=0x8000", "CONFIG_DEVICE_PRODUCT_ID=0x8001"),
      layoutId: "same",
      expectedLayoutId: "same",
      softwareVersion: 2,
      softwareVersionString: "1.1.0",
      dht11Gpio: 4,
      pinExpectations: [{ key: "CONFIG_IOTEDU_LIGHT_ADC_GPIO", value: "4" }],
      expectedProductId: 0x8001,
      appBytes: 1591904,
      slotBytes: 0x1e0000,
      appVersion: "1.1.0",
      appProject: "sensors",
      ota: { vendorId: 0xfff1, productId: 0x8001, version: 2, versionString: "1.1.0" },
      vendorId: 0xfff1,
      productId: 0x8001,
      dependencyLockMatchesReference: true,
    });
    expect(light).toEqual([]);
  });

  it("rejects an image larger than the OTA slot and warns above 90%", () => {
    expect(appFitsPartition(0x1e0001, 0x1e0000)[0]?.code).toBe("firmware_too_large");
    expect(appFitsPartition(Math.floor(0x1e0000 * 0.91), 0x1e0000)[0]?.code).toBe("firmware_near_capacity");
    expect(appFitsPartition(1591552, 0x1e0000)).toEqual([]);
  });
});
