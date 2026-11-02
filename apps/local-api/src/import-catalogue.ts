import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeCatalogue, importComponents, type ImportComponent } from "./catalogue-store.js";
import { loadEnvFile } from "./load-env.js";

async function text(file: string): Promise<string> {
  return readFile(file, "utf8");
}

async function supplied(): Promise<ImportComponent[]> {
  const root = "/tmp/zip-src";
  const sharedCmake = await text(path.join(root, "cmp/photosensitive-root.cmake"));
  const core: ImportComponent = {
    id: "matter-core-iotedu",
    name: "IoT.Edu Matter-over-Thread core",
    description: "Shared application core. The working implementation remains node-data/firmware/components/iotedu_core in the repository. The three device projects are not stored as separate copies of this core.",
    type: "matter_core",
    validationState: "draft",
    archiveName: "repository node-data/firmware/components/iotedu_core",
    files: [{ path: "project/CMakeLists.txt", role: "config", content: sharedCmake }],
    gpio: [],
    matter: {
      endpoints: [],
      clusters: ["Basic Information"],
      attributes: [],
      ownedBy: "host",
      interfaceName: null,
      notes: "The photosensitive and DHT11 projects share one application CMakeLists.txt. Their app_main.cpp files differ, so neither is used as the core. OpenThread headers also differ.",
    },
    dependsOn: [],
    validation: {
      errors: 0,
      warnings: 1,
      issues: [{ level: "warning", message: "The repository core was referenced, not copied, and was not recompiled during this import." }],
      nativeCompile: "not_run",
      integrationCompile: "not_run",
    },
  };
  const photo: ImportComponent = {
    id: "custom-photosensitive-light",
    name: "Photosensitive Light Sensor",
    description: "Reads ambient light through a photoresistor on ESP32-H2 ADC channel 3 and updates a host-created Matter illuminance endpoint.",
    type: "sensor",
    validationState: "validation_required",
    archiveName: "matter-photosensitive.zip",
    files: [
      { path: "drivers/photosensitive_sensor.cpp", role: "source", content: await text(path.join(root, "photo/photosensitive_sensor.cpp")) },
      { path: "drivers/photosensitive_sensor.h", role: "header", content: await text(path.join(root, "photo/photosensitive_sensor.h")) },
    ],
    gpio: [{
      name: "Light",
      peripheral: "adc1",
      gpio: 4,
      constraints: "ESP32-H2 ADC1 channel 3 is GPIO 4. GPIO 8 and GPIO 9 are reserved.",
      description: "ADC_CHANNEL_3. This is not GPIO 3.",
    }],
    matter: {
      endpoints: ["light_sensor"],
      clusters: ["Illuminance Measurement"],
      attributes: ["MeasuredValue"],
      ownedBy: "host",
      interfaceName: "photosensitive_sensor_init",
      notes: "The host creates the light-sensor endpoint and calls photosensitive_sensor_init(uint16_t endpoint_id). The supplied project CMakeLists.txt is an application manifest and is not the component manifest.",
    },
    dependsOn: [{ id: "matter-core-iotedu", type: "matter_core", constraint: "revision 1" }],
    validation: {
      errors: 2,
      warnings: 0,
      issues: [
        { level: "error", message: "No driver-only CMakeLists.txt was supplied." },
        { level: "error", message: "ESP-Matter integration compilation did not finish because generated data-model sources are absent." },
      ],
      nativeCompile: "failed",
      integrationCompile: "failed",
    },
  };
  const dht: ImportComponent = {
    id: "custom-dht11",
    name: "DHT11 Temperature and Humidity",
    description: "Reads temperature and relative humidity over one GPIO using the DHT11 timing protocol. The host application creates the Matter temperature and humidity endpoints.",
    type: "sensor",
    validationState: "validation_required",
    archiveName: "matter-dht11.zip",
    files: [
      { path: "drivers/dht11.c", role: "source", content: await text(path.join(root, "dht/dht11.c")) },
      { path: "drivers/dht11.h", role: "header", content: await text(path.join(root, "dht/dht11.h")) },
    ],
    gpio: [{
      name: "Data",
      peripheral: "gpio",
      gpio: 4,
      constraints: "Fixed GPIO_NUM_4 in the driver. GPIO 8 and GPIO 9 are reserved.",
      description: "Single-wire DHT11 data pin.",
    }],
    matter: {
      endpoints: ["temperature_sensor", "humidity_sensor"],
      clusters: ["Temperature Measurement", "Relative Humidity Measurement"],
      attributes: ["MeasuredValue"],
      ownedBy: "host",
      interfaceName: "dht11_init",
      notes: "dht11_init(void) configures GPIO 4. dht11_read returns both measurements. Matter attribute updates live in app_main.cpp, which is not part of this component.",
    },
    dependsOn: [{ id: "matter-core-iotedu", type: "matter_core", constraint: "revision 1" }],
    validation: {
      errors: 1,
      warnings: 0,
      issues: [{ level: "error", message: "The driver has no component CMakeLists.txt, and its Matter updates remain in the host application." }],
      nativeCompile: "not_run",
      integrationCompile: "not_run",
    },
  };
  const rgb: ImportComponent = {
    id: "custom-rgb-led",
    name: "RGB LED Controller",
    description: "Common-cathode RGB LED controlled with 8-bit PWM at 5 kHz. The supplied project implements on/off, brightness, hue, saturation, XY colour, and colour temperature inside app_main.cpp.",
    type: "actuator",
    validationState: "incompatible",
    archiveName: "matter-rgb-led.zip",
    files: [{ path: "main/app_main.cpp", role: "host_snapshot", content: await text(path.join(root, "rgb/app_main.cpp")) }],
    gpio: [
      { name: "Red", peripheral: "ledc", gpio: 4, constraints: "Fixed PWM channel 0.", description: "Red channel." },
      { name: "Green", peripheral: "ledc", gpio: 10, constraints: "Fixed PWM channel 1.", description: "Green channel." },
      { name: "Blue", peripheral: "ledc", gpio: 5, constraints: "Fixed PWM channel 2.", description: "Blue channel." },
    ],
    matter: {
      endpoints: ["extended_color_light"],
      clusters: ["On/Off", "Level Control", "Color Control"],
      attributes: ["OnOff", "CurrentLevel", "CurrentHue", "CurrentSaturation", "CurrentX", "CurrentY", "ColorTemperatureMireds"],
      ownedBy: "host",
      interfaceName: null,
      notes: "There is no separate driver or public initialisation function. init_rgb_led is static inside app_main.cpp. The original file is kept as a host snapshot and is not a reusable component.",
    },
    dependsOn: [{ id: "matter-core-iotedu", type: "matter_core", constraint: "revision 1" }],
    validation: {
      errors: 1,
      warnings: 0,
      issues: [{ level: "error", message: "The RGB implementation is embedded in the host application and has no reusable integration interface." }],
      nativeCompile: "not_run",
      integrationCompile: "not_run",
    },
  };
  return [core, photo, dht, rgb];
}

const directory = path.dirname(fileURLToPath(import.meta.url));
await loadEnvFile(path.join(directory, "../.env"));
const result = await importComponents(await supplied());
console.log(JSON.stringify(result));
await closeCatalogue();
