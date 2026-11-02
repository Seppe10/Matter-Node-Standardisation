import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { CommissioningWindowResult, ManagedNode, RefreshResult } from "@iotedu/contracts";
import { ApiError, api } from "../api";
import { formatLocalDateTime } from "../datetime";
import { presenceLabel } from "../setup";

export function identityRow(label: string, value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  return <tr key={label}><th scope="row">{label}</th><td>{String(value)}</td></tr>;
}

function connectionText(node: ManagedNode): string | null {
  if (node.simulated && !node.presence) return "Simulated";
  return presenceLabel(node);
}

export function NodePage() {
  const { id = "" } = useParams();
  const [node, setNode] = useState<ManagedNode | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ node: ManagedNode }>(`/api/nodes/${id}`)
      .then((body) => {
        setNode(body.node);
        setName(body.node.name);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [id]);

  async function rename(event: FormEvent) {
    event.preventDefault();
    const body = await api<{ node: ManagedNode }>(`/api/nodes/${id}/rename`, {
      method: "POST",
      body: JSON.stringify({ name, confirm: true }),
    });
    setNode(body.node);
  }

  async function refresh() {
    const body = await api<RefreshResult>(`/api/nodes/${id}/refresh`, { method: "POST" });
    setNode(body.node);
    setMessage(body.message);
  }

  async function windowAction() {
    try {
      const body = await api<CommissioningWindowResult>(`/api/nodes/${id}/commissioning-window`, { method: "POST" });
      const code = body.manualPairingCode || body.qrPairingCode;
      setMessage(code ? `${body.message} Code: ${code}` : body.message);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Request failed");
    }
  }

  if (!node) return <p>{error ?? "Loading node…"}</p>;

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <h1>{node.name}</h1>
          <p className="lede">Application id {node.id}. Matter node id: {node.matterNodeId ?? "not assigned"}.</p>
        </div>
        <div className="row">
          <Link className="button secondary" to={`/builder?node=${node.id}`}>Software configuration</Link>
        </div>
      </header>
      {node.simulated && <div className="banner">Simulated record. No fabric credential was created for this node.</div>}
      {message && <div className="banner">{message}</div>}
      {error && <div className="banner bad">{error}</div>}
      <div className="split">
        <div className="panel">
          <h2 id="identity-heading">Identity</h2>
          <table aria-labelledby="identity-heading">
            <caption className="sr-only">Node identity</caption>
            <tbody>
              {identityRow("Matter node ID", node.matterNodeId)}
              {identityRow("Vendor ID", node.vendorId)}
              {identityRow("Product ID", node.productId)}
              {identityRow("Hardware version", node.hardwareVersion)}
              {identityRow("Hardware version string", node.hardwareVersionString)}
              {identityRow("SoftwareVersion", node.softwareVersion)}
              {identityRow("SoftwareVersionString", node.softwareVersionString)}
              {identityRow("Management fabric", node.fabricLabel)}
              {identityRow("Management fabric ID", node.managementFabricId)}
              {identityRow("Commissioned fabric count", node.commissionedFabricCount)}
              {identityRow("Management connection", connectionText(node))}
              {identityRow("Last successful communication", formatLocalDateTime(node.lastSuccessfulCommunicationAt ?? node.lastCommunicationAt))}
              {identityRow("Last failed communication", formatLocalDateTime(node.lastFailedCommunicationAt))}
              {identityRow("Recorded", formatLocalDateTime(node.createdAt))}
              {identityRow("Last updated", formatLocalDateTime(node.updatedAt))}
              {identityRow("Reachability error", node.reachabilityError)}
              {identityRow("Partition layout", node.partitionLayoutId)}
              {node.installedComponents.length > 0 && identityRow("Installed components", node.installedComponents.join(", "))}
            </tbody>
          </table>
        </div>
        <div className="panel stack">
          <h2>Maintenance</h2>
          <form className="stack" onSubmit={rename}>
            <label>Application name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <button type="submit">Rename</button>
          </form>
          <button className="secondary" type="button" onClick={refresh}>Refresh identity</button>
          <button className="secondary" type="button" onClick={windowAction}>Open commissioning window</button>
        </div>
      </div>
      <div className="panel">
        <h2>History</h2>
        <ul>
          {node.history.length === 0 && <p>Not yet recorded</p>}
          {node.history.map((entry) => (
            <li key={`${entry.at}-${entry.kind}`}>{formatLocalDateTime(entry.at)} — {entry.kind}: {entry.detail}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
