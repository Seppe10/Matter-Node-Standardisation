import { describe, expect, it } from "vitest";
import {
  filterDevicePortNames,
  isSerialPortName,
  listHostSerialPorts,
  parseWindowsSerialComm,
  toolProcessOptions,
  toolchainHostSupported,
  type PortListingIo,
} from "./platform.js";

const io = (dev: string[], reg: string): PortListingIo => ({
  readDevDirectory: async () => dev,
  queryWindowsSerialComm: async () => reg,
});

const REG_OUTPUT = `
HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM
    \\Device\\USBSER000    REG_SZ    COM5
    \\Device\\Serial0    REG_SZ    COM1
    \\Device\\USBSER001    REG_SZ    COM12
`;

describe("serial port names", () => {
  it("accepts each OS's real port names", () => {
    for (const port of ["/dev/cu.usbmodem1101", "/dev/cu.usbserial-1410", "/dev/ttyACM0", "/dev/ttyUSB12", "COM5", "COM123"]) {
      expect(isSerialPortName(port)).toBe(true);
    }
  });

  it("rejects paths, injection and lookalikes", () => {
    for (const port of [
      "/dev/tty.usbmodem1101",
      "/dev/ttyS0",
      "/dev/cu.usbmodem1101;reboot",
      "/dev/cu.usbmodem1101/../../etc/passwd",
      "/dev/ttyACM0 --force",
      "COM5;calc",
      "com5",
      "COM1234",
      "\\\\.\\COM5",
      "/tmp/ttyACM0",
      "",
    ]) {
      expect(isSerialPortName(port)).toBe(false);
    }
  });
});

describe("port listing per OS", () => {
  const dev = ["cu.usbmodem1101", "cu.Bluetooth-Incoming-Port", "tty.usbmodem1101", "ttyACM0", "ttyUSB1", "ttyS0"];

  it("macOS lists only call-out USB devices", async () => {
    expect(await listHostSerialPorts("darwin", io(dev, ""))).toEqual(["/dev/cu.usbmodem1101"]);
  });

  it("Linux lists ACM and USB serial devices", async () => {
    expect(await listHostSerialPorts("linux", io(dev, ""))).toEqual(["/dev/ttyACM0", "/dev/ttyUSB1"]);
  });

  it("Windows reads COM ports from the registry, in numeric order", async () => {
    expect(await listHostSerialPorts("win32", io([], REG_OUTPUT))).toEqual(["COM1", "COM5", "COM12"]);
    expect(parseWindowsSerialComm("garbage")).toEqual([]);
  });

  it("an unsupported OS or failed lookup gives an empty list", async () => {
    expect(filterDevicePortNames(dev, "freebsd")).toEqual([]);
    const failing: PortListingIo = { readDevDirectory: async () => { throw new Error("denied"); }, queryWindowsSerialComm: async () => { throw new Error("no reg"); } };
    expect(await listHostSerialPorts("linux", failing)).toEqual([]);
    expect(await listHostSerialPorts("win32", failing)).toEqual([]);
  });
});

describe("process handling and toolchain support", () => {
  it("detaches on POSIX only", () => {
    expect(toolProcessOptions("darwin").detached).toBe(true);
    expect(toolProcessOptions("linux").detached).toBe(true);
    expect(toolProcessOptions("win32").detached).toBe(false);
  });

  it("keeps building and flashing off on Windows until it has its own runner", () => {
    expect(toolchainHostSupported("darwin")).toBe(true);
    expect(toolchainHostSupported("linux")).toBe(true);
    expect(toolchainHostSupported("win32")).toBe(false);
  });
});
