import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryPaths } from "@iotedu/contracts/paths";
import { catalogueSourceFingerprint, generateCatalogueWorkspace, generateNodeWorkspace, generateRetainedWorkspace, type CatalogueSourceFile } from "./catalogue-workspace.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function source(relativePath: string, content: string): CatalogueSourceFile {
  return {
    relativePath,
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

const coreFiles = [
  source("CMakeLists.txt", 'idf_component_register(SRCS "iotedu_core.cpp" REQUIRES esp_matter)\n'),
  source("iotedu_core.cpp", "esp_err_t iotedu_core_prepare(void) { return 0; }\n"),
  source("include/iotedu_core.h", "#pragma once\n"),
];

const dht11Files = [
  source("CMakeLists.txt", 'idf_component_register(SRCS "dht11.c" REQUIRES esp_driver_gpio)\n'),
  source("dht11.c", "int dht11_init_pin(int pin) { return pin; }\n"),
  source("dht11.h", "#pragma once\n"),
];

async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string, prefix: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), next);
      else found.push(next);
    }
  }
  await walk(dir, "");
  return found.sort();
}

describe("catalogue firmware workspace", () => {
  it("reconstructs the Neon sources and one Matter entry point", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-catalogue-"));
    const generated = await generateCatalogueWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 5,
      softwareVersionString: "1.4.0",
      dht11Gpio: 4,
      coreFiles,
      dht11Files,
    });
    expect(generated.softwareVersion).toBe(5);
    expect(generated.partitionLayoutId).toMatch(/^[a-f0-9]{64}$/);
    const cmake = await readFile(path.join(outDir, "CMakeLists.txt"), "utf8");
    expect(cmake).toContain('set(PROJECT_VER "1.4.0")');
    expect(cmake).toContain("set(PROJECT_VER_NUMBER 5)");
    expect(cmake).toContain(path.join(outDir, "components"));
    expect(cmake).not.toContain("firmware/components");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(defaults).toContain("CONFIG_IOTEDU_DHT11_PIN=4");
    expect(defaults).toContain("CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=5");
    const driver = await readFile(path.join(outDir, "components/iotedu_dht11/dht11.c"), "utf8");
    expect(driver).toBe(dht11Files[1]?.content);
    const host = await readFile(path.join(outDir, "main/dht11_matter.cpp"), "utf8");
    expect(host).toContain("dht11_init_pin");
    expect(host).toContain("CONFIG_IOTEDU_DHT11_PIN");
    expect(host).not.toContain("app_main");
    const names = await tree(outDir);
    const entryPoints = names.filter((name) => name.endsWith("app_main.cpp"));
    expect(entryPoints).toEqual(["main/app_main.cpp"]);
    const app = await readFile(path.join(outDir, "main/app_main.cpp"), "utf8");
    expect(app.match(/app_main\s*\(/g)).toHaveLength(1);
    expect(app).toContain("iotedu_core_prepare");
    expect(app).toContain("iotedu_core_start");
    const h2 = await readFile(path.join(outDir, "sdkconfig.defaults.esp32h2"), "utf8");
    expect(h2).toContain("CONFIG_OPENTHREAD_ENABLED=y");
    expect(h2).toContain("CONFIG_ENABLE_WIFI_STATION=n");
    expect(defaults).toContain("CONFIG_ENABLE_MATTER_OVER_THREAD=y");
    expect(catalogueSourceFingerprint(coreFiles.map((file) => ({ role: "source", relativePath: file.relativePath, sha256: file.sha256 })))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a source hash mismatch, a reserved GPIO, and a second component on the same pin", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-catalogue-"));
    const broken = coreFiles.map((file) => ({ ...file }));
    const cmake = broken[0];
    if (!cmake) throw new Error("missing cmake");
    cmake.sha256 = "0".repeat(64);
    await expect(generateCatalogueWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 5,
      softwareVersionString: "1.4.0",
      dht11Gpio: 4,
      coreFiles: broken,
      dht11Files,
    })).rejects.toThrow(/hash/);
    await expect(generateCatalogueWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 5,
      softwareVersionString: "1.4.0",
      dht11Gpio: 9,
      coreFiles,
      dht11Files,
    })).rejects.toThrow(/GPIO9/);
    await expect(generateCatalogueWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 5,
      softwareVersionString: "1.4.0",
      dht11Gpio: 4,
      coreFiles,
      dht11Files,
      extraPins: [{ componentId: "custom-rgb-led", pinName: "RGB_RED", gpio: 4 }],
    })).rejects.toThrow(/GPIO4/);
  });

  it("does not compile extra components into the DHT11 image", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-catalogue-"));
    await expect(generateCatalogueWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 5,
      softwareVersionString: "1.4.0",
      dht11Gpio: 4,
      coreFiles,
      dht11Files,
      extraPins: [{ componentId: "custom-rgb-led", pinName: "RGB_RED", gpio: 10 }],
    })).rejects.toThrow(/only compiles Matter core and DHT11/);
  });

  it("builds an independent photosensitive workspace on ADC GPIO 4", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-light-"));
    const generated = await generateNodeWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 7,
      softwareVersionString: "1.6.0",
      kind: "photosensitive",
      coreFiles,
      deviceFiles: [
        source("CMakeLists.txt", 'idf_component_register(SRCS "drivers/photosensitive_sensor.cpp" REQUIRES esp_adc esp_matter)\n'),
        source("drivers/photosensitive_sensor.cpp", "static const int PHOTOSENSITIVE_ADC_CHANNEL = ADC_CHANNEL_3;\nesp_err_t photosensitive_sensor_init(unsigned endpoint_id) { return endpoint_id ? 0 : 1; }\n"),
        source("drivers/photosensitive_sensor.h", "#pragma once\n"),
      ],
      pins: [{ componentId: "custom-photosensitive-light", pinName: "adc", gpio: 4 }],
      productId: 0x8001,
    });
    expect(generated.productId).toBe(0x8001);
    const app = await readFile(path.join(outDir, "main/app_main.cpp"), "utf8");
    expect(app.match(/app_main\s*\(/g)).toHaveLength(1);
    expect(app).toContain("iotedu_core_start");
    expect(app.indexOf("iotedu_light_prepare")).toBeLessThan(app.indexOf("iotedu_core_start"));
    expect(app.indexOf("iotedu_core_start")).toBeLessThan(app.indexOf("iotedu_light_start"));
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(defaults).toContain("CONFIG_DEVICE_PRODUCT_ID=0x8001");
    expect(defaults).toContain("CONFIG_IOTEDU_LIGHT_ADC_GPIO=4");
    expect(defaults).not.toContain("CONFIG_IOTEDU_DHT11_PIN");
    const host = await readFile(path.join(outDir, "main/light_matter.cpp"), "utf8");
    expect(host).toContain("light_sensor::create");
    expect(host).toContain("photosensitive_sensor_init");
    expect(host).toContain("illuminance_measurement");
  });

  it("keeps the ESP32-H2 RGB PWM settings in the driver source", async () => {
    const driver = await readFile(path.join(repositoryPaths(repoRoot).catalogueRoot, "components", "rgb_led", "rgb_led.cpp"), "utf8");
    expect(driver).toContain("LEDC_LOW_SPEED_MODE");
    expect(driver).toContain("LEDC_USE_XTAL_CLK");
    expect(driver).toContain("LEDC_TIMER_8_BIT");
    expect(driver).toContain("RGB_PWM_FREQ_HZ 5000");
    expect(driver).toContain("LEDC_CHANNEL_0");
    expect(driver).toContain("LEDC_CHANNEL_1");
    expect(driver).toContain("LEDC_CHANNEL_2");
    expect(driver.indexOf("ledc_timer_config")).toBeLessThan(driver.indexOf("ledc_channel_config"));
    expect(driver).toContain("record_ledc");
    expect(driver).toContain("GPIO_IS_VALID_OUTPUT_GPIO");
    expect(driver).not.toContain("LEDC_HIGH_SPEED_MODE");
  });

  it("builds an independent RGB workspace and keeps it off the DHT11 product id", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-rgb-"));
    await generateNodeWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 8,
      softwareVersionString: "1.7.0",
      kind: "rgb",
      coreFiles,
      deviceFiles: [
        source("CMakeLists.txt", 'idf_component_register(SRCS "rgb_led.cpp" REQUIRES esp_driver_ledc)\n'),
        source("rgb_led.cpp", "esp_err_t rgb_led_set_power(int on) { return on; }\nesp_err_t rgb_led_set_hsv(int hue, int saturation) { return hue + saturation; }\n"),
        source("rgb_led.h", "#pragma once\n"),
      ],
      pins: [
        { componentId: "custom-rgb-led", pinName: "red", gpio: 4 },
        { componentId: "custom-rgb-led", pinName: "green", gpio: 10 },
        { componentId: "custom-rgb-led", pinName: "blue", gpio: 5 },
      ],
      productId: 0x8002,
    });
    const app = await readFile(path.join(outDir, "main/app_main.cpp"), "utf8");
    expect(app.match(/app_main\s*\(/g)).toHaveLength(1);
    expect(app).toContain("iotedu_rgb_register");
    expect(app).not.toContain("iotedu_dht11_register");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(defaults).toContain("CONFIG_IOTEDU_RGB_RED_GPIO=4");
    expect(defaults).toContain("CONFIG_IOTEDU_RGB_GREEN_GPIO=10");
    expect(defaults).toContain("CONFIG_IOTEDU_RGB_BLUE_GPIO=5");
    expect(defaults).toContain("CONFIG_DEVICE_PRODUCT_ID=0x8002");
    const host = await readFile(path.join(outDir, "main/rgb_matter.cpp"), "utf8");
    expect(host).toContain("extended_color_light::create");
    expect(host).toContain("hue_saturation::add");
    expect(host.indexOf("hue_saturation::add")).toBeLessThan(host.indexOf("apply_colour(light_endpoint_id)"));
    expect(app).toContain("PrintOnboardingCodes");
    expect(app).toContain("Fabric count 0");
    expect(app).toContain("Existing Matter fabric count");
    expect(app.indexOf("iotedu_core_start")).toBeLessThan(app.indexOf("PrintOnboardingCodes"));
    expect(host).toContain("rgb_led_set_power");
    expect(host).toContain("rgb_led_set_hsv");
    expect(host).toContain("rgb_led_set_xy");
    expect(host).toContain("rgb_led_set_color_temperature");
    await expect(generateNodeWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 8,
      softwareVersionString: "1.7.0",
      kind: "rgb",
      coreFiles,
      deviceFiles: [
        source("CMakeLists.txt", 'idf_component_register(SRCS "rgb_led.cpp" REQUIRES esp_driver_ledc)\n'),
        source("rgb_led.cpp", "esp_err_t rgb_led_set_power(int on) { return on; }\nesp_err_t rgb_led_set_hsv(int hue, int saturation) { return hue + saturation; }\n"),
      ],
      pins: [
        { componentId: "custom-rgb-led", pinName: "red", gpio: 8 },
        { componentId: "custom-rgb-led", pinName: "green", gpio: 10 },
        { componentId: "custom-rgb-led", pinName: "blue", gpio: 5 },
      ],
      productId: 0x8002,
    })).rejects.toThrow(/GPIO8/);
  });
});

const lightFiles = [
  source("CMakeLists.txt", 'idf_component_register(SRCS "drivers/photosensitive_sensor.cpp" REQUIRES esp_adc esp_matter)\n'),
  source("drivers/photosensitive_sensor.cpp", "static const int PHOTOSENSITIVE_ADC_CHANNEL = ADC_CHANNEL_3;\nesp_err_t photosensitive_sensor_init(unsigned endpoint_id) { return endpoint_id ? 0 : 1; }\n"),
  source("drivers/photosensitive_sensor.h", "#pragma once\n"),
];

const rgbFiles = [
  source("CMakeLists.txt", 'idf_component_register(SRCS "rgb_led.cpp" REQUIRES esp_driver_ledc)\n'),
  source("rgb_led.cpp", "esp_err_t rgb_led_set_power(int on) { return on; }\nesp_err_t rgb_led_set_hsv(int hue, int saturation) { return hue + saturation; }\n"),
  source("rgb_led.h", "#pragma once\n"),
];

describe("retained identity composition", () => {
  it("compiles photosensitive revision 2 for the retained RGB product", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-retained-light-"));
    const generated = await generateRetainedWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 12,
      softwareVersionString: "1.11.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      coreFiles,
      devices: [{
        kind: "photosensitive",
        files: lightFiles,
        pins: [{ componentId: "custom-photosensitive-light", pinName: "adc", gpio: 4 }],
        reserveEndpointIds: [1],
      }],
    });
    expect(generated.productId).toBe(0x8002);
    const app = await readFile(path.join(outDir, "main/app_main.cpp"), "utf8");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    const cmake = await readFile(path.join(outDir, "main/CMakeLists.txt"), "utf8");
    expect(app.match(/app_main\s*\(/g)).toHaveLength(1);
    expect(app).toContain("iotedu_composition_reserve(node, 1)");
    expect(app.indexOf("iotedu_composition_reserve")).toBeLessThan(app.indexOf("iotedu_light_prepare"));
    expect(app.indexOf("iotedu_light_prepare")).toBeLessThan(app.indexOf("iotedu_core_start"));
    expect(app.indexOf("iotedu_core_start")).toBeLessThan(app.indexOf("iotedu_light_start"));
    expect(app).toContain("does not open a commissioning window or erase NVS");
    expect(app).not.toContain("PrintOnboardingCodes");
    expect(app).not.toContain("nvs_flash_erase");
    expect(app).not.toContain("factory_reset");
    expect(app).not.toContain("iotedu_rgb_register");
    expect(defaults).toContain("CONFIG_DEVICE_VENDOR_ID=0xFFF1");
    expect(defaults).toContain("CONFIG_DEVICE_PRODUCT_ID=0x8002");
    expect(defaults).toContain("CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=12");
    expect(defaults).toContain("CONFIG_APP_PROJECT_VER=\"1.11.0\"");
    expect(defaults).toContain("CONFIG_IOTEDU_LIGHT_ADC_GPIO=4");
    expect(defaults).not.toContain("CONFIG_IOTEDU_RGB_RED_GPIO");
    expect(cmake).toContain("iotedu_photosensitive");
    expect(cmake).not.toContain("iotedu_rgb_led");
    const partitions = await readFile(path.join(outDir, "partitions.csv"), "utf8");
    expect(partitions).toContain("nvs,");
    expect(partitions).toContain("ota_0");
  });

  it("builds RGB and photosensitive together after red moves off GPIO 4", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-retained-both-"));
    await generateRetainedWorkspace({
      repoRoot,
      outDir,
      softwareVersion: 13,
      softwareVersionString: "1.12.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      coreFiles,
      devices: [
        {
          kind: "rgb",
          files: rgbFiles,
          pins: [
            { componentId: "custom-rgb-led", pinName: "red", gpio: 6 },
            { componentId: "custom-rgb-led", pinName: "green", gpio: 10 },
            { componentId: "custom-rgb-led", pinName: "blue", gpio: 5 },
          ],
          reserveEndpointIds: [],
        },
        {
          kind: "photosensitive",
          files: lightFiles,
          pins: [{ componentId: "custom-photosensitive-light", pinName: "adc", gpio: 4 }],
          reserveEndpointIds: [],
        },
      ],
    });
    const app = await readFile(path.join(outDir, "main/app_main.cpp"), "utf8");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(app.indexOf("iotedu_rgb_register")).toBeLessThan(app.indexOf("iotedu_light_prepare"));
    expect(app).not.toContain("iotedu_composition_reserve");
    expect(defaults).toContain("CONFIG_DEVICE_PRODUCT_ID=0x8002");
    expect(defaults).toContain("CONFIG_IOTEDU_RGB_RED_GPIO=6");
    expect(defaults).toContain("CONFIG_IOTEDU_RGB_GREEN_GPIO=10");
    expect(defaults).toContain("CONFIG_IOTEDU_RGB_BLUE_GPIO=5");
    expect(defaults).toContain("CONFIG_IOTEDU_LIGHT_ADC_GPIO=4");
  });

  it("rejects a GPIO 4 clash and a reserved RGB pin", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-retained-clash-"));
    const shared = {
      repoRoot,
      outDir,
      softwareVersion: 12,
      softwareVersionString: "1.11.0",
      vendorId: 0xfff1,
      productId: 0x8002,
      coreFiles,
    };
    await expect(generateRetainedWorkspace({
      ...shared,
      devices: [
        {
          kind: "rgb",
          files: rgbFiles,
          pins: [
            { componentId: "custom-rgb-led", pinName: "red", gpio: 4 },
            { componentId: "custom-rgb-led", pinName: "green", gpio: 10 },
            { componentId: "custom-rgb-led", pinName: "blue", gpio: 5 },
          ],
          reserveEndpointIds: [],
        },
        {
          kind: "photosensitive",
          files: lightFiles,
          pins: [{ componentId: "custom-photosensitive-light", pinName: "adc", gpio: 4 }],
          reserveEndpointIds: [],
        },
      ],
    })).rejects.toThrow(/GPIO4/);
    await expect(generateRetainedWorkspace({
      ...shared,
      devices: [{
        kind: "rgb",
        files: rgbFiles,
        pins: [
          { componentId: "custom-rgb-led", pinName: "red", gpio: 8 },
          { componentId: "custom-rgb-led", pinName: "green", gpio: 10 },
          { componentId: "custom-rgb-led", pinName: "blue", gpio: 9 },
        ],
        reserveEndpointIds: [],
      }],
    })).rejects.toThrow(/GPIO8|GPIO9/);
  });
});
