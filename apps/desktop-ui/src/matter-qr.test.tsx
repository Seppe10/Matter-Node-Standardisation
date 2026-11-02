/**
 * @vitest-environment happy-dom
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingDecision } from "@iotedu/contracts";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async (payload: string) => `data:image/png,${encodeURIComponent(payload)}`),
  },
}));

import QRCode from "qrcode";
import { MatterCommissioningPanel } from "./MatterCommissioningPanel";
import { clearCommissioningQrCache } from "./matter-qr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = () => vi.mocked(QRCode.toDataURL).mock.calls.length;

function decision(overrides: Partial<OnboardingDecision> = {}): OnboardingDecision {
  return {
    show: true,
    payload: "MT:DEVICE-A",
    manualCode: "11112223333",
    reason: "Printed by this device.",
    windowWarning: null,
    ...overrides,
  };
}

function props(overrides: Partial<Parameters<typeof MatterCommissioningPanel>[0]> = {}) {
  return {
    deviceKey: "aa:bb:cc:dd:ee:01",
    deviceName: "Bench sensor",
    deviceIdentifier: "aa:bb:cc:dd:ee:01",
    status: "Uncommissioned",
    windowNow: "open" as const,
    decision: decision(),
    ...overrides,
  };
}

function element(next: Parameters<typeof MatterCommissioningPanel>[0]) {
  return <MemoryRouter><MatterCommissioningPanel {...next} /></MemoryRouter>;
}

async function render(next: Parameters<typeof MatterCommissioningPanel>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element(next));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

describe("Matter commissioning QR", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    clearCommissioningQrCache();
    vi.mocked(QRCode.toDataURL).mockClear();
  });

  afterEach(() => {
    while (roots.length > 0) roots.pop()?.unmount();
    document.body.innerHTML = "";
  });

  it("renders one stable code for the selected device", async () => {
    const first = await render(props());
    roots.push(first.root);
    const image = document.querySelector("img");
    expect(image?.getAttribute("src")).toBe(`data:image/png,${encodeURIComponent("MT:DEVICE-A")}`);
    expect(image?.getAttribute("width")).toBe("220");
    expect(image?.getAttribute("height")).toBe("220");
    expect(document.querySelector(".matter-commissioning h2")?.textContent).toBe("Matter Commissioning");
    expect(document.body.textContent).toContain("Bench sensor");
    expect(document.body.textContent).toContain("aa:bb:cc:dd:ee:01");
    expect(document.body.textContent).toContain("11112223333");
    expect(document.body.textContent).toContain("Commissioning window observed open");
    expect(calls()).toBe(1);

    await act(async () => {
      first.root.render(element(props({ status: "Still uncommissioned" })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls()).toBe(1);
    expect(document.querySelector("img")?.getAttribute("src")).toContain("MT%3ADEVICE-A");

    first.root.unmount();
    roots.pop();
    const again = await render(props());
    roots.push(again.root);
    expect(calls()).toBe(1);
    expect(document.querySelector("img")?.getAttribute("src")).toContain("DEVICE-A");
  });

  it("switches devices without reusing the previous payload", async () => {
    const view = await render(props());
    roots.push(view.root);
    await act(async () => {
      view.root.render(element(props({
        deviceKey: "aa:bb:cc:dd:ee:02",
        deviceName: "Second board",
        deviceIdentifier: "aa:bb:cc:dd:ee:02",
        decision: decision({ payload: "MT:DEVICE-B", manualCode: "44445556666" }),
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    const image = document.querySelector("img");
    expect(image?.getAttribute("src")).toContain("DEVICE-B");
    expect(image?.getAttribute("src")).not.toContain("DEVICE-A");
    expect(image?.getAttribute("alt")).toContain("Second board");
    expect(document.body.textContent).toContain("44445556666");
    expect(document.body.textContent).not.toContain("11112223333");
    expect(calls()).toBe(2);
  });

  it("keeps a closed window visible and hides a missing code", async () => {
    const expired = await render(props({
      windowNow: "closed",
      decision: decision({ windowWarning: "The commissioning window was closed in the captured log." }),
    }));
    roots.push(expired.root);
    expect(document.querySelector(".matter-qr-frame")?.getAttribute("data-state")).toBe("valid");
    expect(document.querySelector("img")?.getAttribute("src")).toContain("DEVICE-A");
    expect(document.body.textContent).toContain("Commissioning window closed");
    expect(document.body.textContent).toContain("does not mean the commissioning window is open");
    expect(document.body.textContent).toContain("11112223333");
    expect(calls()).toBe(1);

    await act(async () => {
      expired.root.render(element(props({
        windowNow: null,
        decision: decision({ show: false, payload: null, manualCode: null, reason: "No pairing code is invented." }),
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector(".matter-qr-frame")?.getAttribute("data-state")).toBe("unavailable");
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("No pairing code is invented.");
    expect(document.body.textContent).not.toContain("Open commissioning window");
    expect(calls()).toBe(1);
  });

  it("labels an original setup code and hides an expired multi-admin window", async () => {
    const openedAt = "2026-11-01T00:00:00.000Z";
    const active = await render(props({
      commissioned: true,
      windowNow: "closed",
      decision: decision({ windowWarning: "Original setup code. Showing the stored code does not open a commissioning window." }),
      sharingWindow: { payload: "MT:WINDOW", manualCode: "99990001111", openedAt, durationSeconds: 180 },
      now: Date.parse(openedAt) + 10_000,
      canOpenWindow: true,
      onOpenWindow: () => undefined,
    }));
    roots.push(active.root);
    expect(document.querySelector(".matter-qr-frame")?.getAttribute("data-credential")).toBe("window");
    expect(document.querySelector("img")?.getAttribute("src")).toContain("WINDOW");
    expect(document.body.textContent).toContain("99990001111");
    expect(document.body.textContent).toContain("Commissioning window expires");
    expect(document.body.textContent).not.toContain("11112223333");
    expect(document.body.textContent).toContain("Open commissioning window");
    expect(calls()).toBe(1);

    await act(async () => {
      active.root.render(element(props({
        commissioned: true,
        windowNow: "closed",
        decision: decision({ windowWarning: "Original setup code. Showing the stored code does not open a commissioning window." }),
        sharingWindow: { payload: "MT:WINDOW", manualCode: "99990001111", openedAt, durationSeconds: 180 },
        now: Date.parse(openedAt) + 181_000,
        canOpenWindow: true,
        onOpenWindow: () => undefined,
      })));
      await Promise.resolve();
    });
    expect(document.querySelector(".matter-qr-frame")?.getAttribute("data-credential")).toBe("original");
    expect(document.querySelector("img")?.getAttribute("src")).toContain("DEVICE-A");
    expect(document.body.textContent).toContain("Original setup code");
    expect(document.body.textContent).toContain("11112223333");
    expect(document.body.textContent).toContain("has expired");
    expect(document.body.textContent).not.toContain("99990001111");
    expect(calls()).toBe(2);

    await act(async () => {
      active.root.render(element(props({
        commissioned: true,
        windowNow: "closed",
        status: "Still commissioned",
        decision: decision({ windowWarning: "Original setup code. Showing the stored code does not open a commissioning window." }),
        sharingWindow: { payload: "MT:WINDOW", manualCode: "99990001111", openedAt, durationSeconds: 180 },
        now: Date.parse(openedAt) + 181_000,
        canOpenWindow: true,
        onOpenWindow: () => undefined,
      })));
      await Promise.resolve();
    });
    expect(calls()).toBe(2);
  });

  it("explains a fabric without a usable code and a device with no payload", async () => {
    const open = vi.fn();
    const fabric = await render(props({
      commissioned: true,
      windowNow: "closed",
      decision: decision({ show: false, payload: null, manualCode: null, reason: "Add IoT.Edu from Pair New Node with a new code from the existing administrator." }),
      onOpenWindow: open,
    }));
    roots.push(fabric.root);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".matter-qr-frame")?.getAttribute("data-state")).toBe("unavailable");
    expect(document.body.textContent).toContain("new code from the existing administrator");
    expect(document.body.textContent).toContain("Continue with Pair New Node");
    expect(document.body.textContent).not.toContain("Open commissioning window");
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      fabric.root.render(element(props({
        commissioned: false,
        windowNow: null,
        decision: decision({ show: false, payload: null, manualCode: null, reason: "No stored Matter onboarding payload is available for this device." }),
      })));
      await Promise.resolve();
    });
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("No stored Matter onboarding payload");
    expect(document.body.textContent).not.toContain("Continue with Pair New Node");
  });

  it("stays above the setup guide and does not request a commissioning window", async () => {
    const page = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "pages/SmartHomePage.tsx"), "utf8");
    const panel = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "MatterCommissioningPanel.tsx"), "utf8");
    expect(page.indexOf("<MatterCommissioningPanel")).toBeGreaterThan(page.indexOf("<WorkflowStrip"));
    expect(page.indexOf("<MatterCommissioningPanel")).toBeLessThan(page.indexOf("Begin Apple Home Setup Guide"));
    expect(page).not.toContain("verified firmware record");
    expect(page).toContain("/commissioning-window");
    expect(page).not.toMatch(/useEffect\(\(\) => \{[^}]*commissioning-window/);
    expect(page).not.toContain("<img");
    expect(panel).not.toContain("commissioning-window");
    expect(panel).not.toContain("factory");
    expect(panel).not.toContain("/api/");
  });
});
