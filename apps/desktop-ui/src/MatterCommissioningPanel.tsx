import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OnboardingDecision } from "@iotedu/contracts";
import {
  commissioningPresentation,
  commissioningQrUrl,
  peekCommissioningQr,
  type CommissioningWindow,
  type SharingWindowView,
} from "./matter-qr";

export function MatterCommissioningPanel({
  deviceKey,
  deviceName,
  deviceIdentifier,
  status,
  windowNow,
  decision,
  commissioned = false,
  sharingWindow = null,
  now,
  devices = [],
  onSelectDevice,
  canOpenWindow = false,
  openingWindow = false,
  onOpenWindow,
}: {
  deviceKey: string;
  deviceName: string;
  deviceIdentifier: string;
  status: string;
  windowNow: CommissioningWindow;
  decision: OnboardingDecision;
  commissioned?: boolean;
  sharingWindow?: SharingWindowView | null;
  now?: number;
  devices?: Array<{ mac: string; label: string }>;
  onSelectDevice?: (mac: string) => void;
  canOpenWindow?: boolean;
  openingWindow?: boolean;
  onOpenWindow?: () => void;
}) {
  const presentation = commissioningPresentation({ windowNow, decision, commissioned, sharingWindow, now });
  const [qrUrl, setQrUrl] = useState<string | null>(
    presentation.payload ? peekCommissioningQr(deviceKey, presentation.payload) : null,
  );
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!presentation.payload) {
      setQrUrl(null);
      return;
    }
    const cached = peekCommissioningQr(deviceKey, presentation.payload);
    if (cached) {
      setQrUrl(cached);
      return;
    }
    let stopped = false;
    commissioningQrUrl(deviceKey, presentation.payload)
      .then((url) => {
        if (!stopped) setQrUrl(url);
      })
      .catch(() => {
        if (!stopped) setQrUrl(null);
      });
    return () => {
      stopped = true;
    };
  }, [deviceKey, presentation.payload]);

  return (
    <section className="panel stack matter-commissioning" aria-labelledby="matter-commissioning-title">
      <h2 id="matter-commissioning-title">Matter Commissioning</h2>
      <p>This section stays in place for the selected device. A stored setup code is shown only for that device. Opening a commissioning window happens only when you use the button.</p>
      {devices.length > 0 && onSelectDevice && (
        <label>Device
          <select aria-label="Device" value={devices.some((device) => device.mac === deviceKey) ? deviceKey : ""} onChange={(event) => onSelectDevice(event.target.value)}>
            {!devices.some((device) => device.mac === deviceKey) && <option value="">Select a device</option>}
            {devices.map((device) => <option key={device.mac} value={device.mac}>{device.label}</option>)}
          </select>
        </label>
      )}
      <dl className="facts">
        <div><dt>Device name</dt><dd>{deviceName}</dd></div>
        <div><dt>Device identifier</dt><dd>{deviceIdentifier}</dd></div>
        <div><dt>Commissioning status</dt><dd>{status}</dd></div>
        <div><dt>Code</dt><dd>{presentation.label}</dd></div>
        <div><dt>Expiry</dt><dd>{presentation.expiry}</dd></div>
      </dl>
      <div className="matter-qr-frame" data-state={presentation.state} data-credential={presentation.credential}>
        {presentation.state === "valid" && qrUrl ? (
          <img src={qrUrl} alt={`${presentation.label} for ${deviceName}`} width={220} height={220} />
        ) : (
          <p>{presentation.state === "expired" ? "Commissioning window expired. No valid QR code is shown." : presentation.label}</p>
        )}
      </div>
      <p className="matter-qr-note">{presentation.detail}</p>
      {presentation.state === "valid" && presentation.manualCode ? (
        <p className="pairing-row">
          <span>{presentation.credential === "original" ? "Original manual pairing code" : "Manual pairing code"} <code>{presentation.manualCode}</code></span>
          <span className="pairing-actions">
            <button type="button" className="secondary" onClick={() => {
              const code = presentation.manualCode;
              if (!code) return;
              setCopyFailed(false);
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
              }).catch(() => {
                const area = document.createElement("textarea");
                area.value = code;
                area.setAttribute("readonly", "");
                area.style.position = "fixed";
                area.style.left = "-9999px";
                document.body.append(area);
                area.select();
                const ok = document.execCommand("copy");
                area.remove();
                setCopied(ok);
                setCopyFailed(!ok);
              });
            }}>Copy manual pairing code</button>
            {copied ? "Copied." : ""}
            {copyFailed ? "The browser blocked the copy. Select the code above and copy it manually." : ""}
          </span>
        </p>
      ) : null}
      {canOpenWindow && onOpenWindow ? (
        <div className="actions">
          <button type="button" onClick={onOpenWindow} disabled={openingWindow}>{openingWindow ? "Opening commissioning window…" : "Open commissioning window"}</button>
          <p className="matter-qr-note">IoT.Edu is already an administrator of this device. The button opens an enhanced commissioning window for another administrator. It does not reset the device or remove a fabric.</p>
        </div>
      ) : commissioned ? (
        <div className="actions">
          <Link className="button" to="/pair">Continue with Pair New Node</Link>
          <p className="matter-qr-note">IoT.Edu is not an administrator of this device. Apple Home or another existing administrator has to supply a new pairing code. Enter that code in Pair New Node.</p>
        </div>
      ) : null}
    </section>
  );
}
