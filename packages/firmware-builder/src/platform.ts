import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * The one place that knows about host operating systems.
 * Everything else asks this module instead of checking process.platform itself.
 * Every function takes the platform as a parameter so tests can cover all three on any machine.
 */
export type HostPlatform = NodeJS.Platform;

/** Strict serial-port names per OS. Anything else (paths, flags, shell syntax) is rejected. */
const SERIAL_PORT_PATTERNS: Readonly<Record<"darwin" | "linux" | "win32", RegExp>> = {
  darwin: /^\/dev\/cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)[A-Za-z0-9._-]{0,64}$/,
  linux: /^\/dev\/tty(ACM|USB)\d{1,3}$/,
  win32: /^COM\d{1,3}$/,
};

/**
 * A port name is acceptable if it matches any supported OS's strict pattern.
 * Accepting the union keeps the injection guarantee on every host and keeps tests host-independent;
 * the port list itself is still produced per OS, so a foreign name never appears in practice.
 */
export function isSerialPortName(port: string): boolean {
  if (port.includes("..")) return false;
  return Object.values(SERIAL_PORT_PATTERNS).some((pattern) => pattern.test(port));
}

export function serialPortPatternFor(platform: HostPlatform): RegExp | null {
  return (SERIAL_PORT_PATTERNS as Record<string, RegExp>)[platform] ?? null;
}

/** Turn raw device names from /dev into full paths that this OS's pattern accepts. */
export function filterDevicePortNames(names: string[], platform: HostPlatform): string[] {
  const pattern = serialPortPatternFor(platform);
  if (!pattern) return [];
  return names
    .map((name) => `/dev/${name}`)
    .filter((port) => pattern.test(port) && !port.includes(".."))
    .sort();
}

/** Parse `reg query HKLM\HARDWARE\DEVICEMAP\SERIALCOMM` output into COM port names. */
export function parseWindowsSerialComm(text: string): string[] {
  const ports = [...text.matchAll(/REG_SZ\s+(COM\d{1,3})\s*$/gim)].map((match) => match[1]!.toUpperCase());
  return [...new Set(ports)]
    .filter((port) => SERIAL_PORT_PATTERNS.win32.test(port))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

export interface PortListingIo {
  readDevDirectory(): Promise<string[]>;
  queryWindowsSerialComm(): Promise<string>;
}

const execFileAsync = promisify(execFile);

export const defaultPortListingIo: PortListingIo = {
  readDevDirectory: () => readdir("/dev"),
  async queryWindowsSerialComm() {
    const { stdout } = await execFileAsync("reg", ["query", "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout;
  },
};

/** List serial ports the way this OS exposes them. Never throws; an unreadable source gives []. */
export async function listHostSerialPorts(platform: HostPlatform = process.platform, io: PortListingIo = defaultPortListingIo): Promise<string[]> {
  try {
    if (platform === "win32") return parseWindowsSerialComm(await io.queryWindowsSerialComm());
    return filterDevicePortNames(await io.readDevDirectory(), platform);
  } catch {
    return [];
  }
}

/**
 * Spawn options for long-running toolchain processes.
 * POSIX: a detached process group, so cancellation can stop the whole tree.
 * Windows: not detached (detached opens a console window there), and the tree is stopped with taskkill.
 */
export function toolProcessOptions(platform: HostPlatform = process.platform): { detached: boolean; windowsHide: boolean } {
  return { detached: platform !== "win32", windowsHide: true };
}

/** Stop a toolchain process and everything it started. */
export function stopProcessTree(child: ChildProcess, platform: HostPlatform = process.platform): void {
  if (!child.pid) return;
  if (platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/**
 * Whether firmware building and USB programming can run on this host today.
 * Building and flashing still go through bash scripts, so Windows is off until the
 * TypeScript esptool runner (flashing) and a Docker/WSL build backend (building) exist.
 */
export function toolchainHostSupported(platform: HostPlatform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}
