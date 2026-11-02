import { useEffect, useState } from "react";
import type { CapabilityReport } from "@iotedu/contracts";
import { api } from "../api";

interface Settings {
  applicationVersion: string;
  dataDir: string;
  buildMode: string;
  expectedIdfVersion: string;
  idfPathConfigured: boolean;
  espMatterPathConfigured: boolean;
  toolchainProbed: boolean;
  dockerProbed: boolean;
  controllerIdentityLoaded: boolean;
  controllerIdentityStored?: boolean;
  accountMode?: "accounts" | "local";
  fabricLabel: string;
  reachabilityIntervalMs?: number;
  reachabilityFreshnessMs?: number;
  notes: string[];
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [intervalMs, setIntervalMs] = useState("30000");
  const [storage, setStorage] = useState<string | null>(null);
  const [creatingIdentity, setCreatingIdentity] = useState(false);

  async function createIdentity() {
    if (creatingIdentity || !settings) return;
    const ok = window.confirm("Create the IoT.Edu management identity on this computer? This is done once. Back up node-data/data/application/matter-controller afterwards: if it is lost, nodes paired to this identity must be paired again.");
    if (!ok) return;
    setCreatingIdentity(true);
    setError(null);
    try {
      const body = await api<{ identityLoaded: boolean; persisted: boolean; message?: string }>("/api/controller/identity", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setSettings({ ...settings, controllerIdentityLoaded: body.identityLoaded, controllerIdentityStored: body.persisted });
      setNotice(body.persisted ? "Management identity created. Back up the matter-controller folder in your data directory." : body.message ?? "The identity was not created.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The identity was not created.");
    } finally {
      setCreatingIdentity(false);
    }
  }

  useEffect(() => {
    Promise.all([
      api<Settings>("/api/settings"),
      api<CapabilityReport>("/api/capabilities"),
    ]).then(([settingsBody, capabilityBody]) => {
      api<{ configured: boolean; databaseBytes?: number; limitBytes?: number; percent?: number; level?: string; message?: string }>("/api/catalogue/storage")
        .then((body) => setStorage(body.configured && body.databaseBytes != null && body.limitBytes != null
          ? `Catalogue database ${Math.round(body.databaseBytes / 1024 / 1024)} MB of ${Math.round(body.limitBytes / 1024 / 1024)} MB (${body.percent}%, ${body.level}). ${body.message ?? ""}`
          : body.message ?? "No database is connected."))
        .catch(() => setStorage("Catalogue storage could not be measured."));
      setSettings(settingsBody);
      setCaps(capabilityBody);
      if (settingsBody.reachabilityIntervalMs) setIntervalMs(String(settingsBody.reachabilityIntervalMs));
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <section className="stack">
      <header>
        <h1>Settings & Help</h1>
        <p className="lede">Local paths and capability limits. A missing Matter identity is reported and is not recreated.</p>
      </header>
      {error && <p className="banner bad">{error}</p>}
      {notice && <p className="banner">{notice}</p>}
      {settings && (
        <div className="panel">
          <table>
            <caption className="sr-only">Local configuration</caption>
            <tbody>
              <tr><th scope="row">Application</th><td>{settings.applicationVersion}</td></tr>
              <tr><th scope="row">Build mode</th><td>{settings.buildMode}</td></tr>
              <tr><th scope="row">Expected ESP-IDF</th><td>{settings.expectedIdfVersion}</td></tr>
              <tr><th scope="row">IDF_PATH</th><td>{settings.idfPathConfigured ? "Configured in the environment" : "Not configured"}</td></tr>
              <tr><th scope="row">ESP_MATTER_PATH</th><td>{settings.espMatterPathConfigured ? "Configured in the environment" : "Not configured"}</td></tr>
              <tr><th scope="row">Toolchain probe</th><td>{settings.toolchainProbed ? "Probed" : "Not probed by the API"}</td></tr>
              <tr><th scope="row">Docker</th><td>{settings.dockerProbed ? "Probed" : "Not probed"}</td></tr>
              <tr><th scope="row">Data directory</th><td>{settings.dataDir}</td></tr>
              <tr><th scope="row">Fabric label</th><td>{settings.fabricLabel}</td></tr>
              <tr><th scope="row">Accounts</th><td>{settings.accountMode === "local" ? "Local mode: no database, no sign-in" : "Database accounts"}</td></tr>
              <tr>
                <th scope="row">Controller identity</th>
                <td>
                  {settings.controllerIdentityLoaded ? "Loaded" : settings.controllerIdentityStored ? "Stored but not loaded" : "Not created"}
                  {settings.controllerIdentityStored === false && (
                    <> <button type="button" onClick={() => void createIdentity()} disabled={creatingIdentity}>{creatingIdentity ? "Creating…" : "Create management identity"}</button></>
                  )}
                </td>
              </tr>
              <tr><th scope="row">Reachability interval</th><td>{settings.reachabilityIntervalMs ? `${settings.reachabilityIntervalMs / 1000} seconds` : "Not reported"}</td></tr>
              <tr><th scope="row">Freshness window</th><td>{settings.reachabilityFreshnessMs ? `${settings.reachabilityFreshnessMs / 1000} seconds` : "Not reported"}</td></tr>
            </tbody>
          </table>
          <form className="row" onSubmit={(event) => {
            event.preventDefault();
            void api<{ intervalMs: number; freshnessMs: number }>("/api/reachability/interval", {
              method: "POST",
              body: JSON.stringify({ intervalMs: Number(intervalMs) }),
            }).then((body) => {
              setSettings({ ...settings, reachabilityIntervalMs: body.intervalMs, reachabilityFreshnessMs: body.freshnessMs });
              setNotice(`Reachability checks run every ${body.intervalMs / 1000} seconds.`);
            }).catch((reason: Error) => setError(reason.message));
          }}>
            <label>
              Monitoring interval (ms)
              <input value={intervalMs} onChange={(event) => setIntervalMs(event.target.value)} inputMode="numeric" />
            </label>
            <button type="submit">Save interval</button>
          </form>
          <ul>{settings.notes.map((note) => <li key={note}>{note}</li>)}</ul>
        </div>
      )}
      {caps && (
        <div className="panel">
          <h2 id="capabilities-heading">Capabilities</h2>
          <table aria-labelledby="capabilities-heading">
            <caption className="sr-only">Capability states</caption>
            <tbody>
              <tr><th scope="row">Matter commissioning</th><td>{caps.matterCommissioning}</td></tr>
              <tr><th scope="row">Bluetooth</th><td>{caps.bleCommissioning}</td></tr>
              <tr><th scope="row">Thread dataset</th><td>{caps.threadDataset}</td></tr>
              <tr><th scope="row">Firmware build</th><td>{caps.firmwareBuild}</td></tr>
              <tr><th scope="row">USB flashing</th><td>{caps.usbFlash}</td></tr>
              <tr><th scope="row">AI</th><td>{caps.ai}</td></tr>
              {storage && <tr><th scope="row">Catalogue storage</th><td>{storage}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
