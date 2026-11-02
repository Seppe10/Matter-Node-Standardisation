import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { CommissioningWindowResult, HardwareInstallation, ManagedNode } from "@iotedu/contracts";
import { smartHomeCommissioningCopy } from "@iotedu/contracts";
import { api } from "../api";
import { formatLocalDateTime } from "../datetime";
import { MatterCommissioningPanel } from "../MatterCommissioningPanel";
import type { SharingWindowView } from "../matter-qr";
import { nodeOptionLabel } from "../selection";
import { decisionForChoice, deviceIsCommissioned, smartHomeChoices } from "../smart-home-devices";
import { sameHardwareMac } from "../setup";
import { historicalDeviceSeed, identityLabel, selectSmartHomeInstallation } from "../setup-flow";
import { useSetup } from "../use-setup";
import { WorkflowStrip } from "../WorkflowStrip";

interface LiveRead {
  liveRead: "unavailable" | "read" | "failed";
  message: string;
  node: ManagedNode;
}

export function SmartHomePage() {
  const [params] = useSearchParams();
  const [nodes, setNodes] = useState<ManagedNode[]>([]);
  const [installations, setInstallations] = useState<HardwareInstallation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<LiveRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenMac, setChosenMac] = useState<string | null>(null);
  const [windows, setWindows] = useState<Record<string, SharingWindowView>>({});
  const [openingWindow, setOpeningWindow] = useState(false);
  const { view, update } = useSetup(nodes);
  const requestedMac = (params.get("mac") ?? "").toLowerCase();
  const historyView = params.get("history") === "1";
  const selection = selectSmartHomeInstallation({
    installations,
    activeMac: view.deviceMac,
    urlMac: requestedMac || null,
    history: historyView,
  });
  const choices = smartHomeChoices(installations, nodes);
  const selectedMac = (historyView ? requestedMac : chosenMac ?? view.deviceMac ?? "").toLowerCase();
  const choice = choices.find((item) => item.mac === selectedMac) ?? null;
  const installation = choice?.installation ?? null;
  const associated = choice?.node ?? nodes.find((node) => installation?.mac && node.hardwareMac && sameHardwareMac(node.hardwareMac, installation.mac)) ?? null;
  const needsRecheck = associated?.operationalReverification === "required";
  const live = associated?.matterNodeId && !needsRecheck ? associated : null;
  const current = checked && associated && checked.node.id === associated.id ? checked.node : associated;
  const reachableNow = checked?.liveRead === "read" && checked.node.id === associated?.id && checked.node.presence === "online";
  const commissioning = installation
    ? smartHomeCommissioningCopy({
      state: installation.commissioningState,
      windowNow: installation.windowNow,
      detail: installation.commissioningDetail,
      fabricVendors: installation.fabricVendors,
    })
    : null;
  const onboarding = decisionForChoice(choice, !selectedMac || selection.mode === "unresolved");
  const commissioned = deviceIsCommissioned(choice, installation);
  const sharingWindow = choice ? windows[choice.mac] ?? null : null;
  const firmwareLabel = installation
    ? `${installation.softwareVersionString}${installation.softwareVersion != null ? ` / SoftwareVersion ${installation.softwareVersion}` : ""}`
    : current?.softwareVersionString
      ? `${current.softwareVersionString}${current.softwareVersion != null ? ` / SoftwareVersion ${current.softwareVersion}` : ""}`
      : "Not Verified";

  useEffect(() => {
    Promise.all([
      api<{ nodes: ManagedNode[] }>("/api/nodes"),
      api<{ installations: HardwareInstallation[] }>("/api/hardware/installations"),
    ])
      .then(([nodeBody, installationBody]) => {
        setNodes(nodeBody.nodes);
        setInstallations(installationBody.installations);
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  useEffect(() => {
    if (view.deviceMac || installations.length === 0) return;
    const seed = historicalDeviceSeed(installations);
    if (!seed?.mac) return;
    update({
      deviceMac: seed.mac,
      deviceIdentity: "historical",
      deviceProbeSource: "boot_log",
      deviceProbeAt: null,
      deviceSessionId: seed.sessionId,
      hardware: "not_verified",
    });
    // The setter reads the latest setup record. Seeding stops once deviceMac is stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installations, view.deviceMac]);

  async function checkConnection() {
    if (!live) return;
    setBusy(true);
    setError(null);
    try {
      const body = await api<LiveRead>(`/api/nodes/${live.id}/refresh`, { method: "POST" });
      setChecked(body);
      setNodes((currentNodes) => currentNodes.map((node) => node.id === body.node.id ? body.node : node));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The management read failed");
    } finally {
      setBusy(false);
    }
  }

  async function openWindow() {
    if (!choice?.node?.matterNodeId || choice.node.simulated) return;
    setOpeningWindow(true);
    setError(null);
    try {
      const body = await api<CommissioningWindowResult>(`/api/nodes/${choice.node.id}/commissioning-window`, { method: "POST" });
      if (!body.opened || !body.qrPairingCode || !body.manualPairingCode || !body.durationSeconds || !body.openedAt) {
        setError(body.opened
          ? "The commissioning window did not include a code and expiry. The code is not shown."
          : body.message);
        return;
      }
      setWindows((current) => ({
        ...current,
        [choice.mac]: {
          payload: body.qrPairingCode ?? "",
          manualCode: body.manualPairingCode ?? "",
          openedAt: body.openedAt ?? "",
          durationSeconds: body.durationSeconds ?? 0,
        },
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The commissioning window was not opened");
    } finally {
      setOpeningWindow(false);
    }
  }

  function confirmHome() {
    update({ appleHomeConfirmedAt: new Date().toISOString(), smartHome: "completed" });
  }

  return (
    <section className="stack">
      <header className="page-head page-intro">
        <div>
          <h1>Smart Home Connection</h1>
          <p className="lede lede-full">Apple Home is the supported ecosystem on this page. A Home confirmation from the user is not the same as a fabric read.</p>
        </div>
      </header>
      <WorkflowStrip setup={view} />
      <MatterCommissioningPanel
        deviceKey={choice?.mac ?? installation?.mac ?? selection.mode}
        deviceName={choice?.node?.name ?? (installation?.mac ? `ESP32-H2 ${installation.mac}` : selection.mode === "unresolved" ? "No device selected" : current ? nodeOptionLabel(current) : "ESP32-H2")}
        deviceIdentifier={choice?.mac ?? installation?.mac ?? "Not recorded"}
        status={commissioning?.headline ?? (commissioned ? "Existing fabric" : "Current state unknown")}
        windowNow={installation?.windowNow ?? null}
        decision={onboarding}
        commissioned={commissioned}
        sharingWindow={sharingWindow}
        devices={choices.map((item) => ({ mac: item.mac, label: item.label }))}
        onSelectDevice={setChosenMac}
        canOpenWindow={Boolean(choice?.node?.matterNodeId) && !choice?.node?.simulated}
        openingWindow={openingWindow}
        onOpenWindow={() => void openWindow()}
      />
      {selection.mode === "mismatch" && (
        <p className="banner" role="alert">This address names {requestedMac}, a different board from the active device {view.deviceMac}. The page is showing the active device. <Link to={`/smart-home?mac=${encodeURIComponent(requestedMac)}&history=1`}>View {requestedMac} as history</Link>.</p>
      )}
      {selection.mode === "historical" && (
        <p className="banner">This is the historical record for {requestedMac}. It is not the active device.{view.deviceMac ? <> <Link to={`/smart-home?mac=${encodeURIComponent(view.deviceMac)}&source=setup`}>Return to {view.deviceMac}</Link>.</> : null}</p>
      )}
      {selection.mode === "unresolved" && (
        <p className="banner" role="alert">Select or Identify Device. IoT.Edu will not substitute another board's installation.</p>
      )}
      {params.get("firmware") && selection.mode !== "mismatch" && (
        <p className="banner">From Setup: {params.get("name") || "ESP32-H2"}. Firmware {params.get("firmware")}{params.get("softwareVersion") ? ` / SoftwareVersion ${params.get("softwareVersion")}` : ""}{installation?.mac ? `. MAC ${installation.mac}` : ""}. Commissioning continues on this page.</p>
      )}
      {error && <p className="banner bad" role="alert">{error}</p>}
      {installation?.startupStages && installation.startupStages.length > 0 && (
        <section className="background-process" aria-hidden="true">
          <h2>Verification stages</h2>
          <ul>
            {installation.startupStages.map((stage) => (
              <li key={stage.id}>{stage.label}: {stage.status === "passed" ? "Passed" : stage.status === "failed" ? "Failed" : stage.status === "not_reached" ? "Not reached" : stage.status === "not_applicable" ? "Not applicable" : "Not verified"}. {stage.detail}</li>
            ))}
          </ul>
          <p>These stages stay separate. An application boot does not mean the RGB driver, Matter, or commissioning succeeded. This page does not flash, reset, or open a commissioning window.</p>
        </section>
      )}
      <details className="panel">
        <summary>Commissioning diagnostics</summary>
        <ul>
          <li>Device MAC: {installation?.mac ?? "Not recorded for this selection."}</li>
          <li>Installed firmware: {firmwareLabel}. Build {installation?.buildId ?? "Not recorded"}.</li>
          <li>Application boot: {installation?.bootVerified ? "Passed" : "Not verified"}.</li>
          <li>RGB initialisation: {installation?.startupStages?.find((stage) => stage.id === "rgb")?.status ?? "Not recorded"}.</li>
          <li>Matter server: {installation?.matterStartup === "started" ? "The server was observed." : installation?.matterStartup === "failed" ? "The application stopped before the server." : "Not observed. An OpenThread or chip log is not the server."}</li>
          <li>Thread: {installation?.threadReady ? "OpenThread startup was logged. Joining a network was not observed." : "Not observed."}</li>
          <li>Commissioning-data source: the example provider reads preserved NVS before the compiled development values. CHIP shell is not compiled. The USB port prints the log and does not accept Matter commands.</li>
          <li>Onboarding payload: {onboarding.show ? "Available in Matter Commissioning when the window is still valid." : "Not shown."}</li>
          <li>Fabric status: {installation?.commissioningState ?? "Unknown"}.</li>
          <li>Commissioning window: {installation?.windowNow ?? "Unknown"}.</li>
          <li>BLE advertising: {installation?.bleAdvertisingObserved ? "CHIPoBLE advertising was logged in this capture." : "Not observed in this capture."}</li>
          <li>QR availability: {onboarding.reason}</li>
        </ul>
      </details>
      <details className="panel">
        <summary>Selected Node</summary>
        <dl className="facts">
          <div><dt>Identity</dt><dd>{selection.mode === "historical" ? "Previously Identified Device" : selection.mode === "unresolved" ? "Device Identity Unknown" : identityLabel(view.deviceIdentity)}</dd></div>
          <div><dt>Hardware identity source</dt><dd>{view.deviceProbeSource === "chip_id" && view.deviceMac && installation?.mac && sameHardwareMac(view.deviceMac, installation.mac) ? `Previously verified by chip id${view.deviceProbeAt ? ` at ${formatLocalDateTime(view.deviceProbeAt)}` : ""}. This page has not taken a new measurement.` : installation?.identityDetail ?? "Not verified by chip id"}</dd></div>
          <div><dt>Device</dt><dd>{installation?.mac ? `ESP32-H2 ${installation.mac}` : selection.mode === "unresolved" ? "Select or Identify Device" : current ? nodeOptionLabel(current) : "Not Verified"}</dd></div>
          <div><dt>Firmware</dt><dd>{firmwareLabel}</dd></div>
          <div><dt>Firmware validation</dt><dd>{installation?.writeCompleted && installation.bootVerified && installation.versionVerified ? `Application boot verified${installation.softwareVersionString ? ` for ${installation.softwareVersionString}` : ""}. USB installation and flash integrity are separate from Matter startup.` : installation?.bootVerified ? "Application boot was seen. The firmware version was not verified, so this is not accepted as the current image." : "Application boot is not verified."}</dd></div>
          <div><dt>Matter readiness</dt><dd>{installation?.matterStartup === "failed" ? "Matter did not start. The application stopped before the Matter server. The device is not ready to pair." : installation?.matterStartup === "started" || installation?.matterReady ? "Matter startup was seen. This is not commissioning, and it does not show that BLE is advertising." : "Matter startup was not observed. That is not treated as a successful start."}</dd></div>
          <div><dt>Commissioning data</dt><dd>{installation?.onboardingStatus === "verified" ? "A live discriminator matched this package." : installation?.onboardingStatus === "image_verified" ? "The image matches a package with compiled test commissioning data. A preserved NVS value can override it, so this is not a live pairing code." : installation?.onboardingStatus === "invalid" ? "The captured vendor, product, discriminator, or image does not match this package." : "Not established. No pairing code is invented."}</dd></div>
          <div><dt>Commissioning status</dt><dd>{commissioning?.headline ?? "Current state unknown"}</dd></div>
          <div><dt>Commissioning window</dt><dd>{installation ? `${installation.windowNow === "open" ? "Observed open" : installation.windowNow === "closed" ? "Closed in the log" : "Unknown now"}${installation.commissioningObservedAt ? `. Last log ${formatLocalDateTime(installation.commissioningObservedAt)}` : ""}` : "Unknown"}</dd></div>
          <div><dt>IoT.Edu registration</dt><dd>{needsRecheck ? "A management record matches this hardware and needs re-verification after a factory reset. The record and the controller peer were kept." : live ? "Managed node recorded for this hardware. Operational reachability is a separate check." : associated ? "A historical management record matches this hardware, but it has no operational Matter node. The record was kept and needs re-verification." : "Not registered. A management record is not required for first-time commissioning."}</dd></div>
          <div><dt>Matter fabrics</dt><dd>{current?.commissionedFabricCount != null ? `${current.commissionedFabricCount} reported by the last identity read` : "Not Verified"}</dd></div>
          <div><dt>Thread</dt><dd>Apple Home supplies Thread credentials during commissioning. The HomePod mini is the Thread border router. This application does not upload clusters or configure the HomePod.</dd></div>
          <div><dt>Ecosystem</dt><dd>Apple Home</dd></div>
          <div><dt>Management reachability</dt><dd>{reachableNow ? "Reachable in this check" : checked?.liveRead === "failed" ? "Failed" : "Not Verified in this visit"}</dd></div>
        </dl>
      </details>

      <section className="panel stack guide-compact">
        <h2>Begin Apple Home Setup Guide</h2>
        <p>IoT.Edu does not treat Matter startup as BLE advertising and does not open a commissioning window. Use the Matter Commissioning section above. Scan or enter a code only when that section shows a valid QR code. This page does not launch Apple Home or initiate pairing.</p>
        <ol>
          <li>On the iPhone, open Home, add an accessory, and scan the code or enter it manually. Do this only when the Matter Commissioning section shows a valid code.</li>
          <li>This application cannot see PASE, attestation, or the Home app. Those stay Not observed unless a later device log shows them.</li>
        </ol>
      </section>

      <section className="panel stack">
        <h2>Already Connected to Apple Home</h2>
        <div className="background-process" aria-hidden="true">
        <p>Use this path when a Matter fabric is already stored. It does not require a factory reset or the original first-time code. Pair New Node adds IoT.Edu as another administrator with a fresh code from the existing administrator.</p>
        {installation?.commissioningState === "commissioned" && !installation.appleHomeFabric && <p>This capture did not include Apple Home vendor 0x1349, so that membership stays Unknown.</p>}
        <ol className="steps">
          <li data-state={live ? "done" : "pending"}><span className="step-state">{live ? "Registered" : needsRecheck || associated ? "Re-verify" : "Not registered"}</span>{live ? "A management record for this hardware has an operational Matter node. Reachability is checked separately." : needsRecheck ? "Factory-reset evidence marked this management record for re-verification. It was not deleted, and the controller peer was kept." : associated ? "A historical management record matches this hardware. It was not deleted, and operational reachability needs re-verification." : "No IoT.Edu management record is linked to this hardware."}</li>
          <li data-state={reachableNow ? "done" : "pending"}><span className="step-state">{reachableNow ? "Observed" : "Not Verified"}</span>Operational Matter communication from IoT.Edu.</li>
          <li data-state="pending"><span className="step-state">Not observed</span>Thread network name. Reachability does not identify the border router.</li>
          <li data-state={view.appleHomeConfirmedAt || view.smartHome === "completed" ? "done" : "pending"}><span className="step-state">User confirmed</span>The accessory is visible and still responds in the Home app. Confirmed {formatLocalDateTime(view.appleHomeConfirmedAt)}.</li>
        </ol>
        </div>
        <div className="choice-actions">
          <label className="choice">
            <input type="checkbox" checked={Boolean(view.appleHomeConfirmedAt)} onChange={(event) => event.target.checked ? confirmHome() : update({ appleHomeConfirmedAt: null, smartHome: "ready" })} />
            <span>I confirm the accessory is visible in Apple Home and still responds there.</span>
          </label>
          <div className="actions">
            <Link className="button secondary" to="/setup">Back</Link>
            <button type="button" className="secondary" onClick={() => void checkConnection()} disabled={!live || busy}>Check IoT.Edu connection</button>
            <Link className="button" to="/pair">Continue to Pair New Node</Link>
          </div>
        </div>
        {checked && <p>{checked.message}</p>}
      </section>
    </section>
  );
}
