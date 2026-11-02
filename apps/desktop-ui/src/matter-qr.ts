import QRCode from "qrcode";
import type { OnboardingDecision } from "@iotedu/contracts";

export type CommissioningWindow = "open" | "closed" | "unknown" | null;

export interface CommissioningPresentation {
  state: "valid" | "expired" | "unavailable";
  credential: "setup" | "original" | "window" | "none";
  label: string;
  payload: string | null;
  manualCode: string | null;
  expiry: string;
  detail: string;
}

export interface SharingWindowView {
  payload: string;
  manualCode: string;
  openedAt: string;
  durationSeconds: number;
}

const qrCache = new Map<string, string>();

function cacheKey(deviceKey: string, payload: string): string {
  return `${deviceKey}\n${payload}`;
}

export function peekCommissioningQr(deviceKey: string, payload: string): string | null {
  return qrCache.get(cacheKey(deviceKey, payload)) ?? null;
}

/** Render a payload once per device. A rerender or a later visit reuses the same image. */
export function commissioningQrUrl(deviceKey: string, payload: string): Promise<string> {
  const key = cacheKey(deviceKey, payload);
  const cached = qrCache.get(key);
  if (cached) return Promise.resolve(cached);
  return QRCode.toDataURL(payload, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then((url) => {
    qrCache.set(key, url);
    return url;
  });
}

export function clearCommissioningQrCache(): void {
  qrCache.clear();
}

export function sharingWindowTiming(window: SharingWindowView, now = Date.now()): { active: boolean; expiresAt: string; remainingSeconds: number } | null {
  const opened = Date.parse(window.openedAt);
  if (!window.payload || !window.manualCode || !Number.isFinite(opened) || !Number.isInteger(window.durationSeconds) || window.durationSeconds <= 0) return null;
  const expiresAtMs = opened + window.durationSeconds * 1000;
  const remainingSeconds = Math.floor((expiresAtMs - now) / 1000);
  return { active: remainingSeconds > 0, expiresAt: new Date(expiresAtMs).toISOString(), remainingSeconds };
}

export function commissioningPresentation(input: {
  windowNow: CommissioningWindow;
  decision: OnboardingDecision;
  commissioned?: boolean;
  sharingWindow?: SharingWindowView | null;
  now?: number;
}): CommissioningPresentation {
  const commissioned = input.commissioned === true;
  const timing = input.sharingWindow ? sharingWindowTiming(input.sharingWindow, input.now) : null;
  if (input.sharingWindow && timing?.active) {
    return {
      state: "valid",
      credential: "window",
      label: "Commissioning window code",
      payload: input.sharingWindow.payload,
      manualCode: input.sharingWindow.manualCode,
      expiry: `Commissioning window expires ${timing.expiresAt}`,
      detail: "This is a new multi-admin commissioning code. It is not the original setup code.",
    };
  }
  const expiredNote = input.sharingWindow && timing && !timing.active
    ? "The multi-admin commissioning window has expired. That code is not usable."
    : input.sharingWindow && !timing
      ? "The commissioning window did not include a usable expiry. Its code is not shown."
      : null;
  if (input.decision.show && input.decision.payload && input.decision.manualCode) {
    const shared = /shared development setup code/i.test(input.decision.reason);
    const notes = [
      expiredNote,
      input.decision.reason,
      input.decision.windowWarning,
      !commissioned && input.windowNow === "closed" ? "Showing this stored code does not mean the commissioning window is open." : null,
    ].filter((note): note is string => Boolean(note));
    return {
      state: "valid",
      credential: commissioned ? "original" : "setup",
      label: commissioned ? "Original setup code" : shared ? "Shared development setup code" : "Setup code",
      payload: input.decision.payload,
      manualCode: input.decision.manualCode,
      expiry: commissioned
        ? "Original setup code. Not an active commissioning window."
        : input.windowNow === "closed"
          ? "Commissioning window closed"
          : input.windowNow === "open"
            ? "Commissioning window observed open"
            : "Commissioning window not verified as open",
      detail: notes.join(" ") || input.decision.reason,
    };
  }
  if (expiredNote) {
    return {
      state: "expired",
      credential: "none",
      label: "Commissioning window expired",
      payload: null,
      manualCode: null,
      expiry: "Commissioning window expired",
      detail: expiredNote,
    };
  }
  return {
    state: "unavailable",
    credential: "none",
    label: commissioned ? "No usable commissioning code" : "No onboarding payload",
    payload: null,
    manualCode: null,
    expiry: input.windowNow === "open" ? "Commissioning window observed open" : "No valid commissioning payload",
    detail: input.decision.reason,
  };
}
