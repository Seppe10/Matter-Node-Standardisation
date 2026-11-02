import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryPaths } from "@iotedu/contracts/paths";
import { generateDht11Workspace } from "./workspace.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("DHT11 workspace generator", () => {
  it("copies the reference layout and registers the modular driver", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-fw-"));
    const generated = await generateDht11Workspace({ repoRoot, outDir });
    const partitions = await readFile(path.join(outDir, "partitions.csv"), "utf8");
    const referencePartitions = await readFile(path.join(repositoryPaths(repoRoot).firmwareTemplateRoot, "partitions.csv"), "utf8");
    expect(partitions).toBe(referencePartitions);
    const h2 = await readFile(path.join(outDir, "sdkconfig.defaults.esp32h2"), "utf8");
    expect(h2).toContain('CONFIG_IDF_TARGET="esp32h2"');
    expect(h2).toContain("CONFIG_BSP_BUTTON_1_GPIO=9");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(defaults).toContain("CONFIG_ENABLE_OTA_REQUESTOR=y");
    expect(defaults).toContain("CONFIG_APP_PROJECT_VER_FROM_CONFIG=y");
    expect(defaults).toContain('CONFIG_APP_PROJECT_VER="1.0"');
    expect(defaults).toContain("CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=1");
    expect(defaults).toContain("CONFIG_IOTEDU_DHT11_PIN=4");
    const app = await readFile(path.join(outDir, "main/app_main.cpp"), "utf8");
    expect(app).toContain("iotedu_dht11_register");
    expect(app).not.toContain("GPIO_NUM_4");
    const catalogueDriver = await readFile(path.join(repositoryPaths(repoRoot).catalogueRoot, "components", "dht11", "dht11.c"), "utf8");
    const generatedDriver = await readFile(path.join(outDir, "components/iotedu_dht11/dht11.c"), "utf8");
    expect(generatedDriver).toBe(catalogueDriver);
    expect(generatedDriver).toContain("dht11_init_pin");
    const host = await readFile(path.join(outDir, "main/dht11_matter.cpp"), "utf8");
    expect(host).toContain("dht11_init_pin(pin)");
    expect(host).toContain("CONFIG_IOTEDU_DHT11_PIN");
    const kconfig = await readFile(path.join(outDir, "main/Kconfig.projbuild"), "utf8");
    expect(kconfig).toContain("config IOTEDU_DHT11_PIN");
    expect(kconfig).toContain("default 4");
    const cmake = await readFile(path.join(outDir, "CMakeLists.txt"), "utf8");
    expect(cmake).toContain("firmware/components");
    expect(cmake).not.toContain("reference/matter-dht11");
    expect(cmake).not.toContain("firmware/components/iotedu_dht11");
    const coreHeader = await readFile(
      path.join(repositoryPaths(repoRoot).firmwareComponentsRoot, "iotedu_core", "app_openthread_config.h"),
      "utf8",
    );
    expect(coreHeader).toContain("RADIO_MODE_NATIVE");
    expect(generated.partitionLayoutId).toMatch(/^[a-f0-9]{64}$/);
    expect(generatedDriver).toContain("GPIO_NUM_4");
    const manifest = await readFile(path.join(outDir, "main/idf_component.yml"), "utf8");
    const referenceManifest = await readFile(path.join(repositoryPaths(repoRoot).firmwareTemplateRoot, "main", "idf_component.yml"), "utf8");
    expect(manifest).toBe(referenceManifest);
  });

  it("writes a higher version into CMake and Kconfig together", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-fw-"));
    await generateDht11Workspace({
      repoRoot,
      outDir,
      softwareVersion: 2,
      softwareVersionString: "1.1.0",
      dht11Gpio: 4,
    });
    const cmake = await readFile(path.join(outDir, "CMakeLists.txt"), "utf8");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(cmake).toContain('set(PROJECT_VER "1.1.0")');
    expect(cmake).toContain("set(PROJECT_VER_NUMBER 2)");
    expect(cmake).not.toContain('set(PROJECT_VER "1.0")');
    expect(defaults).toContain('CONFIG_APP_PROJECT_VER="1.1.0"');
    expect(defaults).toContain("CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=2");
    expect(defaults).toContain("CONFIG_APP_PROJECT_VER_FROM_CONFIG=y");
    expect(defaults).toContain("CONFIG_BUTTON_LONG_PRESS_TIME_MS=5000");
  });

  it("writes firmware 1.3.0 and SoftwareVersion 4 together", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-fw-"));
    await generateDht11Workspace({
      repoRoot,
      outDir,
      softwareVersion: 4,
      softwareVersionString: "1.3.0",
      dht11Gpio: 4,
    });
    const cmake = await readFile(path.join(outDir, "CMakeLists.txt"), "utf8");
    const defaults = await readFile(path.join(outDir, "sdkconfig.defaults"), "utf8");
    expect(cmake).toContain('set(PROJECT_VER "1.3.0")');
    expect(cmake).toContain("set(PROJECT_VER_NUMBER 4)");
    expect(defaults).toContain('CONFIG_APP_PROJECT_VER="1.3.0"');
    expect(defaults).toContain("CONFIG_DEVICE_SOFTWARE_VERSION_NUMBER=4");
    expect(defaults).toContain("CONFIG_ENABLE_OTA_REQUESTOR=y");
  });

  it("refuses the factory-reset pin", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "iotedu-fw-"));
    await expect(generateDht11Workspace({ repoRoot, outDir, dht11Gpio: 9 })).rejects.toThrow(/GPIO9/);
  });

  it("refuses to write inside the reference tree", async () => {
    const outDir = path.join(repositoryPaths(repoRoot).firmwareTemplateRoot, "generated-should-not-exist");
    await expect(generateDht11Workspace({ repoRoot, outDir })).rejects.toThrow(/firmware\/template/);
  });
});
