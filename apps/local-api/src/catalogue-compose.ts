import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BuildJob, FirmwareBuildRequest } from "@iotedu/contracts";
import { inspectMatterOtaImage } from "@iotedu/firmware-builder";
import { generateCatalogueWorkspace, generateNodeWorkspace, generateRetainedWorkspace, type RetainedDeviceInput } from "@iotedu/firmware-builder/catalogue-workspace";
import { compilationDecision, flashPackageFit, recipeFingerprint } from "@iotedu/firmware-builder/firmware-release";
import type { NativeBuildResult } from "@iotedu/firmware-builder/native";
import { assessCompilerDiagnostics } from "@iotedu/firmware-builder/sdk-warning-baseline";
import {
  CatalogueError,
  catalogueEnabled,
  finishFirmwareRelease,
  insertFirmwareRelease,
  listFirmwareReleases,
  loadCatalogueRevision,
  recordCompositionBuild,
  saveCompositionRecipe,
  type CatalogueRevision,
} from "./catalogue-store.js";
import { FirmwareArtifactError, firmwareArchiveDir, readFirmwareArtifact } from "./firmware-artifacts.js";
import type { LocalFirmwareBuildService } from "./services.js";

const CORE_ID = "matter-core-iotedu";
const DHT_ID = "custom-dht11";
const CORE_REVISION = 2;
const DEVICE_REVISION = {
  "photosensitive-light": 2,
  "rgb-led": 3,
} as const;

const RETAINED_DEVICES = {
  "custom-rgb-led": { revision: 3, kind: "rgb" as const },
  "custom-photosensitive-light": { revision: 2, kind: "photosensitive" as const },
  "custom-dht11": { revision: 2, kind: "dht11" as const },
};

export function retainedRecipeFingerprint(input: {
  productId: number;
  coreVersionId: string;
  devices: { versionId: string; pins: { gpio: number }[] }[];
  retiredEndpointIds: number[];
}): string {
  return recipeFingerprint([
    { versionId: `target-product:${input.productId.toString(16)}`, gpio: null },
    { versionId: input.coreVersionId, gpio: null },
    ...input.devices.flatMap((device) => device.pins.map((pin) => ({ versionId: device.versionId, gpio: pin.gpio }))),
    { versionId: `retired-endpoints:${[...input.retiredEndpointIds].sort((left, right) => left - right).join(",")}`, gpio: null },
  ]);
}

export async function startRetainedComposition(
  firmware: LocalFirmwareBuildService,
  input: {
    repoRoot: string;
    dataDir: string;
    vendorId: number;
    productId: number;
    components: { id: string; pins: { name: string; gpio: number }[]; reserveEndpointIds: number[] }[];
    retiredEndpointIds: number[];
    intent?: "reuse" | "new-release";
    softwareVersion?: number;
  },
): Promise<{ job: BuildJob; reused: boolean }> {
  if (!catalogueEnabled()) {
    throw new CatalogueError("The Neon catalogue is not configured.", 503, "catalogue_unavailable");
  }
  if (input.vendorId !== 0xfff1) {
    throw new CatalogueError("A retained composition uses vendor 0xFFF1.", 400, "vendor_mismatch");
  }
  if (input.components.length === 0) {
    throw new CatalogueError("A retained composition needs at least one component.", 400, "empty_composition");
  }
  const specs = input.components.map((component) => {
    const spec = RETAINED_DEVICES[component.id as keyof typeof RETAINED_DEVICES];
    if (!spec) throw new CatalogueError(`${component.id} has no retained host.`, 409, "integration_unsupported");
    return { ...component, ...spec };
  });
  const [core, ...devices] = await Promise.all([
    loadCatalogueRevision(CORE_ID, CORE_REVISION),
    ...specs.map((spec) => loadCatalogueRevision(spec.id, spec.revision)),
  ]);
  if (!core || devices.some((device) => !device)) {
    throw new CatalogueError("A catalogue revision for this composition could not be loaded.", 409, "source_mismatch");
  }
  if (core.provenance !== "custom_code" || devices.some((device) => device.provenance !== "custom_code")) {
    throw new CatalogueError("The composition recipe uses the stored custom-code revisions.", 409, "source_mismatch");
  }
  const fingerprint = retainedRecipeFingerprint({
    productId: input.productId,
    coreVersionId: core.versionId,
    devices: devices.map((device, index) => ({ versionId: device.versionId, pins: specs[index]?.pins ?? [] })),
    retiredEndpointIds: input.retiredEndpointIds,
  });
  const jobs = await firmware.list();
  const releases = (await listFirmwareReleases()).map((release) => ({
    state: release.state,
    softwareVersion: release.softwareVersion,
    softwareVersionString: release.softwareVersionString,
    recipeFingerprint: release.recipeFingerprint,
    buildId: release.buildId,
    applicationSha256: release.applicationSha256,
  }));
  const decision = compilationDecision({
    recipeFingerprint: fingerprint,
    releases,
    buildRunning: jobs.some((job) => job.status === "running"),
    intent: input.intent ?? "new-release",
    requestedSoftwareVersion: input.softwareVersion,
  });
  if (decision.action === "reuse") {
    const job = jobs.find((item) => item.id === decision.release.buildId);
    if (!job) throw new CatalogueError("The recorded firmware package is not available to the installer.", 409, "release_missing");
    await verifyRecordedImage(input.dataDir, job, decision.release.applicationSha256);
    return { job, reused: true };
  }
  if (decision.action === "busy" || decision.action === "reject") {
    throw new CatalogueError(decision.message, 409, decision.action === "busy" ? "build_busy" : "version_not_assigned");
  }
  const softwareVersion = decision.softwareVersion;
  const softwareVersionString = decision.softwareVersionString;
  const identity = createHash("sha256")
    .update([
      `target:${input.productId.toString(16)}`,
      core.versionId,
      ...devices.map((device, index) => `${device.versionId}:${specs[index]?.pins.map((pin) => `${pin.name}:${pin.gpio}`).join(",")}`),
      `retired:${input.retiredEndpointIds.join(",")}`,
      String(softwareVersion),
      softwareVersionString,
    ].join("\n"))
    .digest("hex");
  const recipeId = `recipe-${identity.slice(0, 16)}`;
  const releaseId = `release-${identity.slice(0, 16)}`;
  const claimed = await insertFirmwareRelease({
    releaseId,
    buildId: releaseId,
    recipeId,
    recipeFingerprint: fingerprint,
    state: "draft",
    softwareVersion,
    softwareVersionString,
    vendorId: input.vendorId,
    productId: input.productId,
    partitionLayoutId: null,
    applicationSha256: null,
    otaSha256: null,
    componentRevisions: [
      { id: CORE_ID, versionId: core.versionId, fingerprint: core.fingerprint },
      ...devices.map((device, index) => ({
        id: device.componentId,
        versionId: device.versionId,
        fingerprint: device.fingerprint,
        gpio: specs[index]?.pins ?? [],
      })),
    ],
    validation: { state: "draft", identityPreserving: true, targetProductId: input.productId, hardwareVerified: false },
  });
  if (claimed === "conflict") {
    throw new CatalogueError("That Matter SoftwareVersion is already assigned. The compiler was not started.", 409, "version_conflict");
  }
  await saveCompositionRecipe({
    recipeId,
    name: `Retained product 0x${input.productId.toString(16).toUpperCase()}: ${devices.map((device) => device.versionId).join(" + ")}`,
    versions: [
      { versionId: core.versionId, gpio: [] },
      ...devices.map((device, index) => ({ versionId: device.versionId, gpio: specs[index]?.pins ?? [] })),
    ],
  });
  const matterRoot = process.env.ESP_MATTER_PATH ?? "";
  const matterRevision = matterRoot ? await readGitRevision(matterRoot) : "unknown";
  const chipRevision = matterRoot ? await readGitRevision(path.join(matterRoot, "connectedhomeip/connectedhomeip")) : "unknown";
  const request: FirmwareBuildRequest = {
    mode: "native",
    codeSource: "approved",
    nodeId: null,
    hardware: "esp32h2",
    baseFirmwareId: CORE_ID,
    componentIds: devices.map((device) => device.componentId),
    pins: specs.flatMap((spec) => spec.pins.map((pin) => ({ componentId: spec.id, pinName: pin.name, gpio: pin.gpio }))),
    softwareVersion,
    softwareVersionString,
    uploadId: null,
    confirm: true,
  };
  const retainedDevices: RetainedDeviceInput[] = devices.map((device, index) => {
    const spec = specs[index];
    if (!spec) throw new CatalogueError("A composition component was lost before the workspace was written.", 409, "source_mismatch");
    return {
      kind: spec.kind,
      files: device.files.map((file) => ({ relativePath: file.relativePath, content: file.content, sha256: file.sha256 })),
      pins: spec.pins.map((pin) => ({ componentId: spec.id, pinName: pin.name, gpio: pin.gpio })),
      reserveEndpointIds: spec.reserveEndpointIds,
    };
  });
  const pinExpectations = retainedDevices.flatMap((device) => {
    const gpio = (name: string) => device.pins.find((pin) => pin.pinName === name)?.gpio;
    if (device.kind === "photosensitive") return [{ key: "CONFIG_IOTEDU_LIGHT_ADC_GPIO", value: "4" }];
    if (device.kind === "rgb") {
      return [
        { key: "CONFIG_IOTEDU_RGB_RED_GPIO", value: String(gpio("red")) },
        { key: "CONFIG_IOTEDU_RGB_GREEN_GPIO", value: String(gpio("green")) },
        { key: "CONFIG_IOTEDU_RGB_BLUE_GPIO", value: String(gpio("blue")) },
      ];
    }
    return [{ key: "CONFIG_IOTEDU_DHT11_PIN", value: String(device.pins[0]?.gpio) }];
  });
  try {
    const job = await firmware.composeCatalogue(request, {
      notes: [
        `${core.versionId} fingerprint ${core.fingerprint}.`,
        ...devices.map((device) => `${device.versionId} fingerprint ${device.fingerprint}.`),
        `Retained vendor 0xFFF1 product 0x${input.productId.toString(16).toUpperCase()}. SoftwareVersion ${softwareVersion} is ${softwareVersionString}. The standalone component product is not used.`,
      ],
      prepareWorkspace: async (workspaceDir) => {
        const generated = await generateRetainedWorkspace({
          repoRoot: input.repoRoot,
          outDir: workspaceDir,
          softwareVersion,
          softwareVersionString,
          vendorId: input.vendorId,
          productId: input.productId,
          coreFiles: core.files.map((file) => ({ relativePath: file.relativePath, content: file.content, sha256: file.sha256 })),
          devices: retainedDevices,
        });
        return { partitionLayoutId: generated.partitionLayoutId, pinExpectations, productId: input.productId };
      },
      onComplete: (job, result) => record(job, result, {
        recipeId,
        releaseId,
        identity,
        fingerprint,
        dataDir: input.dataDir,
        core,
        devices,
        matterRevision,
        chipRevision,
      }),
    });
    return { job, reused: false };
  } catch (error) {
    await finishFirmwareRelease({
      releaseId,
      buildId: null,
      state: "build_failed",
      applicationSha256: null,
      otaSha256: null,
      validation: { state: "build_failed", message: error instanceof Error ? error.message : "The compiler did not start." },
    }).catch(() => undefined);
    throw error;
  }
}

const NODE_PROFILES = {
  "photosensitive-light": {
    componentId: "custom-photosensitive-light",
    kind: "photosensitive" as const,
    productId: 0x8001,
    recipeName: "Matter core r2 + Photosensitive Light Sensor r2",
    pins: [{ name: "adc", gpio: 4 }],
  },
  "rgb-led": {
    componentId: "custom-rgb-led",
    kind: "rgb" as const,
    productId: 0x8002,
    recipeName: "Matter core r2 + RGB LED Controller r3",
    pins: [{ name: "red", gpio: 4 }, { name: "green", gpio: 10 }, { name: "blue", gpio: 5 }],
  },
};

export async function startNodeTypeComposition(
  firmware: LocalFirmwareBuildService,
  input: {
    nodeTypeId: keyof typeof NODE_PROFILES;
    repoRoot: string;
    dataDir: string;
    intent?: "reuse" | "new-release";
    softwareVersion?: number;
  },
): Promise<{ job: BuildJob; reused: boolean }> {
  if (!catalogueEnabled()) {
    throw new CatalogueError("The Neon catalogue is not configured.", 503, "catalogue_unavailable");
  }
  const profile = NODE_PROFILES[input.nodeTypeId];
  const [core, device] = await Promise.all([
    loadCatalogueRevision(CORE_ID, CORE_REVISION),
    loadCatalogueRevision(profile.componentId, DEVICE_REVISION[input.nodeTypeId]),
  ]);
  if (core.provenance !== "custom_code" || device.provenance !== "custom_code") {
    throw new CatalogueError("The composition recipe uses the stored custom-code revisions.", 409, "source_mismatch");
  }
  const fingerprint = recipeFingerprint([
    { versionId: core.versionId, gpio: null },
    ...profile.pins.map((pin) => ({ versionId: device.versionId, gpio: pin.gpio })),
  ]);
  const jobs = await firmware.list();
  const releases = (await listFirmwareReleases()).map((release) => ({
    state: release.state,
    softwareVersion: release.softwareVersion,
    softwareVersionString: release.softwareVersionString,
    recipeFingerprint: release.recipeFingerprint,
    buildId: release.buildId,
    applicationSha256: release.applicationSha256,
  }));
  const decision = compilationDecision({
    recipeFingerprint: fingerprint,
    releases,
    buildRunning: jobs.some((job) => job.status === "running"),
    intent: input.intent ?? "reuse",
    requestedSoftwareVersion: input.softwareVersion,
  });
  if (decision.action === "reuse") {
    const job = jobs.find((item) => item.id === decision.release.buildId);
    if (!job) throw new CatalogueError("The recorded firmware package is not available to the installer.", 409, "release_missing");
    await verifyRecordedImage(input.dataDir, job, decision.release.applicationSha256);
    return { job, reused: true };
  }
  if (decision.action === "busy" || decision.action === "reject") {
    throw new CatalogueError(decision.message, 409, decision.action === "busy" ? "build_busy" : "version_not_assigned");
  }
  const softwareVersion = decision.softwareVersion;
  const softwareVersionString = decision.softwareVersionString;
  const identity = createHash("sha256")
    .update([core.versionId, device.versionId, profile.pins.map((pin) => `${pin.name}:${pin.gpio}`).join(","), String(softwareVersion), softwareVersionString].join("\n"))
    .digest("hex");
  const recipeId = `recipe-${identity.slice(0, 16)}`;
  const releaseId = `release-${identity.slice(0, 16)}`;
  const claimed = await insertFirmwareRelease({
    releaseId,
    buildId: releaseId,
    recipeId,
    recipeFingerprint: fingerprint,
    state: "draft",
    softwareVersion,
    softwareVersionString,
    vendorId: 0xfff1,
    productId: profile.productId,
    partitionLayoutId: null,
    applicationSha256: null,
    otaSha256: null,
    componentRevisions: [
      { id: CORE_ID, versionId: core.versionId, fingerprint: core.fingerprint },
      { id: profile.componentId, versionId: device.versionId, fingerprint: device.fingerprint, gpio: profile.pins },
    ],
    validation: { state: "draft" },
  });
  if (claimed === "conflict") {
    throw new CatalogueError("That Matter SoftwareVersion is already assigned. The compiler was not started.", 409, "version_conflict");
  }
  await saveCompositionRecipe({
    recipeId,
    name: profile.recipeName,
    versions: [
      { versionId: core.versionId, gpio: [] },
      { versionId: device.versionId, gpio: profile.pins },
    ],
  });
  const matterRoot = process.env.ESP_MATTER_PATH ?? "";
  const matterRevision = matterRoot ? await readGitRevision(matterRoot) : "unknown";
  const chipRevision = matterRoot ? await readGitRevision(path.join(matterRoot, "connectedhomeip/connectedhomeip")) : "unknown";
  const request: FirmwareBuildRequest = {
    mode: "native",
    codeSource: "approved",
    nodeId: null,
    hardware: "esp32h2",
    baseFirmwareId: CORE_ID,
    componentIds: [profile.componentId],
    pins: profile.pins.map((pin) => ({ componentId: profile.componentId, pinName: pin.name, gpio: pin.gpio })),
    softwareVersion,
    softwareVersionString,
    uploadId: null,
    confirm: true,
  };
  const pinExpectations = profile.kind === "photosensitive"
    ? [{ key: "CONFIG_IOTEDU_LIGHT_ADC_GPIO", value: "4" }]
    : [
        { key: "CONFIG_IOTEDU_RGB_RED_GPIO", value: "4" },
        { key: "CONFIG_IOTEDU_RGB_GREEN_GPIO", value: "10" },
        { key: "CONFIG_IOTEDU_RGB_BLUE_GPIO", value: "5" },
      ];
  try {
    const job = await firmware.composeCatalogue(request, {
      notes: [
        `${core.versionId} fingerprint ${core.fingerprint}.`,
        `${device.versionId} fingerprint ${device.fingerprint}.`,
        `${profile.recipeName}. SoftwareVersion ${softwareVersion} is ${softwareVersionString}. Product 0x${profile.productId.toString(16).toUpperCase()}. Provenance stays custom code.`,
      ],
      prepareWorkspace: async (workspaceDir) => {
        const generated = await generateNodeWorkspace({
          repoRoot: input.repoRoot,
          outDir: workspaceDir,
          softwareVersion,
          softwareVersionString,
          kind: profile.kind,
          coreFiles: core.files,
          deviceFiles: device.files,
          pins: profile.pins.map((pin) => ({ componentId: profile.componentId, pinName: pin.name, gpio: pin.gpio })),
          productId: profile.productId,
        });
        return { partitionLayoutId: generated.partitionLayoutId, pinExpectations, productId: profile.productId };
      },
      onComplete: (job, result) => record(job, result, {
        recipeId,
        releaseId,
        identity,
        fingerprint,
        dataDir: input.dataDir,
        core,
        devices: [device],
        matterRevision,
        chipRevision,
      }),
    });
    return { job, reused: false };
  } catch (error) {
    await finishFirmwareRelease({
      releaseId,
      buildId: null,
      state: "build_failed",
      applicationSha256: null,
      otaSha256: null,
      validation: { state: "build_failed", message: error instanceof Error ? error.message : "The compiler did not start." },
    }).catch(() => undefined);
    throw error;
  }
}

export async function startDht11Composition(
  firmware: LocalFirmwareBuildService,
  input: { repoRoot: string; dataDir: string; gpio: number; intent?: "reuse" | "new-release"; softwareVersion?: number },
): Promise<{ job: BuildJob; reused: boolean }> {
  if (!catalogueEnabled()) {
    throw new CatalogueError("The Neon catalogue is not configured.", 503, "catalogue_unavailable");
  }
  const [core, dht] = await Promise.all([
    loadCatalogueRevision(CORE_ID, CORE_REVISION),
    loadCatalogueRevision(DHT_ID, CORE_REVISION),
  ]);
  if (core.provenance !== "custom_code" || dht.provenance !== "custom_code") {
    throw new CatalogueError("The composition recipe uses the stored custom-code revisions.", 409, "source_mismatch");
  }
  const fingerprint = recipeFingerprint([
    { versionId: core.versionId, gpio: null },
    { versionId: dht.versionId, gpio: input.gpio },
  ]);
  const jobs = await firmware.list();
  await rememberCompiledPackage(input.dataDir, jobs, fingerprint, input.gpio);
  const releases = (await listFirmwareReleases()).map((release) => ({
    state: release.state,
    softwareVersion: release.softwareVersion,
    softwareVersionString: release.softwareVersionString,
    recipeFingerprint: release.recipeFingerprint,
    buildId: release.buildId,
    applicationSha256: release.applicationSha256,
  }));
  const decision = compilationDecision({
    recipeFingerprint: fingerprint,
    releases,
    buildRunning: jobs.some((job) => job.status === "running"),
    intent: input.intent ?? "reuse",
    requestedSoftwareVersion: input.softwareVersion,
  });
  if (decision.action === "reuse") {
    const job = jobs.find((item) => item.id === decision.release.buildId);
    if (!job) throw new CatalogueError("The recorded firmware package is not available to the installer.", 409, "release_missing");
    await verifyRecordedImage(input.dataDir, job, decision.release.applicationSha256);
    return { job, reused: true };
  }
  if (decision.action === "busy" || decision.action === "reject") {
    throw new CatalogueError(decision.message, 409, decision.action === "busy" ? "build_busy" : "version_not_assigned");
  }
  const softwareVersion = decision.softwareVersion;
  const softwareVersionString = decision.softwareVersionString;
  const identity = createHash("sha256")
    .update([core.versionId, dht.versionId, String(input.gpio), String(softwareVersion), softwareVersionString].join("\n"))
    .digest("hex");
  const recipeId = `recipe-${identity.slice(0, 16)}`;
  const releaseId = `release-${identity.slice(0, 16)}`;
  const claimed = await insertFirmwareRelease({
    releaseId,
    buildId: releaseId,
    recipeId,
    recipeFingerprint: fingerprint,
    state: "draft",
    softwareVersion,
    softwareVersionString,
    vendorId: 0xfff1,
    productId: 0x8000,
    partitionLayoutId: null,
    applicationSha256: null,
    otaSha256: null,
    componentRevisions: [
      { id: CORE_ID, versionId: core.versionId, fingerprint: core.fingerprint },
      { id: DHT_ID, versionId: dht.versionId, fingerprint: dht.fingerprint, gpio: input.gpio },
    ],
    validation: { state: "draft" },
  });
  if (claimed === "conflict") {
    throw new CatalogueError("That Matter SoftwareVersion is already assigned. The compiler was not started.", 409, "version_conflict");
  }
  await saveCompositionRecipe({
    recipeId,
    name: "Matter core r2 + DHT11 r2",
    versions: [
      { versionId: core.versionId, gpio: [] },
      { versionId: dht.versionId, gpio: [{ name: "DHT11_DATA", gpio: input.gpio }] },
    ],
  });
  const matterRoot = process.env.ESP_MATTER_PATH ?? "";
  const matterRevision = matterRoot ? await readGitRevision(matterRoot) : "unknown";
  const chipRevision = matterRoot ? await readGitRevision(path.join(matterRoot, "connectedhomeip/connectedhomeip")) : "unknown";
  const request: FirmwareBuildRequest = {
    mode: "native",
    codeSource: "approved",
    nodeId: null,
    hardware: "esp32h2",
    baseFirmwareId: CORE_ID,
    componentIds: [DHT_ID],
    pins: [{ componentId: DHT_ID, pinName: "DHT11_DATA", gpio: input.gpio }],
    softwareVersion,
    softwareVersionString,
    uploadId: null,
    confirm: true,
  };
  try {
    const job = await firmware.composeCatalogue(request, {
      notes: [
        `${core.versionId} fingerprint ${core.fingerprint}.`,
        `${dht.versionId} fingerprint ${dht.fingerprint}.`,
        `DHT11 GPIO ${input.gpio}. SoftwareVersion ${softwareVersion} is ${softwareVersionString}. Component revision ${CORE_REVISION} is not the firmware version. Provenance stays custom code.`,
      ],
      prepareWorkspace: (workspaceDir) => prepare(input.repoRoot, workspaceDir, core, dht, input.gpio, softwareVersion, softwareVersionString),
      onComplete: (job, result) => record(job, result, {
        recipeId,
        releaseId,
        identity,
        fingerprint,
        dataDir: input.dataDir,
        core,
        devices: [dht],
        matterRevision,
        chipRevision,
      }),
    });
    return { job, reused: false };
  } catch (error) {
    await finishFirmwareRelease({
      releaseId,
      buildId: null,
      state: "build_failed",
      applicationSha256: null,
      otaSha256: null,
      validation: { state: "build_failed", message: error instanceof Error ? error.message : "The compiler did not start." },
    }).catch(() => undefined);
    throw error;
  }
}

async function prepare(
  repoRoot: string,
  workspaceDir: string,
  core: CatalogueRevision,
  dht: CatalogueRevision,
  gpio: number,
  softwareVersion: number,
  softwareVersionString: string,
): Promise<{ partitionLayoutId: string }> {
  const generated = await generateCatalogueWorkspace({
    repoRoot,
    outDir: workspaceDir,
    softwareVersion,
    softwareVersionString,
    dht11Gpio: gpio,
    coreFiles: core.files.map((file) => ({ relativePath: file.relativePath, content: file.content, sha256: file.sha256 })),
    dht11Files: dht.files.map((file) => ({ relativePath: file.relativePath, content: file.content, sha256: file.sha256 })),
  });
  return { partitionLayoutId: generated.partitionLayoutId };
}

async function record(
  job: BuildJob,
  result: NativeBuildResult | null,
  input: {
    recipeId: string;
    releaseId: string;
    identity: string;
    fingerprint: string;
    dataDir: string;
    core: CatalogueRevision;
    devices: CatalogueRevision[];
    matterRevision: string;
    chipRevision: string;
  },
): Promise<void> {
  const diagnostics = result?.diagnostics ?? [];
  const componentErrors = diagnostics.filter((item) => item.origin === "component" && item.level === "error").length;
  const componentWarnings = diagnostics.filter((item) => item.origin === "component" && item.level === "warning").length;
  const sdkWarnings = diagnostics.filter((item) => item.origin === "sdk" && item.level === "warning").length;
  const image = job.artifacts.find((item) => item.name === "sensors.bin" && !item.simulated);
  const assessment = assessCompilerDiagnostics(diagnostics.map((item) => ({
    file: item.file,
    message: item.message,
    origin: item.origin,
    level: item.level,
  })));
  const integrated = job.status === "succeeded" && componentErrors === 0 && componentWarnings === 0 && Boolean(image);
  await recordCompositionBuild({
    buildId: job.id,
    recipeId: input.recipeId,
    softwareVersion: job.request.softwareVersion,
    softwareVersionString: job.request.softwareVersionString,
    espIdfVersion: result?.idfVersion ?? "unknown",
    toolchain: `esp-idf ${result?.idfVersion ?? "unknown"}; esp-matter ${input.matterRevision}; connectedhomeip ${input.chipRevision}`,
    inputFingerprint: input.identity,
    imageSha256: image?.sha256 ?? null,
    artifactPath: image?.relativePath ?? null,
    versions: [
      { versionId: input.core.versionId, fingerprint: input.core.fingerprint },
      ...input.devices.map((device) => ({ versionId: device.versionId, fingerprint: device.fingerprint })),
    ],
    errorCount: componentErrors,
    warningCount: componentWarnings,
    issues: [
      ...diagnostics.slice(0, 30).map((item) => ({
        level: item.level,
        code: item.origin === "sdk" ? "sdk_diagnostic" : "component_diagnostic",
        message: `${item.file}: ${item.message}`.slice(0, 300),
      })),
      ...(sdkWarnings > 30 ? [{ level: "warning", code: "sdk_diagnostic", message: `${sdkWarnings} SDK diagnostics were counted. The stored list is truncated.` }] : []),
    ],
    integrationCompile: integrated ? "matter-firmware" : "failed",
    promoteVersionIds: integrated && !assessment.blocksDeployment ? [input.core.versionId, ...input.devices.map((device) => device.versionId)] : [],
  });
  const ota = job.artifacts.find((item) => item.name === "sensors.ota" && !item.simulated);
  const state = !image || job.status !== "succeeded"
    ? "build_failed"
    : assessment.blocksDeployment
      ? "build_successful"
      : "release_candidate";
  await finishFirmwareRelease({
    releaseId: input.releaseId,
    buildId: job.id,
    state,
    applicationSha256: image?.sha256 ?? null,
    otaSha256: ota?.sha256 ?? null,
    validation: {
      state,
      componentErrors,
      componentWarnings,
      sdkWarnings,
      acceptedSdkWarnings: assessment.accepted.length,
      blocksDeployment: assessment.blocksDeployment,
      reason: assessment.reason,
      partitionLayoutId: job.partitionLayoutId,
      dataDir: path.relative(input.dataDir, input.dataDir),
      recipeFingerprint: input.fingerprint,
    },
  });
}

async function rememberCompiledPackage(dataDir: string, jobs: BuildJob[], fingerprint: string, gpio: number, archiveDir = firmwareArchiveDir()): Promise<void> {
  const compiled = jobs.filter((job) => job.status === "succeeded" && job.verification === "compiled"
    && job.request.baseFirmwareId === CORE_ID
    && job.request.componentIds.includes(DHT_ID)
    && job.request.pins.some((pin) => pin.pinName === "DHT11_DATA" && pin.gpio === gpio));
  for (const job of compiled) {
    const recalled = await dht11PackageRecall(dataDir, job, archiveDir);
    if (!recalled) continue;
    const { applicationSha256, otaSha256, header, image } = recalled;
    const fit = flashPackageFit({
      appBytes: image.size,
      otaSlotBytes: 0x1e0000,
      bootloaderBytes: job.artifacts.find((item) => item.name === "bootloader.bin")?.size ?? 0,
      bootloaderLimit: 0xc000,
      partitionEnd: 0x3e6000,
      flashBytes: 4_194_304,
    });
    if (!header?.ok || !fit.ok || header.vendorId !== 0xfff1 || header.productId !== 0x8000) continue;
    if (header.softwareVersion !== job.request.softwareVersion || header.softwareVersionString !== job.request.softwareVersionString) continue;
    await insertFirmwareRelease({
      releaseId: `release-${job.id}`,
      buildId: job.id,
      recipeId: null,
      recipeFingerprint: fingerprint,
      state: "release_candidate",
      softwareVersion: job.request.softwareVersion,
      softwareVersionString: job.request.softwareVersionString,
      vendorId: header.vendorId,
      productId: header.productId,
      partitionLayoutId: job.partitionLayoutId,
      applicationSha256,
      otaSha256,
      componentRevisions: job.request.componentIds.map((id) => ({ id, revision: CORE_REVISION })),
      validation: {
        state: "release_candidate",
        hardwareVerified: false,
        otaHeader: {
          vendorId: header.vendorId,
          productId: header.productId,
          softwareVersion: header.softwareVersion,
          softwareVersionString: header.softwareVersionString,
          payloadSize: header.payloadSize,
          digestValid: header.digestValid,
        },
        flashFit: fit,
        note: "Compiled and checked. It has not been flashed or observed on hardware.",
      },
    });
  }
}

export async function dht11PackageRecall(dataDir: string, job: BuildJob, archiveDir = firmwareArchiveDir()): Promise<{
  applicationSha256: string;
  otaSha256: string | null;
  header: ReturnType<typeof inspectMatterOtaImage> | null;
  image: NonNullable<BuildJob["artifacts"][number]>;
} | null> {
  const image = job.artifacts.find((item) => item.name === "sensors.bin" && !item.simulated && /^[a-f0-9]{64}$/.test(item.sha256));
  const ota = job.artifacts.find((item) => item.name === "sensors.ota" && !item.simulated && /^[a-f0-9]{64}$/.test(item.sha256));
  if (!image) return null;
  const application = await readPackage(dataDir, job.id, image.name, image.relativePath, archiveDir);
  if (application.sha256 !== image.sha256) return null;
  if (!ota) return { applicationSha256: application.sha256, otaSha256: null, header: null, image };
  const otaFile = await readPackage(dataDir, job.id, ota.name, ota.relativePath, archiveDir);
  if (otaFile.sha256 !== ota.sha256) return null;
  return { applicationSha256: application.sha256, otaSha256: otaFile.sha256, header: inspectMatterOtaImage(otaFile.bytes), image };
}

export async function verifyRecordedImage(dataDir: string, job: BuildJob, applicationSha256: string | null, archiveDir = firmwareArchiveDir()): Promise<void> {
  const image = job.artifacts.find((item) => item.name === "sensors.bin" && !item.simulated);
  if (!image || !applicationSha256) throw new CatalogueError("The recorded application image is missing.", 409, "release_missing");
  const actual = await readPackage(dataDir, job.id, image.name, image.relativePath, archiveDir);
  if (actual.sha256 !== applicationSha256 || actual.sha256 !== image.sha256) {
    throw new CatalogueError("The stored application image does not match its recorded hash.", 409, "artifact_mismatch");
  }
}

async function readPackage(dataDir: string, buildId: string, name: string, relativePath: string, archiveDir: string) {
  try {
    return await readFirmwareArtifact({ dataDir, archiveDir, buildId, name, relativePath, verify: false });
  } catch (error) {
    if (error instanceof FirmwareArtifactError) throw new CatalogueError(error.message, 409, error.code);
    throw error;
  }
}

async function readGitRevision(directory: string): Promise<string> {
  try {
    const gitPath = path.join(directory, ".git");
    const info = await stat(gitPath);
    let headFile = path.join(gitPath, "HEAD");
    if (info.isFile()) {
      const pointer = await readFile(gitPath, "utf8");
      const gitdir = pointer.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!gitdir) return "unknown";
      const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(path.dirname(gitPath), gitdir);
      headFile = path.join(resolved, "HEAD");
    }
    const head = (await readFile(headFile, "utf8")).trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return head;
    return (await readFile(path.join(path.dirname(headFile), ref), "utf8")).trim();
  } catch {
    return "unknown";
  }
}
