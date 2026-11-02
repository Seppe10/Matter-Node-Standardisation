import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ManagedNode, RemoveNodeResult } from "@iotedu/contracts";
import { ApiError, api } from "../api";
import { formatLocalDateTime } from "../datetime";
import { presenceLabel, stateLabel } from "../setup";
import type { SetupNodeType } from "../setup-node-types";
import { NEW_NODE, loadSelectedNodeId, nodeOptionLabel, saveSelectedNodeId } from "../selection";
import { useSetup } from "../use-setup";

interface ReachabilityReport {
  nodes: ManagedNode[];
  errors: Array<{ id: string; message: string }>;
  checkedAt: string;
}

export function connectionLabel(node: ManagedNode): string {
  return presenceLabel(node);
}

function overviewAlert(messages: string[]): string | null {
  const shown = messages.filter((message) => !message.startsWith("Could not reconnect to the stored Matter device."));
  return shown.length > 0 ? shown.join(" ") : null;
}

const PRODUCT_SENSOR: Record<number, string> = {
  0x8000: "DHT11 Temperature and Humidity",
  0x8001: "Photosensitive Light Sensor",
  0x8002: "RGB LED Controller",
};

export function sensorLabel(node: ManagedNode, types: SetupNodeType[]): string {
  const matched = types.find((type) => type.packages.some((item) => item.softwareVersion === node.softwareVersion || item.softwareVersionString === node.softwareVersionString));
  if (matched?.device.name) return matched.device.name;
  const product = node.productId == null ? undefined : PRODUCT_SENSOR[node.productId];
  if (product) return product;
  return "Not recorded";
}

export function OverviewPage() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<ManagedNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(() => loadSelectedNodeId(window.localStorage));
  const [nodeTypes, setNodeTypes] = useState<SetupNodeType[]>([]);
  const [removeTarget, setRemoveTarget] = useState<ManagedNode | null>(null);
  const [removeMode, setRemoveMode] = useState<"decommission" | "forget" | null>(null);
  const [phrase, setPhrase] = useState("");
  const [removing, setRemoving] = useState(false);
  const { view } = useSetup(nodes);

  useEffect(() => {
    let stopped = false;
    const load = () => {
      api<{ nodes: ManagedNode[] }>("/api/nodes")
        .then((body) => {
          if (!stopped) {
            setNodes(body.nodes);
            setLoadError(null);
          }
        })
        .catch((reason: Error) => {
          if (!stopped) setLoadError(reason.message);
        });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    api<{ nodeTypes: SetupNodeType[] }>("/api/node-types")
      .then((body) => {
        if (!stopped) setNodeTypes(body.nodeTypes);
      })
      .catch(() => {
        if (!stopped) setNodeTypes([]);
      });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (selectedId === NEW_NODE) return;
    if (nodes.length === 0) return;
    if (!nodes.some((node) => node.id === selectedId)) {
      setSelectedId(NEW_NODE);
      saveSelectedNodeId(window.localStorage, NEW_NODE);
      setNotice("The previously selected node is no longer registered. New Node is selected, and no other device was targeted.");
    }
  }, [nodes, selectedId]);

  function choose(id: string) {
    setSelectedId(id);
    saveSelectedNodeId(window.localStorage, id);
    setNotice(null);
  }

  async function refreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const body = await api<ReachabilityReport>("/api/nodes/refresh-live", { method: "POST" });
      setNodes(body.nodes);
      setRefreshedAt(body.checkedAt);
      setError(overviewAlert(body.errors.map((item) => item.message)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshOne(id: string) {
    if (refreshing || refreshingId) return;
    setRefreshingId(id);
    setError(null);
    try {
      const body = await api<{ node: ManagedNode; message: string; liveRead: string }>(`/api/nodes/${id}/refresh`, { method: "POST" });
      setNodes((current) => current.map((node) => node.id === id ? body.node : node));
      setRefreshedAt(new Date().toISOString());
      if (body.liveRead !== "read") setError(overviewAlert([body.message]));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Refresh failed");
    } finally {
      setRefreshingId(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget || !removeMode || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const body = await api<RemoveNodeResult>(`/api/nodes/${removeTarget.id}/remove`, {
        method: "POST",
        body: JSON.stringify({ mode: removeMode, confirm: true, phrase }),
      });
      setNodes((current) => current.filter((node) => node.id !== removeTarget.id));
      if (selectedId === removeTarget.id) choose(NEW_NODE);
      setNotice(body.message);
      setRemoveTarget(null);
      setRemoveMode(null);
      setPhrase("");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "The node was not removed.");
    } finally {
      setRemoving(false);
    }
  }

  const live = nodes.filter((node) => !node.simulated);
  const online = live.filter((node) => node.presence === "online");
  const unreachable = live.filter((node) => node.presence === "unreachable");
  const unknown = live.filter((node) => node.presence !== "online" && node.presence !== "unreachable");
  const selected = selectedId === NEW_NODE ? null : nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <section>
      <header className="page-head page-intro">
        <div>
          <h1>Overview</h1>
          <p className="lede lede-full">Choose the node that later actions will target. Online means a fresh Basic Information read in this session.</p>
        </div>
        <button type="button" onClick={() => void refreshAll()} disabled={refreshing} aria-busy={refreshing}>
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </header>
      {(loadError || error) && <p className="banner bad">{loadError ?? error}</p>}
      {notice && <p className="banner">{notice}</p>}
      <p className="muted">Last refresh: {formatLocalDateTime(refreshedAt)}. The backend also checks about every 30 seconds.</p>
      <div className="grid">
        <article className="card"><div className="muted">Managed nodes</div><div className="stat">{live.length}</div></article>
        <article className="card"><div className="muted">Online</div><div className="stat">{online.length}</div></article>
        <article className="card"><div className="muted">Unreachable</div><div className="stat">{unreachable.length}</div></article>
        <article className="card" title="Unknown includes Stale and Checking. A stored successful Matter session is not Online.">
          <div className="muted">Unknown</div>
          <div className="stat">{unknown.length}</div>
        </article>
      </div>
      <section className="panel stack" style={{ marginTop: 16 }}>
        <h2>Current node</h2>
        <label>
          Selected Node
          <select aria-label="Selected Node" value={selected ? selected.id : NEW_NODE} onChange={(event) => choose(event.target.value)}>
            <option value={NEW_NODE}>New Node</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>{nodeOptionLabel(node)}</option>
            ))}
          </select>
        </label>
        {!selected && (
          <div className="stack">
            <p>Start with a new ESP32-H2. This does not create a commissioned node record.</p>
            <div className="actions">
              <button type="button" onClick={() => { choose(NEW_NODE); navigate("/setup?draft=new"); }}>Get Started</button>
            </div>
          </div>
        )}
        {selected && (
          <div className="stack">
            <dl className="facts">
              <div><dt>Node name</dt><dd>{selected.name}</dd></div>
              <div><dt>Hardware type</dt><dd>{selected.hardware}</dd></div>
              <div><dt>Device identifier</dt><dd>{selected.matterNodeId ? `Matter node ${selected.matterNodeId}` : selected.id}</dd></div>
              <div><dt>Registered</dt><dd>Yes</dd></div>
              <div><dt>Matter commissioning</dt><dd>{selected.matterNodeId ? "IoT.Edu fabric recorded" : "Not commissioned"}</dd></div>
              <div><dt>Last verified firmware</dt><dd>{selected.softwareVersionString ?? "Not Verified"}{selected.softwareVersion != null ? ` / SoftwareVersion ${selected.softwareVersion}` : ""}</dd></div>
              <div><dt>Current reachability</dt><dd>{connectionLabel(selected)}</dd></div>
              <div><dt>Last successful communication</dt><dd>{formatLocalDateTime(selected.lastSuccessfulCommunicationAt ?? selected.lastCommunicationAt)}</dd></div>
              <div><dt>Last failed communication</dt><dd>{formatLocalDateTime(selected.lastFailedCommunicationAt)}</dd></div>
              <div><dt>Setup status</dt><dd>{stateLabel(view.management)}</dd></div>
            </dl>
            <div className="actions">
              <Link className="button" to={`/setup?node=${selected.id}&mode=reflash`}>Re-flash Firmware</Link>
            </div>
          </div>
        )}
      </section>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 id="nodes-heading">Nodes</h2>
        {nodes.length === 0 ? (
          <p className="muted">No nodes recorded.</p>
        ) : (
          <table className="nodes-table" aria-labelledby="nodes-heading">
            <caption className="sr-only">Recorded nodes</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Hardware</th>
                <th scope="col">Firmware</th>
                <th scope="col">Node type</th>
                <th scope="col">Current status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <th scope="row">
                    {node.name}{" "}
                    {node.simulated && <span className="pill simulated">Simulated</span>}
                  </th>
                  <td>{node.hardware}</td>
                  <td>{node.softwareVersionString ?? "Not read"}</td>
                  <td>{sensorLabel(node, nodeTypes)}</td>
                  <td>{connectionLabel(node)}</td>
                  <td className="node-actions">
                    <div className="row">
                      <button type="button" className="secondary" onClick={() => void refreshOne(node.id)} disabled={refreshing || refreshingId != null || node.simulated || !node.matterNodeId} title={node.simulated || !node.matterNodeId ? "This record has no management fabric to read." : "Read Basic Information again"}>
                        {refreshingId === node.id ? "Checking…" : "Refresh"}
                      </button>
                      <Link className="button secondary" to={`/nodes/${node.id}`}>Details</Link>
                      <button type="button" className="danger" onClick={() => { setRemoveTarget(node); setRemoveMode(null); setPhrase(""); }}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {removeTarget && (
        <section className="panel stack danger-zone" role="dialog" aria-labelledby="remove-title">
          <h2 id="remove-title">Remove {removeTarget.name}</h2>
          <p>Target: {nodeOptionLabel(removeTarget)}. This does not select a different device.</p>
          {!removeMode && (
            <div className="stack">
              <section className="recovery-option">
                <h3>Decommission from IoT.Edu</h3>
                <p>For a node that answers a fresh read, this removes only IoT.Edu’s own Matter fabric. Apple Home and Apple Keychain fabrics are not targeted. The controller identity stays.</p>
                <button type="button" className="danger" onClick={() => setRemoveMode("decommission")} disabled={removeTarget.presence !== "online"} title={removeTarget.presence === "online" ? "Continue to confirmation" : "The node is not Online from a fresh read, so device decommission stays unavailable."}>
                  Decommission from IoT.Edu
                </button>
              </section>
              <section className="recovery-option">
                <h3>Forget Local Record Only</h3>
                <p>Removes the IoT.Edu record and local peer. Matter credentials may remain on the device. This does not report a physical decommission.</p>
                <button type="button" className="danger" onClick={() => setRemoveMode("forget")}>Forget Local Record Only</button>
              </section>
              <div className="actions">
                <button type="button" className="secondary" onClick={() => setRemoveTarget(null)}>Back</button>
              </div>
            </div>
          )}
          {removeMode && (
            <div className="stack">
              <p className="banner bad">
                {removeMode === "decommission"
                  ? "Final step. This sends RemoveFabric for IoT.Edu’s fabric only after a fresh read. It does not run until you confirm."
                  : "Final step. This forgets the local record only. The device is not physically decommissioned."}
              </p>
              <label>
                Type {removeTarget.name}
                <input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" />
              </label>
              <div className="actions">
                <button type="button" className="secondary" onClick={() => setRemoveMode(null)}>Back</button>
                <button type="button" className="danger" disabled={phrase !== removeTarget.name || removing} title={phrase === removeTarget.name ? "Confirm removal" : "Type the node name to confirm."} onClick={() => void confirmRemove()}>
                  {removing ? "Removing…" : removeMode === "decommission" ? "Remove IoT.Edu fabric" : "Forget local record"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
