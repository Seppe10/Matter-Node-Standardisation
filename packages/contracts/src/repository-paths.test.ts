import path from "node:path";
import { describe, expect, it } from "vitest";
import { configuredFirmwareArchive, expandHomePath } from "./repository-paths.js";

describe("home-folder paths", () => {
  it("expands a leading ~ using HOME or USERPROFILE", () => {
    expect(expandHomePath("~/iotedu-archive", { HOME: "/home/alex" })).toBe(path.join("/home/alex", "iotedu-archive"));
    expect(expandHomePath("~\\iotedu-archive", { USERPROFILE: "C:\\Users\\alex" })).toBe(path.join("C:\\Users\\alex", "iotedu-archive"));
    expect(expandHomePath("~", { HOME: "/home/alex" })).toBe(path.join("/home/alex"));
  });

  it("leaves other paths alone", () => {
    for (const value of ["/abs/archive", "C:\\iotedu-archive", "relative/dir", "~other/dir", ""]) {
      expect(expandHomePath(value, { HOME: "/home/alex" })).toBe(value);
    }
    expect(expandHomePath("~/x", {})).toBe("~/x");
  });

  it("applies to the firmware archive setting", () => {
    expect(configuredFirmwareArchive({ HOME: "/home/alex", IOTEDU_FIRMWARE_ARCHIVE: " ~/iotedu-archive " })).toBe(path.join("/home/alex", "iotedu-archive"));
    expect(configuredFirmwareArchive({})).toBe("");
  });
});
