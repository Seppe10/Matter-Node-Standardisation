import { readFile } from "node:fs/promises";
import path from "node:path";
import { repositoryPaths } from "@iotedu/contracts/paths";
import { compileLibraryComponent } from "@iotedu/firmware-builder";
import { addCatalogueRevision, closeCatalogue, type ImportComponent } from "./catalogue-store.js";
import { loadEnvFile } from "./load-env.js";

const repo = path.resolve(import.meta.dirname, "../../..");

async function gitHead(): Promise<string> {
  const pointer = (await readFile(path.join(repo, ".git/HEAD"), "utf8")).trim();
  if (/^[a-f0-9]{40}$/.test(pointer)) return pointer;
  const ref = pointer.replace(/^ref:\s*/, "");
  return (await readFile(path.join(repo, ".git", ref), "utf8")).trim();
}

async function textFiles(root: string, names: { path: string; role: ImportComponent["files"][number]["role"] }[]) {
  return Promise.all(names.map(async (file) => ({
    path: file.path,
    role: file.role,
    content: await readFile(path.join(root, file.path), "utf8"),
  })));
}

function counts(report: { success: boolean; diagnostics: { level: string; message: string; file?: string; line?: number }[] }) {
  const errors = report.diagnostics.filter((item) => item.level === "error");
  const warnings = report.diagnostics.filter((item) => item.level === "warning");
  return { errors: errors.length, warnings: warnings.length, issues: report.diagnostics.map((item) => ({ level: item.level, message: item.message })) };
}

async function main(): Promise<void> {
  await loadEnvFile(path.join(import.meta.dirname, "../.env"));
  const head = await gitHead();
  const paths = repositoryPaths(repo);
  const dhtRoot = path.join(paths.catalogueRoot, "components", "dht11");
  const photoRoot = path.join(paths.catalogueRoot, "components", "photosensitive");
  const rgbRoot = path.join(paths.catalogueRoot, "components", "rgb_led");
  const coreRoot = path.join(paths.firmwareComponentsRoot, "iotedu_core");
  const [dhtFiles, photoFiles, rgbFiles, coreFiles] = await Promise.all([
    textFiles(dhtRoot, [
      { path: "dht11.c", role: "source" },
      { path: "dht11.h", role: "header" },
      { path: "CMakeLists.txt", role: "build" },
    ]),
    textFiles(photoRoot, [
      { path: "drivers/photosensitive_sensor.cpp", role: "source" },
      { path: "drivers/photosensitive_sensor.h", role: "header" },
      { path: "CMakeLists.txt", role: "build" },
    ]),
    textFiles(rgbRoot, [
      { path: "rgb_led.cpp", role: "source" },
      { path: "rgb_led.h", role: "header" },
      { path: "CMakeLists.txt", role: "build" },
    ]),
    textFiles(coreRoot, [
      { path: "iotedu_core.cpp", role: "source" },
      { path: "include/iotedu_core.h", role: "header" },
      { path: "CMakeLists.txt", role: "build" },
      { path: "app_openthread_config.h", role: "header" },
    ]),
  ]);
  const compileInput = (files: { path: string; content: string }[]) => files.map((file) => ({ name: file.path, data: Buffer.from(file.content) }));
  const [dhtReport, rgbReport] = await Promise.all([
    compileLibraryComponent(compileInput(dhtFiles)),
    compileLibraryComponent(compileInput(rgbFiles)),
  ]);
  const photoReport = await compileLibraryComponent(compileInput(photoFiles));
  const dhtCounts = counts(dhtReport);
  const rgbCounts = counts(rgbReport);
  const photoCounts = counts(photoReport);
  const photoValidated = photoReport.success && photoCounts.warnings === 0 && photoCounts.errors === 0;
  const components: ImportComponent[] = [
    {
      id: "custom-dht11",
      name: "DHT11 Temperature and Humidity",
      description: "Reusable DHT11 driver. Temperature and humidity Matter attributes stay in the host application.",
      type: "sensor",
      validationState: "validation_required",
      files: dhtFiles,
      gpio: [{ name: "data", peripheral: "gpio", gpio: 4, constraints: "Default GPIO 4. dht11_init_pin accepts GPIO 0-27 except GPIO 8 and GPIO 9.", description: "Single-wire data" }],
      matter: { endpoints: ["temperature_sensor", "humidity_sensor"], clusters: [], attributes: [], ownedBy: "host", interfaceName: "dht11_init", signature: "esp_err_t dht11_init(void)", notes: "The driver reads the sensor. The host creates the Matter endpoints and writes the attributes. Native component compilation does not by itself validate the Matter integration." },
      dependsOn: [{ id: "matter-core-iotedu", type: "matter_core", constraint: "content-addressed iotedu_core" }],
      validation: { ...dhtCounts, nativeCompile: dhtReport.success ? "succeeded" : "failed", integrationCompile: "not_run" },
      archiveName: "catalogue-revision",
    },
    {
      id: "custom-photosensitive-light",
      name: "Photosensitive Light Sensor",
      description: "Reusable ADC light sensor. ADC channel 3 is GPIO 4 on ESP32-H2. The host creates the light-sensor endpoint.",
      type: "sensor",
      validationState: photoValidated ? "validated" : "validation_required",
      files: photoFiles,
      gpio: [{ name: "adc", peripheral: "adc1", gpio: 4, constraints: "Fixed. ADC_CHANNEL_3 maps to GPIO 4 on ESP32-H2.", description: "ADC1 channel 3" }],
      matter: { endpoints: ["light_sensor"], clusters: ["IlluminanceMeasurement"], attributes: ["MeasuredValue"], ownedBy: "host", interfaceName: "photosensitive_sensor_init", signature: "esp_err_t photosensitive_sensor_init(uint16_t endpoint_id)", notes: "The driver updates the illuminance attribute on the endpoint supplied by the host. It does not create a Matter node." },
      dependsOn: [{ id: "matter-core-iotedu", type: "matter_core", constraint: "content-addressed iotedu_core" }],
      validation: { ...photoCounts, nativeCompile: photoReport.success ? "succeeded" : "failed", integrationCompile: photoReport.success ? "succeeded" : "failed" },
      archiveName: "catalogue-revision",
    },
    {
      id: "custom-rgb-led",
      name: "RGB LED Controller",
      description: "Reusable PWM RGB driver extracted from the uploaded application. The original host snapshot remains the previous revision.",
      type: "actuator",
      validationState: "validation_required",
      files: rgbFiles,
      gpio: [
        { name: "red", peripheral: "ledc", gpio: 4, constraints: "Default GPIO 4. rgb_led_init accepts other GPIOs except GPIO 8 and GPIO 9.", description: "Red PWM" },
        { name: "green", peripheral: "ledc", gpio: 10, constraints: "Default GPIO 10. rgb_led_init accepts other GPIOs except GPIO 8 and GPIO 9.", description: "Green PWM" },
        { name: "blue", peripheral: "ledc", gpio: 5, constraints: "Default GPIO 5. rgb_led_init accepts other GPIOs except GPIO 8 and GPIO 9.", description: "Blue PWM" },
      ],
      matter: { endpoints: ["extended_color_light"], clusters: ["OnOff", "LevelControl", "ColorControl"], attributes: [], ownedBy: "host", interfaceName: "rgb_led_init", signature: "esp_err_t rgb_led_init(gpio_num_t red, gpio_num_t green, gpio_num_t blue)", notes: "PWM, brightness, HSV, XY and colour temperature are implemented. The driver does not create a Matter endpoint. A component compile is not a Matter integration compile." },
      dependsOn: [{ id: "matter-core-iotedu", type: "matter_core", constraint: "content-addressed iotedu_core" }],
      validation: { ...rgbCounts, nativeCompile: rgbReport.success ? "succeeded" : "failed", integrationCompile: "not_run" },
      archiveName: "catalogue-revision",
    },
    {
      id: "matter-core-iotedu",
      name: "IoT.Edu Matter-over-Thread core",
      description: "Working iotedu_core sources stored by content hash. ESP-IDF and ESP-Matter are not copied into the database.",
      type: "matter_core",
      validationState: "draft",
      files: coreFiles,
      gpio: [],
      matter: { endpoints: [], clusters: [], attributes: [], ownedBy: "component", interfaceName: "iotedu_core_prepare", signature: "esp_err_t iotedu_core_prepare(esp_matter::node_t **node)", notes: `Content-addressed source of node-data/firmware/components/iotedu_core. Git HEAD ${head} is a reference only because the working tree may contain other changes. The blob hashes identify the core.` },
      dependsOn: [],
      validation: { errors: 0, warnings: 0, issues: [], nativeCompile: "not_run", integrationCompile: "not_run" },
      archiveName: "working-tree",
    },
  ];
  const stored: { id: string; result: string }[] = [];
  for (const component of components) stored.push({ id: component.id, result: await addCatalogueRevision(component) });
  console.log(JSON.stringify({
    head,
    stored,
    dht: { success: dhtReport.success, ran: dhtReport.ran, diagnostics: dhtReport.diagnostics },
    rgb: { success: rgbReport.success, ran: rgbReport.ran, diagnostics: rgbReport.diagnostics },
    photo: { success: photoReport.success, ran: photoReport.ran, diagnostics: photoReport.diagnostics },
  }, null, 2));
  await closeCatalogue();
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "revision failed";
  console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://redacted"));
  await closeCatalogue();
  process.exit(1);
});
