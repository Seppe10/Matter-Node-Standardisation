import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compiledTestOnboarding, hardwareInstallationSchema } from "@iotedu/contracts";
import { describe, expect, it } from "vitest";
import { JsonJobRepository } from "./store.js";
import {
  PROGRAM_SESSION_HISTORY_LIMIT,
  installationFromStoredOnboarding,
  keepDistinctPasscode,
  mergeStoredOnboarding,
  migrateStoredOnboarding,
  verifiedDevelopmentOnboarding,
  onboardingFromSession,
  programSessionIsActive,
  retainProgramSessions,
  type StoredDeviceOnboarding,
} from "./session-history.js";

const now = Date.parse("2026-11-01T00:00:00.000Z");
const recent = "2026-10-20T00:00:00.000Z";
const stale = "2026-09-01T00:00:00.000Z";

function session(id: string, overrides: Partial<{ status: "running" | "succeeded" | "failed" | "interrupted"; stage: "writing" | "monitoring" | "idle"; updatedAt: string }> = {}) {
  return {
    id,
    status: overrides.status ?? "succeeded",
    stage: overrides.stage ?? "idle",
    createdAt: overrides.updatedAt ?? recent,
    updatedAt: overrides.updatedAt ?? recent,
  };
}

describe("USB programming session retention", () => {
  it("keeps active sessions and drops completed sessions that are old or beyond the cap", () => {
    const running = session("running", { status: "running", stage: "writing", updatedAt: stale });
    const monitoring = session("monitoring", { status: "succeeded", stage: "monitoring", updatedAt: stale });
    const old = session("old", { updatedAt: stale });
    const kept = retainProgramSessions([running, monitoring, old, ...Array.from({ length: 60 }, (_, index) => session(`done-${index}`, { updatedAt: recent }))], now);
    expect(programSessionIsActive(running)).toBe(true);
    expect(kept.map((item) => item.id)).toContain("running");
    expect(kept.map((item) => item.id)).toContain("monitoring");
    expect(kept.map((item) => item.id)).not.toContain("old");
    expect(kept.filter((item) => item.id.startsWith("done-"))).toHaveLength(PROGRAM_SESSION_HISTORY_LIMIT);
    expect(kept).toHaveLength(PROGRAM_SESSION_HISTORY_LIMIT + 2);
  });

  it("persists a new session and remembers onboarding from a session that retention removes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "iotedu-session-history-"));
    const compiled = compiledTestOnboarding(0xfff1, 0x8000);
    expect(compiled).not.toBeNull();
    const onboardingFile = path.join(directory, "device-onboarding.json");
    const onboarding = new JsonJobRepository<StoredDeviceOnboarding>(onboardingFile, { tolerant: true });
    const sessions = new JsonJobRepository<ReturnType<typeof session> & { monitorLog: string; deviceOnboarding: { qrPayload: string; manualCode: string } | null; baseMac: string | null }>(path.join(directory, "programmer-sessions.json"), {
      tolerant: true,
      retain: (items) => retainProgramSessions(items, now),
      beforeWrite: async (items) => {
        const remembered = items.flatMap((item) => {
          const record = onboardingFromSession(item);
          return record ? [record] : [];
        });
        if (remembered.length === 0) return;
        await onboarding.replace(mergeStoredOnboarding(await onboarding.list(), remembered));
      },
    });
    await writeFile(sessionsFile(directory), JSON.stringify([session("stale", { updatedAt: stale })]));
    await sessions.save({
      ...session("printed", { updatedAt: stale }),
      monitorLog: `Bluetooth MAC: 10:51:db:68:64:4c\nSetupQRCode: [${compiled?.qrPayload}]\nManual pairing code: [${compiled?.manualCode}]`,
      deviceOnboarding: { qrPayload: compiled?.qrPayload ?? "", manualCode: compiled?.manualCode ?? "" },
      baseMac: "10:51:db:68:64:4c",
    });
    expect((await sessions.list()).map((item) => item.id)).not.toContain("printed");
    const stored = await onboarding.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe("10:51:db:68:64:4c");
    expect(hardwareInstallationSchema.parse(installationFromStoredOnboarding(stored[0]!)).deviceOnboarding?.qrPayload).toBe(compiled?.qrPayload);
    await sessions.save({
      ...session("active", { status: "running", stage: "writing", updatedAt: stale }),
      monitorLog: "",
      deviceOnboarding: null,
      baseMac: null,
    });
    expect((await sessions.list()).map((item) => item.id)).toContain("active");
    expect(JSON.parse(await readFile(onboardingFile, "utf8"))).toHaveLength(1);
    await writeFile(sessionsFile(directory), "[]\n");
    expect(JSON.parse(await readFile(onboardingFile, "utf8"))).toHaveLength(1);
    await writeFile(onboardingFile, "{");
    const reread = new JsonJobRepository<StoredDeviceOnboarding>(onboardingFile, { tolerant: true });
    expect(await reread.list()).toEqual([]);
  });

  it("migrates a payload only when one capture proves both hardware identifiers", () => {
    const compiled = compiledTestOnboarding(0xfff1, 0x8002);
    const record: StoredDeviceOnboarding = {
      id: "10:51:db:68:64:4c",
      qrPayload: compiled?.qrPayload ?? "",
      manualCode: compiled?.manualCode ?? "",
      commissioningState: "uncommissioned",
      windowNow: "unknown",
      vendorId: 0xfff1,
      productId: 0x8002,
      updatedAt: recent,
    };
    const other: StoredDeviceOnboarding = { ...record, id: "48:31:b7:cf:37:b7", productId: 0x8000 };
    expect(migrateStoredOnboarding([record], [{ fromId: "aa:bb:cc:dd:ee:01", toId: "aa:bb:cc:dd:ee:02", evidence: "same-capture-base-and-bluetooth" }]).migrated).toEqual([]);
    expect(migrateStoredOnboarding([record, other], [{ fromId: record.id, toId: other.id, evidence: "same-capture-base-and-bluetooth" }]).records.map((item) => item.id)).toEqual([record.id, other.id]);
    const moved = migrateStoredOnboarding([record], [{ fromId: "10:51:DB:68:64:4C", toId: "10:51:db:68:64:4e", evidence: "same-capture-base-and-bluetooth" }]);
    expect(moved.migrated).toEqual(["10:51:db:68:64:4c"]);
    expect(moved.records[0]?.id).toBe("10:51:db:68:64:4e");
    expect(moved.records[0]?.qrPayload).toBe(record.qrPayload);
    expect(migrateStoredOnboarding([record, { ...record }], [{ fromId: record.id, toId: "10:51:db:68:64:4e", evidence: "same-capture-base-and-bluetooth" }]).migrated).toEqual([]);
  });

  it("stores a verified development payload and does not replace a different passcode", () => {
    const compiled = compiledTestOnboarding(0xfff1, 0x8000);
    const saved = verifiedDevelopmentOnboarding({
      mac: "48:31:B7:CF:37:5F",
      vendorId: 0xfff1,
      productId: 0x8000,
      verification: { status: "verified" },
      commissioningState: "uncommissioned",
      updatedAt: recent,
    });
    expect(saved?.id).toBe("48:31:b7:cf:37:5f");
    expect(saved?.qrPayload).toBe(compiled?.qrPayload);
    expect(verifiedDevelopmentOnboarding({
      mac: "48:31:b7:cf:37:5f",
      vendorId: 0xfff1,
      productId: 0x8000,
      verification: { status: "not_verified" },
      commissioningState: "uncommissioned",
      updatedAt: recent,
    })).toBeNull();
    expect(verifiedDevelopmentOnboarding({
      mac: "48:31:b7:cf:37:5f",
      vendorId: 0xfff1,
      productId: 0x8000,
      verification: { status: "verified" },
      commissioningState: "commissioned",
      updatedAt: recent,
    })).toBeNull();
    const existing = { ...saved!, qrPayload: "MT:OTHER", manualCode: "34970112332" };
    expect(keepDistinctPasscode([existing], saved!).find((item) => item.id === saved?.id)?.qrPayload).toBe("MT:OTHER");
    expect(keepDistinctPasscode([], saved!)).toHaveLength(1);
  });
});

function sessionsFile(directory: string): string {
  return path.join(directory, "programmer-sessions.json");
}
