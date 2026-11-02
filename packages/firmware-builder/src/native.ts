import { spawn } from "node:child_process";
import { stopProcessTree, toolProcessOptions } from "./platform.js";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ValidationIssue } from "@iotedu/contracts";
import { repositoryPaths } from "@iotedu/contracts/paths";
import {
  firmwareCompatibilityIssues,
  loadReferenceLayout,
  parseOtaShow,
  readAppDescription,
  sdkconfigValue,
  type BoardProfile,
} from "./index.js";
import { classifyCompilerOutput, readIdfVersion, type CompilerDiagnostic } from "./compiler-diagnostics.js";
import { generateDht11Workspace } from "./workspace.js";

export interface NativeBuildSpec {
  repoRoot: string;
  workspaceDir: string;
  artifactDir: string;
  softwareVersion: number;
  softwareVersionString: string;
  dht11Gpio: number;
  signal: AbortSignal;
  onLog: (line: string) => void;
  prepareWorkspace?: () => Promise<{
    partitionLayoutId: string;
    pinExpectations?: { key: string; value: string }[];
    productId?: number;
  }>;
}

export interface NativeArtifact {
  name: string;
  sha256: string;
  size: number;
  deployable: boolean;
}

export interface NativeBuildResult {
  ok: boolean;
  cancelled: boolean;
  durationMs: number;
  partitionLayoutId: string | null;
  issues: ValidationIssue[];
  artifacts: NativeArtifact[];
  summary: string[];
  diagnostics?: CompilerDiagnostic[];
  idfVersion?: string | null;
}

const ARTIFACT_NAMES: Record<string, string> = {
  "bootloader/bootloader.bin": "bootloader.bin",
  "sensors.bin": "sensors.bin",
  "partition_table/partition-table.bin": "partition-table.bin",
  "ota_data_initial.bin": "ota_data_initial.bin",
};

const workspaceLocks = new Set<string>();

interface FlashMap {
  write_flash_args?: string[];
  flash_files?: Record<string, string>;
  extra_esptool_args?: { chip?: string };
}

function lockWorkspace(dir: string): () => void {
  const key = path.resolve(dir);
  if (workspaceLocks.has(key)) {
    throw new Error("A build is already using this workspace");
  }
  workspaceLocks.add(key);
  return () => workspaceLocks.delete(key);
}

function runCaptured(
  script: string,
  args: string[],
  onLog: (line: string) => void,
  signal: AbortSignal,
): Promise<{ code: number; cancelled: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ code: 1, cancelled: true, text: "" });
      return;
    }
    const child = spawn(script, args, {
      ...toolProcessOptions(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cancelled = false;
    let text = "";
    const onAbort = () => {
      cancelled = true;
      onLog("Cancellation requested. Stopping the toolchain process.");
      stopProcessTree(child);
    };
    signal.addEventListener("abort", onAbort);
    const emit = (chunk: Buffer) => {
      const piece = chunk.toString("utf8");
      text += piece;
      for (const line of piece.split(/\r?\n/)) {
        if (line) onLog(line.slice(0, 2000));
      }
    };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, cancelled, text });
    });
  });
}

async function fileRecord(file: string, name: string, deployable: boolean): Promise<NativeArtifact> {
  const data = await readFile(file);
  return {
    name,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
    deployable,
  };
}

export async function runNativeDht11Build(spec: NativeBuildSpec): Promise<NativeBuildResult> {
  const started = Date.now();
  const summary: string[] = [];
  const issues: ValidationIssue[] = [];
  const artifacts: NativeArtifact[] = [];
  const diagnostics: CompilerDiagnostic[] = [];
  let idfVersion: string | null = null;
  let release = () => {};
  const finish = (ok: boolean, cancelled: boolean, layoutId: string | null): NativeBuildResult => ({
    ok,
    cancelled,
    durationMs: Date.now() - started,
    partitionLayoutId: layoutId,
    issues,
    artifacts,
    summary,
    diagnostics,
    idfVersion,
  });
  const recordDiagnostics = (text: string) => {
    idfVersion ??= readIdfVersion(text);
    const found = classifyCompilerOutput(text, spec.workspaceDir);
    diagnostics.push(...found);
    const componentWarnings = found.filter((item) => item.origin === "component" && item.level === "warning");
    const sdkWarnings = found.filter((item) => item.origin === "sdk" && item.level === "warning");
    for (const item of componentWarnings.slice(0, 20)) {
      issues.push({ level: "warning", code: "component_warning", message: `${item.file}: ${item.message}` });
    }
    for (const item of sdkWarnings.slice(0, 8)) {
      issues.push({ level: "warning", code: "sdk_warning", message: `${item.file}: ${item.message}` });
    }
  };

  try {
    release = lockWorkspace(spec.workspaceDir);
    const script = path.join(spec.repoRoot, "scripts/idf_exec.sh");
    await mkdir(spec.artifactDir, { recursive: true });
    if (spec.signal.aborted) return finish(false, true, null);

    const prepared = spec.prepareWorkspace ? await spec.prepareWorkspace() : null;
    const generated = prepared
      ? {
          outDir: spec.workspaceDir,
          partitionLayoutId: prepared.partitionLayoutId,
          dht11Gpio: spec.dht11Gpio,
          softwareVersion: spec.softwareVersion,
          softwareVersionString: spec.softwareVersionString,
        }
      : await generateDht11Workspace({
          repoRoot: spec.repoRoot,
          outDir: spec.workspaceDir,
          softwareVersion: spec.softwareVersion,
          softwareVersionString: spec.softwareVersionString,
          dht11Gpio: spec.dht11Gpio,
        });
    spec.onLog(spec.prepareWorkspace ? "Using the catalogue firmware workspace." : "Generating an isolated DHT11 workspace.");
    summary.push(`Workspace ${generated.outDir}`);
    summary.push(`Requested version ${generated.softwareVersion} / ${generated.softwareVersionString}`);

    const target = await runCaptured(script, ["idf", "-C", spec.workspaceDir, "set-target", "esp32h2"], spec.onLog, spec.signal);
    recordDiagnostics(`${target.text}\n`);
    if (target.cancelled) return finish(false, true, generated.partitionLayoutId);
    if (target.code !== 0) {
      issues.push({ level: "error", code: "compile_failed", message: "Setting the ESP32-H2 target failed" });
      return finish(false, false, generated.partitionLayoutId);
    }

    spec.onLog("Compiling the firmware.");
    const built = await runCaptured(script, ["idf", "-C", spec.workspaceDir, "build"], spec.onLog, spec.signal);
    recordDiagnostics(built.text);
    if (built.cancelled) return finish(false, true, generated.partitionLayoutId);
    if (built.code !== 0) {
      issues.push({ level: "error", code: "compile_failed", message: "The firmware compiler failed" });
      return finish(false, false, generated.partitionLayoutId);
    }

    const buildDir = path.join(spec.workspaceDir, "build");
    const flash = JSON.parse(await readFile(path.join(buildDir, "flasher_args.json"), "utf8")) as FlashMap;
    if (flash.extra_esptool_args?.chip !== "esp32h2") {
      issues.push({ level: "error", code: "target_mismatch", message: "flasher arguments do not name ESP32-H2" });
    }
    const flashFiles = flash.flash_files ?? {};
    for (const [source, name] of Object.entries(ARTIFACT_NAMES)) {
      if (!Object.values(flashFiles).includes(source)) {
        issues.push({ level: "error", code: "artifact_missing", message: `The build did not list ${source}` });
      }
      await copyFile(path.join(buildDir, source), path.join(spec.artifactDir, name));
    }
    await copyFile(path.join(buildDir, "flasher_args.json"), path.join(spec.artifactDir, "flasher_args.json"));
    await copyFile(path.join(spec.workspaceDir, "sdkconfig"), path.join(spec.artifactDir, "sdkconfig"));
    await copyFile(path.join(spec.workspaceDir, "dependencies.lock"), path.join(spec.artifactDir, "dependencies.lock"));

    const appPath = path.join(spec.artifactDir, "sensors.bin");
    const appBinary = await readFile(appPath);
    const described = readAppDescription(appBinary);
    const sdkconfig = await readFile(path.join(spec.artifactDir, "sdkconfig"), "utf8");
    const vendorText = sdkconfigValue(sdkconfig, "CONFIG_DEVICE_VENDOR_ID");
    const productText = sdkconfigValue(sdkconfig, "CONFIG_DEVICE_PRODUCT_ID");
    const vendorId = vendorText ? Number(vendorText) : NaN;
    const productId = productText ? Number(productText) : NaN;
    const otaPath = path.join(spec.artifactDir, "sensors.ota");
    const created = await runCaptured(
      script,
      ["ota-create", `0x${vendorId.toString(16)}`, `0x${productId.toString(16)}`, String(spec.softwareVersion), spec.softwareVersionString, appPath, otaPath],
      spec.onLog,
      spec.signal,
    );
    let ota = null;
    if (created.cancelled) return finish(false, true, generated.partitionLayoutId);
    if (created.code !== 0) {
      issues.push({ level: "error", code: "matter_ota_missing", message: "Creating the Matter OTA image failed" });
    } else {
      const shown = await runCaptured(script, ["ota-show", otaPath], spec.onLog, spec.signal);
      if (shown.cancelled) return finish(false, true, generated.partitionLayoutId);
      try {
        ota = parseOtaShow(shown.text);
      } catch (error) {
        issues.push({
          level: "error",
          code: "ota_header_mismatch",
          message: error instanceof Error ? error.message : "OTA header could not be read",
        });
      }
    }

    const merged = path.join(spec.artifactDir, "usb-image.bin");
    const mergeArgs = ["-o", merged, ...(flash.write_flash_args ?? [])];
    for (const [offset, relative] of Object.entries(flashFiles)) {
      const name = ARTIFACT_NAMES[relative];
      if (!name) continue;
      mergeArgs.push(offset, path.join(spec.artifactDir, name));
    }
    const mergedRun = await runCaptured(script, ["merge-bin", ...mergeArgs], spec.onLog, spec.signal);
    if (mergedRun.cancelled) return finish(false, true, generated.partitionLayoutId);
    if (mergedRun.code !== 0) {
      issues.push({ level: "error", code: "merged_image_failed", message: "The merged USB image was not created" });
    }

    const profile = JSON.parse(
      await readFile(path.join(repositoryPaths(spec.repoRoot).boardProfilesRoot, "esp32h2.json"), "utf8"),
    ) as BoardProfile;
    const layout = await loadReferenceLayout(spec.repoRoot, profile);
    const slot = layout.partitions.find((row) => row.name === "ota_0");
    const referenceLock = await readFile(path.join(repositoryPaths(spec.repoRoot).firmwareTemplateRoot, "dependencies.lock"));
    const builtLock = await readFile(path.join(spec.artifactDir, "dependencies.lock"));
    issues.push(
      ...firmwareCompatibilityIssues({
        sdkconfig,
        layoutId: generated.partitionLayoutId,
        expectedLayoutId: layout.layoutId,
        softwareVersion: spec.softwareVersion,
        softwareVersionString: spec.softwareVersionString,
        dht11Gpio: spec.dht11Gpio,
        pinExpectations: prepared?.pinExpectations,
        expectedProductId: prepared?.productId,
        appBytes: appBinary.length,
        slotBytes: slot?.size ?? 0,
        appVersion: described.version,
        appProject: described.project,
        ota,
        vendorId,
        productId,
        dependencyLockMatchesReference: referenceLock.equals(builtLock),
      }),
    );

    const componentErrors = diagnostics.filter((item) => item.origin === "component" && item.level === "error").length;
    const componentWarnings = diagnostics.filter((item) => item.origin === "component" && item.level === "warning").length;
    const sdkErrors = diagnostics.filter((item) => item.origin === "sdk" && item.level === "error").length;
    const sdkWarnings = diagnostics.filter((item) => item.origin === "sdk" && item.level === "warning").length;
    summary.push(`Component diagnostics: ${componentErrors} errors, ${componentWarnings} warnings. SDK diagnostics: ${sdkErrors} errors, ${sdkWarnings} warnings.`);
    const failed = issues.some((issue) => issue.level === "error");
    const names = [
      "sensors.bin",
      "bootloader.bin",
      "partition-table.bin",
      "ota_data_initial.bin",
      "usb-image.bin",
      "sensors.ota",
      "flasher_args.json",
      "sdkconfig",
      "dependencies.lock",
    ];
    for (const name of names) {
      const file = path.join(spec.artifactDir, name);
      try {
        await stat(file);
      } catch {
        continue;
      }
      const deployable = !failed && name === "sensors.ota";
      artifacts.push(await fileRecord(file, name, deployable));
    }
    summary.push(`Application ${described.project} ${described.version}, ${appBinary.length} bytes`);
    if (ota) summary.push(`OTA header VID ${ota.vendorId} PID ${ota.productId} version ${ota.version} ${ota.versionString}`);
    await rm(path.join(spec.workspaceDir, "build"), { recursive: true, force: true });
    await rm(path.join(spec.workspaceDir, "managed_components"), { recursive: true, force: true });
    return finish(!failed, false, generated.partitionLayoutId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Native build failed";
    if (spec.signal.aborted || /already using this workspace/.test(message)) {
      issues.push({ level: "error", code: "build_interrupted", message });
      return finish(false, spec.signal.aborted, null);
    }
    issues.push({ level: "error", code: "compile_failed", message });
    return finish(false, false, null);
  } finally {
    release();
  }
}
