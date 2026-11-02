export interface UsbDeviceRecord {
  name: string;
  vendorId: string;
  serial: string;
  locationId: string;
}

export interface PortOccupant {
  pid: number;
  command: string;
}

export interface ClassifiedSerialPort {
  path: string;
  role: "programming" | "console" | "unknown";
  label: string;
  busy?: boolean;
  ownedByApplication?: boolean;
  occupants?: PortOccupant[];
}

export function parseLsofRecords(text: string): PortOccupant[] {
  const found: PortOccupant[] = [];
  let pid: number | null = null;
  let command = "";
  const flush = () => {
    if (pid != null && Number.isInteger(pid) && pid > 0) found.push({ pid, command: command || "unknown" });
    pid = null;
    command = "";
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      flush();
      pid = Number(line.slice(1));
    } else if (line.startsWith("c")) {
      command = line.slice(1);
    }
  }
  flush();
  return found;
}

async function commandOutput(command: string, args: string[], timeoutMs: number, maxBuffer = 1024 * 1024): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(command, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer });
  return stdout;
}

export async function serialPortOccupants(port: string): Promise<PortOccupant[]> {
  try {
    try {
      return parseLsofRecords(await commandOutput("lsof", ["-nP", "-Fpc", port], 3_000));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      const stdout = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      return parseLsofRecords(stdout);
    }
  } catch {
    return [];
  }
}

export async function serialPortBusy(port: string): Promise<boolean> {
  try {
    const stdout = await commandOutput("lsof", ["-nP", port], 3_000);
    return stdout.includes(port);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    const stdout = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    return stdout.includes(port);
  }
}

export function collectUsbRecords(node: unknown, found: UsbDeviceRecord[] = []): UsbDeviceRecord[] {
  if (Array.isArray(node)) {
    for (const item of node) collectUsbRecords(item, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  const name = typeof record._name === "string" ? record._name : "";
  const vendorId = typeof record.vendor_id === "string" ? record.vendor_id : "";
  const serial = typeof record.serial_num === "string" ? record.serial_num : "";
  const locationId = typeof record.location_id === "string" ? record.location_id : "";
  if (name && (vendorId || serial || locationId)) found.push({ name, vendorId, serial, locationId });
  for (const value of Object.values(record)) collectUsbRecords(value, found);
  return found;
}

export function locationCalloutSuffix(locationId: string): string | null {
  const hex = locationId.toLowerCase().replace(/^0x/, "").split(/[\s/]/)[0] ?? "";
  if (!/^[0-9a-f]+$/.test(hex) || !hex.endsWith("000")) return null;
  return `${hex.slice(0, -3)}1`;
}

function matchesCallout(leaf: string, record: UsbDeviceRecord): boolean {
  const serial = record.serial.replace(/[^A-Za-z0-9]/g, "");
  if (serial.length >= 4 && leaf.toLowerCase().includes(serial.toLowerCase())) return true;
  const suffix = locationCalloutSuffix(record.locationId);
  return suffix != null && leaf.toLowerCase().includes(suffix);
}

export async function classifyHostSerialPorts(callouts: string[]): Promise<ClassifiedSerialPort[]> {
  const unknown = callouts.map((path) => ({ path, role: "unknown" as const, label: "USB serial" }));
  if (process.platform !== "darwin" || callouts.length === 0) return unknown;
  try {
    const stdout = await commandOutput("system_profiler", ["SPUSBDataType", "-json"], 8_000, 8_000_000);
    return classifySerialPorts(callouts, collectUsbRecords(JSON.parse(stdout)));
  } catch {
    return unknown;
  }
}

export function classifySerialPorts(callouts: string[], records: UsbDeviceRecord[]): ClassifiedSerialPort[] {
  return callouts.map((path) => {
    const leaf = path.split("/").pop() ?? path;
    const match = records.find((record) => matchesCallout(leaf, record));
    const vendor = match?.vendorId.toLowerCase() ?? "";
    const name = match?.name.toLowerCase() ?? "";
    const programming = vendor.includes("303a") || name.includes("jtag");
    const consolePort = !programming && (vendor.includes("1a86") || name.includes("single serial") || name.includes("ch34"));
    const role = programming ? "programming" : consolePort ? "console" : "unknown";
    const label = programming ? "ESP32-H2 programming interface" : consolePort ? "UART console" : "USB serial";
    return { path, role, label };
  });
}
