import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryPaths } from "@iotedu/contracts/paths";
import {
  applyCmakeProjectVersion,
  detectGpioConflicts,
  loadReferenceLayout,
  renderVersionSdkconfig,
  type BoardProfile,
} from "./index.js";

export interface CatalogueSourceFile {
  relativePath: string;
  content: string;
  sha256: string;
}

export interface CataloguePin {
  componentId: string;
  pinName: string;
  gpio: number;
}

export interface CatalogueWorkspaceOptions {
  repoRoot: string;
  outDir: string;
  softwareVersion: number;
  softwareVersionString: string;
  dht11Gpio: number;
  coreFiles: CatalogueSourceFile[];
  dht11Files: CatalogueSourceFile[];
  extraPins?: CataloguePin[];
}

const APP_MAIN = `#include <esp_log.h>

#include <iotedu_core.h>

#include "dht11_matter.h"
#include <common_macros.h>

static const char *TAG = "app_main";

extern "C" void app_main(void)
{
    esp_matter::node_t *node = nullptr;
    esp_err_t err = iotedu_core_prepare(&node);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to prepare the Matter core, err:%d", err));

    err = iotedu_dht11_register(node);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to register DHT11, err:%d", err));

    err = iotedu_core_start();
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to start Matter, err:%d", err));
}
`;

const hostDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "hosts");

const LIGHT_APP_MAIN = `#include <esp_log.h>

#include <iotedu_core.h>

#include "light_matter.h"
#include <common_macros.h>

static const char *TAG = "app_main";

extern "C" void app_main(void)
{
    esp_matter::node_t *node = nullptr;
    esp_err_t err = iotedu_core_prepare(&node);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to prepare the Matter core, err:%d", err));

    uint16_t endpoint_id = 0;
    err = iotedu_light_prepare(node, &endpoint_id);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to create the light sensor endpoint, err:%d", err));

    err = iotedu_core_start();
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to start Matter, err:%d", err));

    err = iotedu_light_start(endpoint_id);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to start the photosensitive sensor, err:%d", err));
}
`;

const RGB_APP_MAIN = `#include <esp_err.h>
#include <esp_log.h>

#include <app/server/Server.h>
#include <iotedu_core.h>
#include <setup_payload/OnboardingCodesUtil.h>

#include "rgb_matter.h"
#include <common_macros.h>

static const char *TAG = "app_main";

extern "C" void app_main(void)
{
    esp_matter::node_t *node = nullptr;
    esp_err_t err = iotedu_core_prepare(&node);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to prepare the Matter core, err:%d", err));

    err = iotedu_rgb_register(node);
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to register the RGB light, err:%s (%d)", esp_err_to_name(err), err));

    err = iotedu_core_start();
    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to start Matter, err:%d", err));

    const uint8_t fabric_count = chip::Server::GetInstance().GetFabricTable().FabricCount();
    if (fabric_count == 0) {
        ESP_LOGI(TAG, "Matter server is up. Fabric count 0.");
        PrintOnboardingCodes(chip::RendezvousInformationFlags(chip::RendezvousInformationFlag::kBLE));
    } else {
        ESP_LOGI(TAG, "Existing Matter fabric count %u. The first-time onboarding code is not printed.", fabric_count);
    }
}
`;

export interface NodeWorkspaceOptions {
  repoRoot: string;
  outDir: string;
  softwareVersion: number;
  softwareVersionString: string;
  kind: "photosensitive" | "rgb";
  coreFiles: CatalogueSourceFile[];
  deviceFiles: CatalogueSourceFile[];
  pins: CataloguePin[];
  productId: number;
}

export async function generateNodeWorkspace(options: NodeWorkspaceOptions): Promise<{
  outDir: string;
  partitionLayoutId: string;
  softwareVersion: number;
  softwareVersionString: string;
  productId: number;
  pins: CataloguePin[];
}> {
  const repoRoot = path.resolve(options.repoRoot);
  const outDir = path.resolve(options.outDir);
  const referenceDir = repositoryPaths(repoRoot).firmwareTemplateRoot;
  if (outDir === referenceDir || outDir.startsWith(`${referenceDir}${path.sep}`)) {
    throw new Error("The generated workspace must not be written into firmware/template");
  }
  if (options.productId === 0x8000) {
    throw new Error("This Node Type needs its own product id. Product 0x8000 belongs to the DHT11 firmware.");
  }
  const profile = JSON.parse(await readFile(path.join(repositoryPaths(repoRoot).boardProfilesRoot, "esp32h2.json"), "utf8")) as BoardProfile;
  const issues = detectGpioConflicts(profile, options.pins);
  if (issues.some((issue) => issue.level === "error")) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
  const coreCmake = options.coreFiles.find((file) => file.relativePath === "CMakeLists.txt")?.content ?? "";
  if (!coreCmake.includes("esp_matter") || !options.coreFiles.some((file) => file.relativePath === "iotedu_core.cpp")) {
    throw new Error("Matter core revision is missing its ESP-Matter component build file");
  }
  const deviceCmake = options.deviceFiles.find((file) => file.relativePath === "CMakeLists.txt")?.content ?? "";
  const deviceSource = options.deviceFiles.map((file) => file.content).join("\n");
  if (options.kind === "photosensitive") {
    if (!deviceCmake.includes("esp_adc") || !deviceSource.includes("ADC_CHANNEL_3") || !deviceSource.includes("photosensitive_sensor_init")) {
      throw new Error("Photosensitive revision 2 does not contain the ADC channel 3 driver");
    }
    if (options.pins.length !== 1 || options.pins[0]?.gpio !== 4) {
      throw new Error("Photosensitive revision 2 reads ADC channel 3, which is GPIO 4 on ESP32-H2");
    }
  } else {
    if (!deviceCmake.includes("esp_driver_ledc") || !deviceSource.includes("rgb_led_set_hsv") || !deviceSource.includes("rgb_led_set_power")) {
      throw new Error("RGB revision 2 does not contain the PWM colour driver");
    }
    const required = new Map([["red", 4], ["green", 10], ["blue", 5]]);
    if (options.pins.length !== 3 || options.pins.some((pin) => required.get(pin.pinName) !== pin.gpio)) {
      throw new Error("RGB revision 2 uses red GPIO 4, green GPIO 10 and blue GPIO 5");
    }
  }

  const referenceCmake = await readFile(path.join(referenceDir, "CMakeLists.txt"), "utf8");
  const marker = `"\${ESP_MATTER_PATH}/components"`;
  if (!referenceCmake.includes(marker)) {
    throw new Error("Reference CMakeLists.txt no longer has the expected component list");
  }
  const componentRoot = path.join(outDir, "components");
  const directory = options.kind === "photosensitive" ? "iotedu_photosensitive" : "iotedu_rgb_led";
  const generatedCmake = applyCmakeProjectVersion(
    referenceCmake.replace(marker, `${marker}\n    "${componentRoot}"`),
    options.softwareVersion,
    options.softwareVersionString,
  );
  const productId = `0x${options.productId.toString(16).toUpperCase()}`;
  const pinConfig = options.kind === "photosensitive"
    ? "CONFIG_IOTEDU_LIGHT_ADC_GPIO=4\n"
    : "CONFIG_IOTEDU_RGB_RED_GPIO=4\nCONFIG_IOTEDU_RGB_GREEN_GPIO=10\nCONFIG_IOTEDU_RGB_BLUE_GPIO=5\n";

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "main"), { recursive: true });
  await writeComponent(componentRoot, "iotedu_core", options.coreFiles);
  await writeComponent(componentRoot, directory, options.deviceFiles);
  await writeFile(path.join(outDir, "CMakeLists.txt"), generatedCmake);
  await writeFile(path.join(outDir, "partitions.csv"), await readFile(path.join(referenceDir, "partitions.csv")));
  await writeFile(path.join(outDir, "sdkconfig.defaults.esp32h2"), await readFile(path.join(referenceDir, "sdkconfig.defaults.esp32h2")));
  await writeFile(path.join(outDir, "dependencies.lock"), await readFile(path.join(referenceDir, "dependencies.lock")));
  const defaults = await readFile(path.join(referenceDir, "sdkconfig.defaults"), "utf8");
  await writeFile(
    path.join(outDir, "sdkconfig.defaults"),
    `${defaults.trimEnd()}\n\nCONFIG_ENABLE_MATTER_OVER_THREAD=y\n${renderVersionSdkconfig(options.softwareVersion, options.softwareVersionString)}CONFIG_DEVICE_VENDOR_ID=0xFFF1\nCONFIG_DEVICE_PRODUCT_ID=${productId}\n${pinConfig}`,
  );
  if (options.kind === "photosensitive") {
    await writeFile(path.join(outDir, "main/CMakeLists.txt"), `idf_component_register(SRCS "app_main.cpp" "light_matter.cpp"
                       INCLUDE_DIRS "."
                       PRIV_INCLUDE_DIRS "." "$ENV{ESP_MATTER_PATH}/examples/common/utils"
                       PRIV_REQUIRES iotedu_core iotedu_photosensitive esp_matter)\n`);
    await writeFile(path.join(outDir, "main/Kconfig.projbuild"), `menu "IoT.Edu Photosensitive Sensor"
    config IOTEDU_LIGHT_ADC_GPIO
        int "ADC GPIO recorded for this binary"
        range 4 4
        default 4
        help
            ADC channel 3 is GPIO 4 on ESP32-H2. The driver selects the channel in its source.
endmenu
`);
    await writeFile(path.join(outDir, "main/app_main.cpp"), LIGHT_APP_MAIN);
    await writeFile(path.join(outDir, "main/light_matter.cpp"), await readFile(path.join(hostDir, "light_matter.cpp")));
    await writeFile(path.join(outDir, "main/light_matter.h"), await readFile(path.join(hostDir, "light_matter.h")));
  } else {
    await writeFile(path.join(outDir, "main/CMakeLists.txt"), `idf_component_register(SRCS "app_main.cpp" "rgb_matter.cpp"
                       INCLUDE_DIRS "."
                       PRIV_INCLUDE_DIRS "." "$ENV{ESP_MATTER_PATH}/examples/common/utils"
                       PRIV_REQUIRES iotedu_core iotedu_rgb_led esp_matter)\n`);
    await writeFile(path.join(outDir, "main/Kconfig.projbuild"), `menu "IoT.Edu RGB LED"
    config IOTEDU_RGB_RED_GPIO
        int "Red PWM GPIO"
        range 0 27
        default 4
    config IOTEDU_RGB_GREEN_GPIO
        int "Green PWM GPIO"
        range 0 27
        default 10
    config IOTEDU_RGB_BLUE_GPIO
        int "Blue PWM GPIO"
        range 0 27
        default 5
endmenu
`);
    await writeFile(path.join(outDir, "main/app_main.cpp"), RGB_APP_MAIN);
    await writeFile(path.join(outDir, "main/rgb_matter.cpp"), await readFile(path.join(hostDir, "rgb_matter.cpp")));
    await writeFile(path.join(outDir, "main/rgb_matter.h"), await readFile(path.join(hostDir, "rgb_matter.h")));
  }
  await writeFile(path.join(outDir, "main/idf_component.yml"), await readFile(path.join(referenceDir, "main/idf_component.yml")));
  const layout = await loadReferenceLayout(repoRoot, profile);
  return {
    outDir,
    partitionLayoutId: layout.layoutId,
    softwareVersion: options.softwareVersion,
    softwareVersionString: options.softwareVersionString,
    productId: options.productId,
    pins: options.pins,
  };
}


export function catalogueSourceFingerprint(files: { role: string; relativePath: string; sha256: string }[]): string {
  const lines = files.map((file) => `${file.role}:${file.relativePath}:${file.sha256}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function generateCatalogueWorkspace(options: CatalogueWorkspaceOptions): Promise<{
  outDir: string;
  partitionLayoutId: string;
  dht11Gpio: number;
  softwareVersion: number;
  softwareVersionString: string;
}> {
  const repoRoot = path.resolve(options.repoRoot);
  const outDir = path.resolve(options.outDir);
  const referenceDir = repositoryPaths(repoRoot).firmwareTemplateRoot;
  if (outDir === referenceDir || outDir.startsWith(`${referenceDir}${path.sep}`)) {
    throw new Error("The generated workspace must not be written into firmware/template");
  }
  const profile = JSON.parse(await readFile(path.join(repositoryPaths(repoRoot).boardProfilesRoot, "esp32h2.json"), "utf8")) as BoardProfile;
  const pins = [
    { componentId: "custom-dht11", pinName: "DHT11_DATA", gpio: options.dht11Gpio },
    ...(options.extraPins ?? []),
  ];
  const issues = detectGpioConflicts(profile, pins);
  if (issues.some((issue) => issue.level === "error")) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
  if ((options.extraPins ?? []).length > 0) {
    throw new Error("This recipe only compiles Matter core and DHT11. Additional components stay out of the image until their Matter integration is compiled.");
  }

  const coreCmake = options.coreFiles.find((file) => file.relativePath === "CMakeLists.txt")?.content ?? "";
  const dhtCmake = options.dht11Files.find((file) => file.relativePath === "CMakeLists.txt")?.content ?? "";
  if (!coreCmake.includes("esp_matter") || !options.coreFiles.some((file) => file.relativePath === "iotedu_core.cpp")) {
    throw new Error("Matter core revision is missing its ESP-Matter component build file");
  }
  if (!dhtCmake.includes("esp_driver_gpio") || !options.dht11Files.some((file) => file.relativePath === "dht11.c")) {
    throw new Error("DHT11 revision is missing its GPIO driver build file");
  }

  const referenceCmake = await readFile(path.join(referenceDir, "CMakeLists.txt"), "utf8");
  const marker = `"\${ESP_MATTER_PATH}/components"`;
  if (!referenceCmake.includes(marker)) {
    throw new Error("Reference CMakeLists.txt no longer has the expected component list");
  }
  const componentRoot = path.join(outDir, "components");
  const generatedCmake = applyCmakeProjectVersion(
    referenceCmake.replace(marker, `${marker}\n    "${componentRoot}"`),
    options.softwareVersion,
    options.softwareVersionString,
  );

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "main"), { recursive: true });
  await writeComponent(componentRoot, "iotedu_core", options.coreFiles);
  await writeComponent(componentRoot, "iotedu_dht11", options.dht11Files);
  await writeFile(path.join(outDir, "CMakeLists.txt"), generatedCmake);
  await writeFile(path.join(outDir, "partitions.csv"), await readFile(path.join(referenceDir, "partitions.csv")));
  await writeFile(path.join(outDir, "sdkconfig.defaults.esp32h2"), await readFile(path.join(referenceDir, "sdkconfig.defaults.esp32h2")));
  await writeFile(path.join(outDir, "dependencies.lock"), await readFile(path.join(referenceDir, "dependencies.lock")));
  const defaults = await readFile(path.join(referenceDir, "sdkconfig.defaults"), "utf8");
  await writeFile(
    path.join(outDir, "sdkconfig.defaults"),
    `${defaults.trimEnd()}\n\nCONFIG_ENABLE_MATTER_OVER_THREAD=y\n${renderVersionSdkconfig(options.softwareVersion, options.softwareVersionString)}CONFIG_IOTEDU_DHT11_PIN=${options.dht11Gpio}\n`,
  );
  await writeFile(
    path.join(outDir, "main/CMakeLists.txt"),
    `idf_component_register(SRCS "app_main.cpp" "dht11_matter.cpp"
                       INCLUDE_DIRS "."
                       PRIV_INCLUDE_DIRS "." "$ENV{ESP_MATTER_PATH}/examples/common/utils"
                       PRIV_REQUIRES iotedu_core iotedu_dht11 esp_matter)\n`,
  );
  await writeFile(
    path.join(outDir, "main/Kconfig.projbuild"),
    `menu "IoT.Edu DHT11"
    config IOTEDU_DHT11_PIN
        int "DHT11 data GPIO"
        range 0 27
        default 4
        help
            Data GPIO passed to dht11_init_pin by the Matter host.
endmenu
`,
  );
  await writeFile(path.join(outDir, "main/app_main.cpp"), APP_MAIN);
  await writeFile(path.join(outDir, "main/dht11_matter.cpp"), await readFile(path.join(hostDir, "dht11_matter.cpp")));
  await writeFile(path.join(outDir, "main/dht11_matter.h"), await readFile(path.join(hostDir, "dht11_matter.h")));
  await writeFile(path.join(outDir, "main/iotedu_dht11_ranges.h"), await readFile(path.join(hostDir, "iotedu_dht11_ranges.h")));
  await writeFile(path.join(outDir, "main/idf_component.yml"), await readFile(path.join(referenceDir, "main/idf_component.yml")));

  const layout = await loadReferenceLayout(repoRoot, profile);
  return {
    outDir,
    partitionLayoutId: layout.layoutId,
    dht11Gpio: options.dht11Gpio,
    softwareVersion: options.softwareVersion,
    softwareVersionString: options.softwareVersionString,
  };
}

export interface RetainedDeviceInput {
  kind: "rgb" | "photosensitive" | "dht11";
  files: CatalogueSourceFile[];
  pins: CataloguePin[];
  reserveEndpointIds: number[];
}

export interface RetainedWorkspaceOptions {
  repoRoot: string;
  outDir: string;
  softwareVersion: number;
  softwareVersionString: string;
  vendorId: number;
  productId: number;
  coreFiles: CatalogueSourceFile[];
  devices: RetainedDeviceInput[];
}

export async function generateRetainedWorkspace(options: RetainedWorkspaceOptions): Promise<{
  outDir: string;
  partitionLayoutId: string;
  softwareVersion: number;
  softwareVersionString: string;
  vendorId: number;
  productId: number;
  pins: CataloguePin[];
}> {
  const repoRoot = path.resolve(options.repoRoot);
  const outDir = path.resolve(options.outDir);
  const referenceDir = repositoryPaths(repoRoot).firmwareTemplateRoot;
  if (outDir === referenceDir || outDir.startsWith(`${referenceDir}${path.sep}`)) {
    throw new Error("The generated workspace must not be written into firmware/template");
  }
  if (options.vendorId !== 0xfff1) {
    throw new Error("A retained composition uses vendor 0xFFF1.");
  }
  if (!Number.isInteger(options.productId) || options.productId < 1 || options.productId > 0xffff) {
    throw new Error("The retained product id is not a Matter product id.");
  }
  if (options.devices.length === 0) {
    throw new Error("A retained composition needs at least one sensor or actuator.");
  }
  const profile = JSON.parse(await readFile(path.join(repositoryPaths(repoRoot).boardProfilesRoot, "esp32h2.json"), "utf8")) as BoardProfile;
  const pins = options.devices.flatMap((device) => device.pins);
  const issues = detectGpioConflicts(profile, pins);
  if (issues.some((issue) => issue.level === "error")) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
  const coreCmake = options.coreFiles.find((file) => file.relativePath === "CMakeLists.txt")?.content ?? "";
  if (!coreCmake.includes("esp_matter") || !options.coreFiles.some((file) => file.relativePath === "iotedu_core.cpp")) {
    throw new Error("Matter core revision is missing its ESP-Matter component build file");
  }
  for (const device of options.devices) validateRetainedDevice(device);

  const referenceCmake = await readFile(path.join(referenceDir, "CMakeLists.txt"), "utf8");
  const marker = `"\${ESP_MATTER_PATH}/components"`;
  if (!referenceCmake.includes(marker)) {
    throw new Error("Reference CMakeLists.txt no longer has the expected component list");
  }
  const componentRoot = path.join(outDir, "components");
  const generatedCmake = applyCmakeProjectVersion(
    referenceCmake.replace(marker, `${marker}\n    "${componentRoot}"`),
    options.softwareVersion,
    options.softwareVersionString,
  );
  const productId = `0x${options.productId.toString(16).toUpperCase()}`;
  const pinConfig = retainedPinConfig(options.devices);
  const directories = [...new Set(options.devices.map(retainedDirectory))];
  const hostSources = ["app_main.cpp", "composition_matter.cpp", ...options.devices.map(retainedHostSource)];
  const requires = ["iotedu_core", ...directories, "esp_matter"].join(" ");

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "main"), { recursive: true });
  await writeComponent(componentRoot, "iotedu_core", options.coreFiles);
  for (const device of options.devices) {
    await writeComponent(componentRoot, retainedDirectory(device), device.files);
  }
  await writeFile(path.join(outDir, "CMakeLists.txt"), generatedCmake);
  await writeFile(path.join(outDir, "partitions.csv"), await readFile(path.join(referenceDir, "partitions.csv")));
  await writeFile(path.join(outDir, "sdkconfig.defaults.esp32h2"), await readFile(path.join(referenceDir, "sdkconfig.defaults.esp32h2")));
  await writeFile(path.join(outDir, "dependencies.lock"), await readFile(path.join(referenceDir, "dependencies.lock")));
  const defaults = await readFile(path.join(referenceDir, "sdkconfig.defaults"), "utf8");
  await writeFile(
    path.join(outDir, "sdkconfig.defaults"),
    `${defaults.trimEnd()}\n\nCONFIG_ENABLE_MATTER_OVER_THREAD=y\n${renderVersionSdkconfig(options.softwareVersion, options.softwareVersionString)}CONFIG_DEVICE_VENDOR_ID=0xFFF1\nCONFIG_DEVICE_PRODUCT_ID=${productId}\n${pinConfig}`,
  );
  await writeFile(path.join(outDir, "main/CMakeLists.txt"), `idf_component_register(SRCS ${hostSources.map((name) => `"${name}"`).join(" ")}
                       INCLUDE_DIRS "."
                       PRIV_INCLUDE_DIRS "." "$ENV{ESP_MATTER_PATH}/examples/common/utils"
                       PRIV_REQUIRES ${requires})\n`);
  await writeFile(path.join(outDir, "main/Kconfig.projbuild"), retainedKconfig(options.devices));
  await writeFile(path.join(outDir, "main/app_main.cpp"), retainedAppMain(options.devices));
  await writeFile(path.join(outDir, "main/composition_matter.cpp"), await readFile(path.join(hostDir, "composition_matter.cpp")));
  await writeFile(path.join(outDir, "main/composition_matter.h"), await readFile(path.join(hostDir, "composition_matter.h")));
  if (options.devices.some((device) => device.kind === "photosensitive")) {
    await writeFile(path.join(outDir, "main/light_matter.cpp"), await readFile(path.join(hostDir, "light_matter.cpp")));
    await writeFile(path.join(outDir, "main/light_matter.h"), await readFile(path.join(hostDir, "light_matter.h")));
  }
  if (options.devices.some((device) => device.kind === "rgb")) {
    await writeFile(path.join(outDir, "main/rgb_matter.cpp"), await readFile(path.join(hostDir, "rgb_matter.cpp")));
    await writeFile(path.join(outDir, "main/rgb_matter.h"), await readFile(path.join(hostDir, "rgb_matter.h")));
  }
  if (options.devices.some((device) => device.kind === "dht11")) {
    await writeFile(path.join(outDir, "main/dht11_matter.cpp"), await readFile(path.join(hostDir, "dht11_matter.cpp")));
    await writeFile(path.join(outDir, "main/dht11_matter.h"), await readFile(path.join(hostDir, "dht11_matter.h")));
    await writeFile(path.join(outDir, "main/iotedu_dht11_ranges.h"), await readFile(path.join(hostDir, "iotedu_dht11_ranges.h")));
  }
  await writeFile(path.join(outDir, "main/idf_component.yml"), await readFile(path.join(referenceDir, "main/idf_component.yml")));
  const layout = await loadReferenceLayout(repoRoot, profile);
  return {
    outDir,
    partitionLayoutId: layout.layoutId,
    softwareVersion: options.softwareVersion,
    softwareVersionString: options.softwareVersionString,
    vendorId: options.vendorId,
    productId: options.productId,
    pins,
  };
}

function validateRetainedDevice(device: RetainedDeviceInput): void {
  const cmake = device.files.find((file) => file.relativePath === "CMakeLists.txt")?.content ?? "";
  const source = device.files.map((file) => file.content).join("\n");
  if (device.kind === "photosensitive") {
    if (!cmake.includes("esp_adc") || !source.includes("ADC_CHANNEL_3") || !source.includes("photosensitive_sensor_init")) {
      throw new Error("Photosensitive revision 2 does not contain the ADC channel 3 driver");
    }
    if (device.pins.length !== 1 || device.pins[0]?.gpio !== 4) {
      throw new Error("Photosensitive revision 2 reads ADC channel 3, which is GPIO 4 on ESP32-H2");
    }
    return;
  }
  if (device.kind === "rgb") {
    if (!cmake.includes("esp_driver_ledc") || !source.includes("rgb_led_set_hsv") || !source.includes("rgb_led_set_power")) {
      throw new Error("The RGB driver does not contain the PWM colour implementation");
    }
    const names = new Set(device.pins.map((pin) => pin.pinName));
    if (device.pins.length !== 3 || !names.has("red") || !names.has("green") || !names.has("blue")) {
      throw new Error("RGB revision 3 needs red, green and blue outputs.");
    }
    return;
  }
  if (!cmake.includes("esp_driver_gpio") || !source.includes("dht11_init_pin")) {
    throw new Error("DHT11 revision 2 does not contain the GPIO data driver");
  }
  if (device.pins.length !== 1) {
    throw new Error("DHT11 revision 2 uses one data GPIO.");
  }
}

function retainedDirectory(device: RetainedDeviceInput): string {
  if (device.kind === "photosensitive") return "iotedu_photosensitive";
  if (device.kind === "rgb") return "iotedu_rgb_led";
  return "iotedu_dht11";
}

function retainedHostSource(device: RetainedDeviceInput): string {
  if (device.kind === "photosensitive") return "light_matter.cpp";
  if (device.kind === "rgb") return "rgb_matter.cpp";
  return "dht11_matter.cpp";
}

function retainedPinConfig(devices: RetainedDeviceInput[]): string {
  const lines: string[] = [];
  for (const device of devices) {
    const gpio = (name: string) => device.pins.find((pin) => pin.pinName === name)?.gpio;
    if (device.kind === "photosensitive") lines.push("CONFIG_IOTEDU_LIGHT_ADC_GPIO=4");
    if (device.kind === "rgb") {
      lines.push(`CONFIG_IOTEDU_RGB_RED_GPIO=${gpio("red")}`);
      lines.push(`CONFIG_IOTEDU_RGB_GREEN_GPIO=${gpio("green")}`);
      lines.push(`CONFIG_IOTEDU_RGB_BLUE_GPIO=${gpio("blue")}`);
    }
    if (device.kind === "dht11") lines.push(`CONFIG_IOTEDU_DHT11_PIN=${device.pins[0]?.gpio}`);
  }
  return `${lines.join("\n")}\n`;
}

function retainedKconfig(devices: RetainedDeviceInput[]): string {
  const blocks: string[] = [];
  if (devices.some((device) => device.kind === "photosensitive")) {
    blocks.push(`menu "IoT.Edu Photosensitive Sensor"
    config IOTEDU_LIGHT_ADC_GPIO
        int "ADC GPIO recorded for this binary"
        range 4 4
        default 4
        help
            ADC channel 3 is GPIO 4 on ESP32-H2. The driver selects the channel in its source.
endmenu`);
  }
  if (devices.some((device) => device.kind === "rgb")) {
    const device = devices.find((item) => item.kind === "rgb");
    const gpio = (name: string, fallback: number) => device?.pins.find((pin) => pin.pinName === name)?.gpio ?? fallback;
    blocks.push(`menu "IoT.Edu RGB LED"
    config IOTEDU_RGB_RED_GPIO
        int "Red PWM GPIO"
        range 0 27
        default ${gpio("red", 4)}
    config IOTEDU_RGB_GREEN_GPIO
        int "Green PWM GPIO"
        range 0 27
        default ${gpio("green", 10)}
    config IOTEDU_RGB_BLUE_GPIO
        int "Blue PWM GPIO"
        range 0 27
        default ${gpio("blue", 5)}
endmenu`);
  }
  if (devices.some((device) => device.kind === "dht11")) {
    const gpio = devices.find((device) => device.kind === "dht11")?.pins[0]?.gpio ?? 4;
    blocks.push(`menu "IoT.Edu DHT11"
    config IOTEDU_DHT11_PIN
        int "DHT11 data GPIO"
        range 0 27
        default ${gpio}
        help
            Data GPIO passed to dht11_init_pin by the Matter host.
endmenu`);
  }
  return `${blocks.join("\n")}\n`;
}

function retainedAppMain(devices: RetainedDeviceInput[]): string {
  const includes = [
    "#include <esp_err.h>",
    "#include <esp_log.h>",
    "",
    "#include <app/server/Server.h>",
    "#include <iotedu_core.h>",
    "",
    '#include "composition_matter.h"',
  ];
  if (devices.some((device) => device.kind === "rgb")) includes.push('#include "rgb_matter.h"');
  if (devices.some((device) => device.kind === "photosensitive")) includes.push('#include "light_matter.h"');
  if (devices.some((device) => device.kind === "dht11")) includes.push('#include "dht11_matter.h"');
  includes.push("#include <common_macros.h>", "", 'static const char *TAG = "app_main";', "");
  const body: string[] = [
    "extern \"C\" void app_main(void)",
    "{",
    "    esp_matter::node_t *node = nullptr;",
    "    esp_err_t err = iotedu_core_prepare(&node);",
    "    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, \"Failed to prepare the Matter core, err:%d\", err));",
    "",
  ];
  for (const device of devices) {
    for (const endpointId of device.reserveEndpointIds) {
      body.push(`    err = iotedu_composition_reserve(node, ${endpointId});`);
      body.push(`    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, "Failed to reserve retired endpoint ${endpointId}, err:%d", err));`);
    }
    if (device.kind === "rgb") {
      body.push("    err = iotedu_rgb_register(node);");
      body.push("    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, \"Failed to register the RGB light, err:%s (%d)\", esp_err_to_name(err), err));");
    } else if (device.kind === "photosensitive") {
      body.push("    uint16_t light_endpoint_id = 0;");
      body.push("    err = iotedu_light_prepare(node, &light_endpoint_id);");
      body.push("    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, \"Failed to create the light sensor endpoint, err:%d\", err));");
      body.push("    if (light_endpoint_id == 1) {");
      body.push("        ESP_LOGE(TAG, \"Light sensor was assigned retired endpoint 1. The node still boots. Controllers may confuse it with the previous RGB light.\");");
      body.push("    } else {");
      body.push("        ESP_LOGI(TAG, \"Light sensor endpoint %u.\", light_endpoint_id);");
      body.push("    }");
    } else {
      body.push("    err = iotedu_dht11_register(node);");
      body.push("    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, \"Failed to register DHT11, err:%d\", err));");
    }
    body.push("");
  }
  body.push(
    "    err = iotedu_core_start();",
    "    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, \"Failed to start Matter, err:%d\", err));",
    "",
    "    const uint8_t fabric_count = chip::Server::GetInstance().GetFabricTable().FabricCount();",
    "    ESP_LOGI(TAG, \"Existing Matter fabric count %u. This image does not open a commissioning window or erase NVS.\", fabric_count);",
  );
  if (devices.some((device) => device.kind === "photosensitive")) {
    body.push(
      "",
      "    err = iotedu_light_start(light_endpoint_id);",
      "    ABORT_APP_ON_FAILURE(err == ESP_OK, ESP_LOGE(TAG, \"Failed to start the photosensitive sensor, err:%d\", err));",
    );
  }
  body.push("}", "");
  return `${includes.join("\n")}\n${body.join("\n")}\n`;
}

async function writeComponent(root: string, directory: string, files: CatalogueSourceFile[]): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(directory)) throw new Error("Component directory is not a safe name");
  for (const file of files) {
    const relative = file.relativePath.replaceAll("\\", "/");
    if (relative.startsWith("/") || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Unsafe source path ${file.relativePath}`);
    }
    const hash = createHash("sha256").update(file.content, "utf8").digest("hex");
    if (hash !== file.sha256) throw new Error(`Source hash does not match ${relative}`);
    if (/\bapp_main\s*\(/.test(file.content)) {
      throw new Error(`${relative} defines app_main. The composer supplies the only entry point.`);
    }
    const destination = path.join(root, directory, relative);
    if (!destination.startsWith(path.join(root, directory) + path.sep) && destination !== path.join(root, directory)) {
      throw new Error(`Unsafe source path ${file.relativePath}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
}
