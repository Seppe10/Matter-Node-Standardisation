import type { HardwareInstallation, ProgramSession } from "@iotedu/contracts";
import { commissioningFromLog, compiledTestOnboarding, decodeMatterPayload, macFromDeviceLog, readDeviceOnboarding } from "@iotedu/contracts";

export const PROGRAM_SESSION_HISTORY_LIMIT = 50;
export const PROGRAM_SESSION_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredDeviceOnboarding {
  id: string;
  qrPayload: string;
  manualCode: string;
  commissioningState: "uncommissioned" | "commissioned" | "unknown";
  windowNow: "open" | "closed" | "unknown";
  vendorId: number | null;
  productId: number | null;
  updatedAt: string;
}

type HistorySession = Pick<ProgramSession, "status" | "stage" | "updatedAt" | "createdAt" | "id">;

export function programSessionIsActive(session: Pick<ProgramSession, "status" | "stage">): boolean {
  return session.status === "running" || session.stage === "writing" || session.stage === "monitoring";
}

/** Keep every active session. Completed sessions are capped and expire after 30 days. */
export function retainProgramSessions<T extends HistorySession>(sessions: T[], now = Date.now()): T[] {
  const active = sessions.filter((session) => programSessionIsActive(session));
  const activeIds = new Set(active.map((session) => session.id));
  const cutoff = now - PROGRAM_SESSION_HISTORY_MS;
  const completed = sessions
    .filter((session) => !activeIds.has(session.id))
    .filter((session) => {
      const at = Date.parse(session.updatedAt || session.createdAt);
      return Number.isFinite(at) && at >= cutoff;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, PROGRAM_SESSION_HISTORY_LIMIT);
  return [...active, ...completed];
}

export function onboardingFromSession(session: Partial<Pick<ProgramSession, "monitorLog" | "deviceOnboarding" | "baseMac" | "updatedAt">>): StoredDeviceOnboarding | null {
  const printed = readDeviceOnboarding(session.monitorLog ?? "");
  const qrPayload = session.deviceOnboarding?.qrPayload || printed.qrPayload || "";
  const manualCode = session.deviceOnboarding?.manualCode || printed.manualCode || "";
  const decoded = qrPayload && manualCode ? decodeMatterPayload(qrPayload, manualCode) : null;
  if (!decoded?.manualCodeMatches) return null;
  const mac = (session.baseMac || macFromDeviceLog(session.monitorLog ?? "") || "").toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  const commissioning = commissioningFromLog(session.monitorLog ?? "");
  return {
    id: mac,
    qrPayload,
    manualCode,
    commissioningState: commissioning.state,
    windowNow: commissioning.windowNow,
    vendorId: decoded.vendorId,
    productId: decoded.productId,
    updatedAt: session.updatedAt ?? "",
  };
}

const HARDWARE_MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

export interface ProvenHardwareLink {
  fromId: string;
  toId: string;
  evidence: "same-capture-base-and-bluetooth";
}

/**
 * Move a stored payload only when one capture recorded both MAC forms for the same chip.
 * A shared name, board, or product is not evidence. An occupied destination is left unchanged.
 */
export function migrateStoredOnboarding(
  records: StoredDeviceOnboarding[],
  links: ProvenHardwareLink[],
): { records: StoredDeviceOnboarding[]; migrated: string[] } {
  const next = records.map((record) => ({ ...record, id: record.id.toLowerCase() }));
  const migrated: string[] = [];
  for (const link of links) {
    if (link.evidence !== "same-capture-base-and-bluetooth") continue;
    const from = link.fromId.toLowerCase();
    const to = link.toId.toLowerCase();
    if (!HARDWARE_MAC.test(from) || !HARDWARE_MAC.test(to) || from === to) continue;
    const sources = next.filter((record) => record.id === from);
    if (sources.length !== 1 || next.some((record) => record.id === to)) continue;
    sources[0]!.id = to;
    migrated.push(from);
  }
  return { records: next, migrated };
}

export function verifiedDevelopmentOnboarding(input: {
  mac: string;
  vendorId: number | null;
  productId: number | null;
  verification: { status: string };
  commissioningState: StoredDeviceOnboarding["commissioningState"];
  updatedAt: string;
}): StoredDeviceOnboarding | null {
  if (input.verification.status !== "verified" || input.commissioningState === "commissioned") return null;
  const compiled = compiledTestOnboarding(input.vendorId, input.productId);
  const mac = input.mac.toLowerCase();
  if (!compiled || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  return {
    id: mac,
    qrPayload: compiled.qrPayload,
    manualCode: compiled.manualCode,
    commissioningState: "uncommissioned",
    windowNow: "unknown",
    vendorId: compiled.vendorId,
    productId: compiled.productId,
    updatedAt: input.updatedAt,
  };
}

/** Keep a stored passcode when a later development payload would replace it. */
export function keepDistinctPasscode(existing: StoredDeviceOnboarding[], incoming: StoredDeviceOnboarding): StoredDeviceOnboarding[] {
  const current = existing.find((record) => record.id === incoming.id);
  if (current) {
    const previous = decodeMatterPayload(current.qrPayload, current.manualCode);
    const next = decodeMatterPayload(incoming.qrPayload, incoming.manualCode);
    if (!previous || !next || previous.passcode !== next.passcode) return existing;
  }
  return mergeStoredOnboarding(existing, [incoming]);
}

export function mergeStoredOnboarding(existing: StoredDeviceOnboarding[], incoming: StoredDeviceOnboarding[]): StoredDeviceOnboarding[] {
  const byMac = new Map<string, StoredDeviceOnboarding>();
  for (const record of [...existing, ...incoming]) {
    const current = byMac.get(record.id);
    if (!current || record.updatedAt >= current.updatedAt) byMac.set(record.id, record);
  }
  return [...byMac.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function installationFromStoredOnboarding(record: StoredDeviceOnboarding): HardwareInstallation {
  return {
    mac: record.id,
    macSource: "stored_session",
    identityDetail: "Stored onboarding payload for this device. No firmware record is required.",
    programmingPort: "",
    consolePort: null,
    buildId: "",
    sessionId: `onboarding:${record.id}`,
    softwareVersion: null,
    softwareVersionString: "",
    vendorId: record.vendorId,
    productId: record.productId,
    writeCompleted: false,
    bootVerified: false,
    matterReady: false,
    matterStartup: "unknown",
    nvsPreserved: true,
    threadReady: false,
    versionVerified: false,
    dht11: "unknown",
    commissioningState: record.commissioningState,
    commissioningWindowOpen: record.windowNow === "open" ? true : record.windowNow === "closed" ? false : null,
    windowNow: record.windowNow,
    lastWindowEvent: null,
    bleAdvertisingObserved: false,
    dnsSdWarning: null,
    appleHomeFabric: false,
    fabricVendors: [],
    managedNodeId: null,
    commissioningDetail: record.commissioningState === "commissioned"
      ? "A Matter fabric was recorded for this device. The stored onboarding code is shown separately from the commissioning window."
      : "Stored onboarding payload. Displaying it does not open a commissioning window.",
    commissioningObservedAt: record.updatedAt,
    onboardingStatus: "not_verified",
    onboardingReason: "Stored device onboarding payload.",
    onboardingPayload: "unknown",
    firmwareImageIdentity: "unknown",
    discriminatorEvidence: "absent",
    deviceOnboarding: { qrPayload: record.qrPayload, manualCode: record.manualCode },
    flashImages: [],
    startedAt: record.updatedAt,
    elapsedSeconds: null,
    updatedAt: record.updatedAt,
  };
}
