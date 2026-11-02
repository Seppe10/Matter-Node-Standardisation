export interface SetupNodePackage {
  buildId: string;
  softwareVersion: number;
  softwareVersionString: string;
  buildStatus: string;
  releaseState: "published" | "release_candidate" | "compiled" | "legacy";
  legacy: boolean;
  hardware: string;
  pins: { name: string; gpio: number }[];
  hashVerified: boolean;
  identityVerified: boolean;
  deviceRevision: number | null;
  coreRevision: number | null;
  endpoints: string[];
}

export interface SetupNodeType {
  id: string;
  name: string;
  description: string;
  category: string;
  target: string;
  status: "compiled" | "pending";
  statusLabel: string;
  pendingReason: string | null;
  matterCore: { id: string; name: string; revision: number };
  device: { id: string; name: string; revision: number; validationState: string };
  gpio: { name: string; gpio: number | null; description: string }[];
  endpoints: string[];
  packages: SetupNodePackage[];
}

export type PackageChoice =
  | { kind: "none" }
  | { kind: "single"; package: SetupNodePackage }
  | { kind: "many" };

export function initialNodeTypeId(): null {
  return null;
}

export function choosePackages(type: SetupNodeType | null): PackageChoice {
  const only = type?.packages[0];
  if (!type || type.packages.length === 0 || !only) return { kind: "none" };
  if (type.packages.length === 1) return { kind: "single", package: only };
  return { kind: "many" };
}

export function packageAfterTypeChange(type: SetupNodeType | null): string | null {
  const choice = choosePackages(type);
  return choice.kind === "single" ? choice.package.buildId : null;
}

export function selectedPackage(type: SetupNodeType | null, buildId: string | null): SetupNodePackage | null {
  if (!type || !buildId) return null;
  return type.packages.find((item) => item.buildId === buildId) ?? null;
}

export function wiringFor(type: SetupNodeType, selected: SetupNodePackage | null): Array<{ name: string; gpio: number | null; description: string; source: "compiled-package" | "catalogue-default" }> {
  if (!selected) {
    return type.gpio.map((pin) => ({ ...pin, source: "catalogue-default" }));
  }
  return selected.pins.map((pin) => {
    const recorded = type.gpio.find((item) => item.gpio === pin.gpio);
    return {
      name: recorded?.name ?? pin.name,
      gpio: pin.gpio,
      description: recorded?.description ?? "Pin recorded on the compiled package.",
      source: "compiled-package",
    };
  });
}

export function flashBytesFromLabel(label: string | null): number | null {
  const match = label?.match(/(\d+(?:\.\d+)?)\s*MB/i);
  if (!match?.[1]) return null;
  return Math.round(Number(match[1]) * 1024 * 1024);
}

export function installationAllowed(input: {
  nodeType: SetupNodeType | null;
  package: SetupNodePackage | null;
  chipModel: string | null;
  flashLabel: string | null;
  requiredFlashBytes: number;
  identified: boolean;
  planReady: boolean;
}): { allowed: boolean; reason: string } {
  if (!input.nodeType) return { allowed: false, reason: "Select a Node Type before installing firmware." };
  if (input.nodeType.status !== "compiled" || input.nodeType.packages.length === 0) {
    return { allowed: false, reason: input.nodeType.pendingReason ?? "No compiled firmware package is currently available for this Node Type." };
  }
  const firmware = input.package;
  if (!firmware) return { allowed: false, reason: "Select a firmware package for this Node Type." };
  if (!firmware.hashVerified) return { allowed: false, reason: "The firmware package hash does not match the recorded image." };
  if (!firmware.identityVerified || firmware.deviceRevision !== input.nodeType.device.revision) {
    return { allowed: false, reason: "This package does not match the Node Type component revision." };
  }
  if (firmware.coreRevision != null && firmware.coreRevision !== input.nodeType.matterCore.revision) {
    return { allowed: false, reason: "This package does not match the Matter core revision." };
  }
  if (!sameMembers(firmware.endpoints, input.nodeType.endpoints)) {
    return { allowed: false, reason: "This package does not match the Node Type Matter endpoints." };
  }
  if (firmware.hardware !== input.nodeType.target) {
    return { allowed: false, reason: "This package is not built for this Node Type's board." };
  }
  if (!input.nodeType.gpio.every((pin) => pin.gpio == null || firmware.pins.some((item) => item.gpio === pin.gpio))) {
    return { allowed: false, reason: "This package does not match the Node Type GPIO configuration." };
  }
  if (firmware.hardware !== "esp32h2" || input.nodeType.target !== "esp32h2") {
    return { allowed: false, reason: "This package is not built for the ESP32-H2." };
  }
  if (input.nodeType.gpio.some((pin) => pin.gpio === 8 || pin.gpio === 9) || firmware.pins.some((pin) => pin.gpio === 8 || pin.gpio === 9)) {
    return { allowed: false, reason: "GPIO 8 is a strapping pin and GPIO 9 is the BOOT button. This package is not installable." };
  }
  if (!input.identified || !input.chipModel || input.chipModel === "Not Verified") {
    return { allowed: false, reason: "Identify the connected ESP32-H2 before writing firmware." };
  }
  if (input.chipModel !== "ESP32-H2") return { allowed: false, reason: "The connected chip is not an ESP32-H2." };
  const flashBytes = flashBytesFromLabel(input.flashLabel);
  if (flashBytes == null) return { allowed: false, reason: "The connected board's flash capacity has not been read." };
  if (flashBytes < input.requiredFlashBytes) {
    return { allowed: false, reason: "The connected board does not have enough flash for this package." };
  }
  if (!input.planReady) return { allowed: false, reason: "The package flash layout has not been validated for this board." };
  return { allowed: true, reason: "The selected package can be reviewed. Writing starts only after confirmation." };
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

export function releaseLabel(state: SetupNodePackage["releaseState"]): string {
  if (state === "published") return "Published release";
  if (state === "release_candidate") return "Release candidate";
  if (state === "legacy") return "Previously compiled";
  return "Compiled";
}
