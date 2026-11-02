import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { BuildJob, ControllerReconciliationPlan, FactoryResetAssessment, ManagedNode, ProgramSession, ValidationResult } from "@iotedu/contracts";
import { FACTORY_RESET_WATCH_SECONDS } from "@iotedu/contracts";
import { ApiError, api } from "../api";
import { formatLocalDateTime } from "../datetime";
import { diagnosticReport, interpretConsole, type ConsoleFindings } from "../diagnostics";
import { loadNodeConfig } from "../node-config";
import { installationAllowed, packageAfterTypeChange, releaseLabel, selectedPackage, wiringFor, type SetupNodeType } from "../setup-node-types";
import { NEW_NODE, loadSelectedNodeId } from "../selection";
import { RecoveryErase } from "./RecoveryErase";
import { macFromDeviceLog, missingFlashOffsets } from "@iotedu/contracts";
import { firmwareStartupStages } from "@iotedu/contracts";
import { activeInstallStage, applyLiveIdentity, bootCaptureReport, currentSetupStep, displayedStartupChecks, eraseControl, firmwareReady, historicalDeviceSeed, identifiedHardware, identityLabel, installationHeadline, preferredProgramSession, smartHomeTarget, INSTALL_STAGES, SETUP_STEP_LABELS } from "../setup-flow";
import { useSetup } from "../use-setup";
import { WorkflowStrip } from "../WorkflowStrip";

interface ProbeResult {
  port: string;
  accepted: boolean;
  detail: string;
  failure?: "no_serial_data" | "port_unavailable" | "wrong_chip" | null;
}

interface SerialDevice {
  path: string;
  role: "programming" | "console" | "unknown";
  label: string;
  busy?: boolean;
  ownedByApplication?: boolean;
  occupants?: Array<{ pid: number; command: string }>;
}

interface ToolchainStatus {
  available: boolean;
  detail: string;
  source: string;
  code: string;
}

const TOOLCHAIN_CODES = new Set(["toolchain_not_installed", "toolchain_not_activated", "tools_unavailable", "toolchain_not_configured"]);

interface WritePlan {
  buildId: string;
  softwareVersion: number;
  softwareVersionString: string;
  regions: Array<{ offset: string; artifact: string; bytes: number }>;
  preserved: string[];
}

function flashable(job: BuildJob): boolean {
  return job.status === "succeeded"
    && !job.simulated
    && job.request.hardware === "esp32h2"
    && (job.verification === "compiled" || job.verification === "hardware_verified")
    && job.artifacts.some((item) => item.name === "sensors.bin" && !item.simulated);
}

function occupantLabel(device: SerialDevice): string {
  const named = device.occupants ?? [];
  if (named.length === 0) return "another program";
  return named.map((item) => `${item.command} (process ${item.pid})`).join(", ");
}

function macAddress(detail: string): string {
  const base = detail.match(/BASE MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)?.[1];
  if (base) return base;
  const lines = detail.split("\n").filter((line) => !/MAC_EXT|ff:fe/i.test(line));
  return lines.join("\n").match(/MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)?.[1] ?? "Not Verified";
}

function choosePorts(devices: SerialDevice[], savedProgramming: string | null, savedConsole: string | null) {
  const paths = devices.map((device) => device.path);
  const programmingDevice = devices.find((device) => device.role === "programming");
  const consoleDevice = devices.find((device) => device.role === "console");
  const savedRole = devices.find((device) => device.path === savedProgramming)?.role;
  const programming = savedProgramming && paths.includes(savedProgramming) && savedRole !== "console"
    ? savedProgramming
    : programmingDevice?.path ?? paths[0] ?? null;
  const consolePort = savedConsole && paths.includes(savedConsole) && savedConsole !== programming
    ? savedConsole
    : consoleDevice && consoleDevice.path !== programming
      ? consoleDevice.path
      : paths.find((item) => item !== programming) ?? null;
  return { programming, consolePort };
}

function sessionDuration(createdAt: string, updatedAt: string): string {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Not Verified";
  return `${Math.round((end - start) / 1000)} seconds`;
}

function sessionMac(session: ProgramSession | null): string | null {
  if (!session) return null;
  return session.baseMac ?? macFromDeviceLog(`${session.logs.join("\n")}\n${session.monitorLog}`);
}

function chipSummary(detail: string): { model: string; revision: string; flash: string; transport: string } {
  return {
    model: detail.match(/Chip is ([^(\n]+)/)?.[1]?.trim() ?? "Not Verified",
    revision: detail.match(/revision (v[\d.]+)/i)?.[1] ?? "Not Verified",
    flash: detail.match(/(\d+\s*MB)/i)?.[1] ?? "Not Verified",
    transport: /USB-Serial\/JTAG|usbmodem/i.test(detail) ? "USB serial" : "Not Verified",
  };
}

function nodeTypeLoadMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === "catalogue_unavailable") return reason.message;
  if (reason instanceof ApiError && reason.code === "route_not_found") return "The Node Type API route was not found. This is not an empty catalogue.";
  if (reason instanceof ApiError && reason.status === 404) return "The Node Type API route was not found. This is not an empty catalogue.";
  if (reason instanceof TypeError) return "The local API is not reachable, so Node Types could not be loaded.";
  if (reason instanceof ApiError) return reason.message;
  return "Node Types could not be loaded from the firmware catalogue.";
}

export function HardwarePage() {
  const [params] = useSearchParams();
  const [ports, setPorts] = useState<string[] | null>(null);
  const [devices, setDevices] = useState<SerialDevice[]>([]);
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null);
  const [builds, setBuilds] = useState<BuildJob[]>([]);
  const [nodes, setNodes] = useState<ManagedNode[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeLive, setProbeLive] = useState(false);
  const [plan, setPlan] = useState<WritePlan | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [session, setSession] = useState<ProgramSession | null>(null);
  const [consoleText, setConsoleText] = useState("");
  const [findings, setFindings] = useState<ConsoleFindings | null>(null);
  const [writeAck, setWriteAck] = useState(false);
  const [resetApproved, setResetApproved] = useState(false);
  const [configName, setConfigName] = useState(() => loadNodeConfig(window.localStorage).name);
  const [reconciliation, setReconciliation] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [resetGuidance, setResetGuidance] = useState(false);
  const [resetWatch, setResetWatch] = useState<FactoryResetAssessment | null>(null);
  const [watchElapsed, setWatchElapsed] = useState(0);
  const [retireId, setRetireId] = useState("");
  const [retirePhrase, setRetirePhrase] = useState("");
  const [retireMessage, setRetireMessage] = useState<string | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [writeSeen, setWriteSeen] = useState(false);
  const [fullWriteLog, setFullWriteLog] = useState<string | null>(null);
  const [connectionHelp, setConnectionHelp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeTypes, setNodeTypes] = useState<SetupNodeType[] | null>(null);
  const [nodeTypeError, setNodeTypeError] = useState<string | null>(null);
  const [nodeTypeId, setNodeTypeId] = useState<string | null>(null);
  const [requiredFlashBytes, setRequiredFlashBytes] = useState(4_194_304);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const { setup, view, update } = useSetup(nodes);

  useEffect(() => {
    api<{ nodeTypes: SetupNodeType[]; requiredFlashBytes?: number }>("/api/node-types")
      .then((body) => {
        setNodeTypes(body.nodeTypes);
        setRequiredFlashBytes(body.requiredFlashBytes ?? 4_194_304);
        setNodeTypeError(null);
        setNodeTypeId(null);
        update({ selectedBuildId: null });
      })
      .catch((reason: unknown) => {
        setNodeTypes(null);
        setNodeTypeError(nodeTypeLoadMessage(reason));
      });
    // Node Types are loaded once. A saved package is not treated as a selected Node Type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const packages = builds.filter(flashable);
  const activeType = nodeTypes?.find((item) => item.id === nodeTypeId) ?? null;
  const chosenPackage = selectedPackage(activeType, setup.selectedBuildId);
  const selected = chosenPackage ? packages.find((job) => job.id === chosenPackage.buildId) ?? null : null;
  const live = nodes.find((node) => !node.simulated && node.matterNodeId) ?? null;
  const chip = probe?.accepted && probe.port === setup.programmingPort ? chipSummary(probe.detail) : null;
  const expectedVersion = selected?.request.softwareVersionString ?? live?.softwareVersionString ?? null;

  async function refresh() {
    setError(null);
    setBusy("refresh");
    try {
      const [portBody, buildBody, nodeBody, toolchainBody, sessionBody] = await Promise.all([
        api<{ ports: string[]; devices?: SerialDevice[] }>("/api/programmer/ports"),
        api<{ jobs: BuildJob[] }>("/api/builds"),
        api<{ nodes: ManagedNode[] }>("/api/nodes"),
        api<ToolchainStatus>("/api/programmer/toolchain"),
        api<{ sessions: ProgramSession[] }>("/api/programmer/sessions"),
      ]);
      const listed = portBody.devices ?? portBody.ports.map((path) => ({ path, role: "unknown" as const, label: "USB serial" }));
      setPorts(portBody.ports);
      setDevices(listed);
      setToolchain(toolchainBody);
      setBuilds(buildBody.jobs);
      setNodes(nodeBody.nodes);
      setRefreshedAt(new Date().toISOString());
      const annotated = sessionBody.sessions.map((item) => ({
        ...item,
        mac: item.baseMac ?? macFromDeviceLog(`${item.logs.join("\n")}\n${item.monitorLog}`),
      }));
      let activeMac = setup.deviceMac;
      const seed = activeMac ? null : historicalDeviceSeed(annotated);
      if (seed?.mac) {
        activeMac = seed.mac;
        update({
          deviceMac: seed.mac,
          deviceIdentity: "historical",
          deviceProbeSource: "boot_log",
          deviceProbeAt: null,
          deviceSessionId: seed.id,
          programSessionId: seed.id,
          hardware: "not_verified",
        });
      }
      const restoredSession = preferredProgramSession(annotated, seed?.id ?? setup.programSessionId, activeMac);
      if (restoredSession) setSession(restoredSession);
      const selectedPorts = choosePorts(listed, setup.programmingPort, setup.consolePort);
      const savedPort = setup.programmingPort;
      const savedPortPresent = Boolean(savedPort && listed.some((device) => device.path === savedPort && device.role !== "console"));
      const sessionPort = restoredSession?.port ?? null;
      const sessionPortPresent = Boolean(sessionPort && listed.some((device) => device.path === sessionPort && device.role !== "console"));
      const evidencePort = savedPortPresent ? savedPort : sessionPortPresent ? sessionPort : null;
      update({
        programmingPort: evidencePort ?? selectedPorts.programming,
        consolePort: selectedPorts.consolePort,
        programSessionId: restoredSession?.id ?? seed?.id ?? setup.programSessionId,
        deviceSessionId: restoredSession?.id ?? setup.deviceSessionId,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Hardware status could not be refreshed");
      update({ hardware: "failed" });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
    // The first load reads the current ports and packages. Later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!probe?.accepted || !selected || !setup.programmingPort) {
      setPlan(null);
      return;
    }
    let stopped = false;
    api<WritePlan>("/api/programmer/plan", {
      method: "POST",
      body: JSON.stringify({ buildId: selected.id, port: setup.programmingPort }),
    }).then((body) => {
      if (!stopped) setPlan(body);
    }).catch((reason: Error) => {
      if (!stopped) {
        setPlan(null);
        setError(reason.message);
      }
    });
    return () => {
      stopped = true;
    };
  }, [probe?.accepted, selected, setup.programmingPort]);

  useEffect(() => {
    const mac = sessionMac(session);
    if (!writeSeen || !mac) return;
    if (setup.deviceMac === mac && setup.deviceIdentity === "verified") return;
    const summary = chipSummary(`${session?.logs.join("\n") ?? ""}\nBASE MAC: ${mac}`);
    update(applyLiveIdentity(setup, {
      accepted: true,
      mac,
      model: summary.model === "Not Verified" ? setup.deviceModel : summary.model,
      revision: summary.revision === "Not Verified" ? setup.deviceRevision : summary.revision,
      flash: summary.flash === "Not Verified" ? setup.deviceFlash : summary.flash,
      at: session?.updatedAt ?? new Date().toISOString(),
    }, mac));
  }, [writeSeen, session?.id, session?.baseMac, session?.updatedAt]);

  useEffect(() => {
    if (!session || (session.status !== "running" && session.stage !== "monitoring")) return;
    const timer = setInterval(() => {
      void api<{ session: ProgramSession }>(`/api/programmer/sessions/${session.id}`)
        .then((body) => setSession(body.session))
        .catch((reason: Error) => setError(reason.message));
    }, 1000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!recoveryOpen) return;
    api<ControllerReconciliationPlan>("/api/controller/reconciliation")
      .then((plan) => {
        const peers = plan.peers.map((peer) => `node ${peer.matterNodeId} (${peer.role})`).join(", ") || "no peers listed";
        setReconciliation(plan.blocker ?? `${plan.retireAfterFactoryReset} Current peers: ${peers}. Nothing was deleted.`);
      })
      .catch(() => setReconciliation("The controller reconciliation plan could not be loaded. No peer is deleted from this page."));
  }, [recoveryOpen]);

  async function releaseConsole() {
    if (!setup.consolePort) return;
    setError(null);
    setBusy("release");
    try {
      await api<{ message: string }>("/api/programmer/ports/release", {
        method: "POST",
        body: JSON.stringify({ port: setup.consolePort }),
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The console session was not stopped");
    } finally {
      setBusy(null);
    }
  }

  async function identify() {
    setError(null);
    setConnectionHelp(false);
    setBusy("identify");
    setProbe(null);
    update({ hardware: "in_progress" });
    try {
      const portBody = await api<{ ports: string[]; devices?: SerialDevice[] }>("/api/programmer/ports");
      const listed: SerialDevice[] = portBody.devices ?? portBody.ports.map((path) => ({ path, role: "unknown", label: "USB serial" }));
      setPorts(portBody.ports);
      setDevices(listed);
      const chosen = listed.find((device) => device.path === setup.programmingPort && device.role !== "console")
        ?? listed.find((device) => device.role === "programming");
      if (!chosen) {
        setConnectionHelp(true);
        update({ hardware: "not_started", programmingPort: null });
        return;
      }
      if (chosen.busy && !chosen.ownedByApplication) {
        update({ programmingPort: chosen.path, hardware: "not_started" });
        setError(`The programming port is open in ${occupantLabel(chosen)}. Close that program, detect devices again, and retry identification.`);
        return;
      }
      update({
        programmingPort: chosen.path,
        consolePort: listed.find((device) => device.role === "console")?.path ?? setup.consolePort,
      });
      const body = await api<ProbeResult>("/api/programmer/probe", {
        method: "POST",
        body: JSON.stringify({ port: chosen.path }),
      });
      const probed = macFromDeviceLog(body.detail);
      const summary = chipSummary(body.detail);
      const identified = body.accepted && Boolean(probed);
      setProbeLive(identified);
      setProbe(identified ? body : null);
      setConnectionHelp(body.failure === "no_serial_data" || body.failure === "port_unavailable");
      if (body.accepted && !probed) setError("The chip answered, but the probe did not include a BASE MAC. The board is not identified.");
      else if (!body.accepted && body.failure !== "no_serial_data" && body.failure !== "port_unavailable") {
        setError(body.detail || "The connected chip did not respond.");
      }
      update(applyLiveIdentity(setup, {
        accepted: identified,
        mac: probed,
        model: summary.model === "Not Verified" ? null : summary.model,
        revision: summary.revision === "Not Verified" ? null : summary.revision,
        flash: summary.flash === "Not Verified" ? null : summary.flash,
        at: new Date().toISOString(),
      }, sessionMac(session)));
    } catch (reason) {
      if (reason instanceof ApiError && TOOLCHAIN_CODES.has(reason.code)) {
        setToolchain((current) => ({
          available: false,
          detail: reason.message,
          source: current?.source ?? "incomplete",
          code: reason.code,
        }));
        update({ hardware: "not_started" });
      } else if (reason instanceof ApiError && reason.code === "port_busy") {
        setError(reason.message);
        update({ hardware: "not_started" });
      } else if (reason instanceof ApiError && (reason.code === "port_missing" || reason.code === "console_port")) {
        setConnectionHelp(true);
        setError(reason.message);
        update({ hardware: "not_started" });
      } else {
        setError(reason instanceof Error ? reason.message : "The chip probe failed");
        update({ hardware: "failed" });
      }
    } finally {
      setBusy(null);
    }
  }

  async function retryBoot() {
    if (!session || session.status !== "succeeded") return;
    const consolePort = setup.consolePort || setup.programmingPort;
    if (!consolePort) {
      setError("Connect the ESP32-H2. The USB programming port can capture logs when the firmware enables that console.");
      return;
    }
    setError(null);
    setBusy("verify-boot");
    try {
      const body = await api<{ session: ProgramSession }>(`/api/programmer/sessions/${session.id}/verify-boot`, {
        method: "POST",
        body: JSON.stringify({ consolePort }),
      });
      setSession(body.session);
      update({ programSessionId: body.session.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Boot verification did not finish");
    } finally {
      setBusy(null);
    }
  }

  async function flash() {
    if (!selected || !setup.programmingPort || !plan) return;
    setError(null);
    setBusy("flash");
    setWriteSeen(true);
    try {
      const body = await api<{ session: ProgramSession }>("/api/programmer/sessions", {
        method: "POST",
        body: JSON.stringify({
          buildId: selected.id,
          port: setup.programmingPort,
          intent: live ? "commissioned_maintenance" : "initial_install",
          confirm: true,
          preserveNvs: true,
          ...(live ? { acknowledgeCommissioned: true } : {}),
        }),
      });
      setSession(body.session);
      update({ programSessionId: body.session.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The write was rejected");
      update({ hardware: "failed" });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (busy !== "reset") return;
    const started = Date.now();
    setWatchElapsed(0);
    const timer = window.setInterval(() => setWatchElapsed(Math.min(FACTORY_RESET_WATCH_SECONDS, Math.floor((Date.now() - started) / 1000))), 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function prepareFactoryReset() {
    const port = setup.consolePort;
    if (!port) {
      setError("Choose the console port. It is separate from the programming port.");
      return;
    }
    if (port === setup.programmingPort) {
      setError("The console capture and the chip probe cannot use the same serial port at the same time.");
      return;
    }
    setError(null);
    setResetWatch(null);
    setBusy("reset");
    try {
      const body = await api<{ assessment: FactoryResetAssessment; disconnected: boolean; followedNewPort: false; erasePerformed: false }>("/api/programmer/factory-reset-watch", {
        method: "POST",
        body: JSON.stringify({ port, seconds: FACTORY_RESET_WATCH_SECONDS, selectedMac: setup.deviceMac }),
      });
      setResetWatch(body.assessment);
      setConsoleText("");
      setLogOpen(true);
      update({
        hardware: body.assessment.affectsStoredCredentials ? "requires_attention" : view.hardware,
        hardwareEvidence: body.disconnected
          ? `${body.assessment.detail} The console port disconnected. A different serial path was not opened.`
          : body.assessment.detail,
        lastHardwareEvidenceAt: new Date().toISOString(),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The factory-reset watch failed");
    } finally {
      setBusy(null);
    }
  }

  async function capture(purpose: "diagnostics" | "reset") {
    const port = setup.consolePort;
    if (!port) {
      setError("Choose the console port. It is separate from the programming port.");
      return;
    }
    if (port === setup.programmingPort) {
      setError("The console capture and the chip probe cannot use the same serial port at the same time.");
      return;
    }
    setError(null);
    setBusy(purpose);
    try {
      const body = await api<{ text: string; erasePerformed: false }>("/api/programmer/console", {
        method: "POST",
        body: JSON.stringify({ port, seconds: 6 }),
      });
      setConsoleText(body.text);
      const next = interpretConsole(body.text, expectedVersion);
      setFindings(next);
      setLogOpen(true);
      if (purpose === "reset") {
        update({
          hardware: next.factoryReset === "pass" ? "requires_attention" : view.hardware,
          hardwareEvidence: next.detail,
          lastHardwareEvidenceAt: new Date().toISOString(),
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The console capture failed");
    } finally {
      setBusy(null);
    }
  }

  const rows = useMemo(() => {
    const check = (id: string) => session?.checks.find((item) => item.id === id);
    const statusText = (value: "pass" | "fail" | "unknown" | undefined) => value === "pass" ? "Pass" : value === "fail" ? "Fail" : "Unknown";
    return [
      { name: "USB ports", status: ports === null ? "Unknown" : ports.length ? "Pass" : "Fail", evidence: ports?.join(", ") || "No port list", at: refreshedAt },
      { name: "Chip identity", status: probe ? (probe.accepted ? "Pass" : "Fail") : "Unknown", evidence: probe?.detail ?? "Probe not run. chip-id can reset the USB interface.", at: refreshedAt },
      { name: "Package validation", status: validation ? (validation.ok ? "Pass" : "Fail") : selected ? "Unknown" : "Unknown", evidence: selected ? `${selected.request.softwareVersionString} / SoftwareVersion ${selected.request.softwareVersion}` : "No compiled package selected", at: refreshedAt },
      { name: "Image written", status: check("write")?.status === "passed" ? "Pass" : check("write")?.status === "failed" ? "Fail" : "Unknown", evidence: check("write")?.detail ?? "No write in this session", at: session?.updatedAt ?? null },
      { name: "Hash verified", status: session?.status === "succeeded" ? "Pass" : session?.status === "failed" ? "Fail" : "Unknown", evidence: session?.message ?? "Hash verification is reported by the write session, separately from boot.", at: session?.updatedAt ?? null },
      { name: "Firmware booted", status: findings ? statusText(findings.boot) : check("boot")?.status === "passed" ? "Pass" : "Unknown", evidence: findings?.detail ?? check("boot")?.detail ?? "Boot was not captured", at: refreshedAt },
      { name: "Firmware identity", status: findings ? statusText(findings.firmwareIdentity) : "Unknown", evidence: findings?.versionText ?? "Not Verified", at: refreshedAt },
      { name: "Matter stack", status: findings ? statusText(findings.matter) : "Unknown", evidence: "A Matter log line is not a fabric or a CASE session.", at: refreshedAt },
      { name: "DHT11 driver", status: findings ? statusText(findings.dht11) : "Unknown", evidence: "Pass or fail only. Readings are not shown as a dashboard.", at: refreshedAt },
      { name: "Panic", status: findings ? (findings.panic === "fail" ? "Fail" : findings.panic === "pass" ? "Pass" : "Unknown") : "Unknown", evidence: findings?.panic === "fail" ? "Panic or abort text was captured." : "No panic text in the current capture.", at: refreshedAt },
      { name: "Factory reset", status: resetWatch?.stage === "verified_fabric_free" ? "Pass" : resetWatch ? "Incomplete" : findings?.factoryReset === "pass" ? "Pass" : findings?.factoryReset === "incomplete" ? "Incomplete" : "Unknown", evidence: resetWatch?.detail ?? findings?.detail ?? "Not observed. A confirmation click is not a reset.", at: refreshedAt },
    ];
  }, [findings, ports, probe, refreshedAt, resetWatch, selected, session, validation]);

  function reportText(): string {
    return diagnosticReport([
      `Programming port: ${setup.programmingPort ?? "none"}`,
      `Console port: ${setup.consolePort ?? "none"}`,
      `Chip: ${chip ? `${chip.model} ${chip.revision}` : "Not Verified"}`,
      `MAC: ${probe?.accepted ? macAddress(probe.detail) : "Not Verified"}`,
      ...rows.map((row) => `${row.name}: ${row.status}. ${row.evidence} Time: ${formatLocalDateTime(row.at)}`),
      consoleText ? `Console:\n${consoleText}` : "Console: not captured",
    ]);
  }

  async function loadFullWriteLog() {
    if (!session) return;
    try {
      const body = await api<{ tail: string }>(`/api/programmer/sessions/${session.id}/log`);
      setFullWriteLog(body.tail || "Not Verified");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The programming log could not be read");
    }
  }

  async function copyReport() {
    await navigator.clipboard.writeText(reportText());
  }

  function exportReport() {
    const blob = new Blob([reportText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "iotedu-hardware-report.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  const explicitNew = params.get("draft") === "new";
  const selectedRecordId = params.get("node") ?? (explicitNew ? NEW_NODE : loadSelectedNodeId(window.localStorage));
  const setupMode = explicitNew ? "new" : params.get("mode") === "reflash" || nodes.some((node) => node.id === selectedRecordId) ? "reflash" : "new";
  const portStillConnected = devices.some((device) => device.path === setup.programmingPort && device.role !== "console");
  const liveMac = probeLive && probe?.accepted ? macFromDeviceLog(probe.detail) : null;
  const liveIdentity = identifiedHardware({
    probeAccepted: probeLive && probe?.port === setup.programmingPort,
    mac: liveMac,
    port: setup.programmingPort,
    connected: portStillConnected,
  });
  const displayedIdentity = liveIdentity ? "verified" : setup.deviceMac && setup.deviceIdentity !== "unknown" ? "historical" : "unknown";
  const activeMac = liveMac ?? (displayedIdentity === "historical" ? setup.deviceMac : null);
  const programmingDevice = devices.find((device) => device.path === setup.programmingPort);
  const consoleDevice = devices.find((device) => device.path === setup.consolePort);
  const hardwareMismatch = chip != null && chip.model !== "Not Verified" && chip.model !== "ESP32-H2";
  const wiring = activeType ? wiringFor(activeType, chosenPackage) : [];
  const installGate = installationAllowed({
    nodeType: activeType,
    package: chosenPackage,
    chipModel: chip?.model ?? null,
    flashLabel: chip?.flash ?? null,
    requiredFlashBytes,
    identified: Boolean(liveIdentity),
    planReady: Boolean(plan),
  });
  const bootCheck = session?.checks.find((item) => item.id === "boot") ?? null;
  const bootPassed = bootCheck?.status === "passed";
  const versionPassed = session?.checks.find((item) => item.id === "version")?.status === "passed";
  const buildCurrent = chosenPackage == null || chosenPackage.buildId === session?.buildId;
  const smartHomeReady = Boolean(activeMac) && sessionMac(session) === activeMac && session?.status === "succeeded" && firmwareReady(session.checks);
  const installVerified = Boolean(activeMac) && sessionMac(session) === activeMac && session?.status === "succeeded" && bootPassed && versionPassed && buildCurrent;
  const visibleChecks = displayedStartupChecks(session?.checks ?? [], session?.monitorLog ?? "");
  const headline = installationHeadline(visibleChecks, session?.status ?? null, session?.message ?? null);
  const step = currentSetupStep({ identified: displayedIdentity !== "unknown", bootVerified: installVerified });
  const flashDisabled = !writeAck || busy != null || session?.status === "running";
  const installStage = activeInstallStage({
    validating: busy === "validate",
    confirming: false,
    sessionStatus: session?.status === "interrupted" ? "failed" : session?.status === "running" ? "running" : session?.status === "succeeded" ? "succeeded" : session?.status === "failed" ? "failed" : null,
    sessionStage: busy === "verify-boot" ? "monitoring" : session?.stage ?? null,
    boot: bootPassed ? "passed" : bootCheck?.status === "failed" ? "failed" : session ? "unknown" : null,
    verified: smartHomeReady,
  });
  const erase = eraseControl(liveIdentity);
  const mac = activeMac;

  const olderThanNode = live?.softwareVersion != null && selected != null && selected.request.softwareVersion < live.softwareVersion;

  const stepState = (index: 1 | 2 | 3): "Not Started" | "In Progress" | "Completed" | "Action Required" | "Failed" => {
    if (index === 1 && (busy === "identify" || setup.hardware === "failed") && displayedIdentity === "unknown") return busy === "identify" ? "In Progress" : "Failed";
    if (index === 1 && connectionHelp && displayedIdentity === "unknown") return "Action Required";
    if (index === 2 && (busy === "validate" || busy === "flash" || session?.status === "running")) return "In Progress";
    if (index === 2 && session?.status === "failed") return "Failed";
    if (index < step) return "Completed";
    if (index > step) return "Not Started";
    if (index === 3 && setup.appleHomeConfirmedAt) return "Completed";
    if (index === 3 && installVerified) return "Action Required";
    return "Action Required";
  };
  const connection = probe?.accepted
    ? "Answered"
    : connectionHelp
      ? "No serial data"
      : setup.programmingPort
        ? "Port selected"
        : ports === null
          ? "Not started"
          : ports.length
            ? "USB port present"
            : "No USB port";

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <h1>Setup</h1>
          <p className="lede">{setupMode === "reflash" ? "Re-flash Existing Node. A normal write keeps Matter commissioning data in NVS." : "First-Time Installation. Selecting this path does not create a commissioned node."}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy != null}>Refresh Hardware Status</button>
      </header>
      <WorkflowStrip setup={view} />
      <p>Current step: {SETUP_STEP_LABELS[step - 1]}.</p>
      {error && <p className="banner bad" role="alert">{error}</p>}

      <div className="setup-pair">
      <section className="panel stack" id="identify-hardware">
        <h2>Step 1 — Identify Hardware <span className={`pill ${stepState(1) === "Completed" ? "passed" : stepState(1) === "Failed" ? "failed" : stepState(1) === "In Progress" ? "running" : "not_tested"}`}>{stepState(1)}</span></h2>
        <div className="row identify-row">
          <button type="button" className="secondary" onClick={() => void refresh()} disabled={busy != null}>Detect Connected USB Devices</button>
          <label>
            Programming interface
            <select
              aria-label="Programming port"
              value={setup.programmingPort ?? ""}
              onChange={(event) => {
                setProbeLive(false);
                setProbe(null);
                setPlan(null);
                setEraseOpen(false);
                update({
                  programmingPort: event.target.value || null,
                  hardwareEvidence: null,
                  hardware: "not_verified",
                  deviceIdentity: setup.deviceIdentity === "verified" ? "historical" : setup.deviceIdentity,
                });
              }}
            >
              <option value="">No device</option>
              {devices.map((item) => <option key={item.path} value={item.path}>{item.label} — {item.path} — {item.busy ? item.ownedByApplication ? "In use by IoT.Edu" : "In use" : "Available"}</option>)}
            </select>
          </label>
          <label>
            Console port
            <select aria-label="Console port" value={setup.consolePort ?? ""} onChange={(event) => update({ consolePort: event.target.value || null })}>
              <option value="">No console</option>
              {devices.map((item) => <option key={`console-${item.path}`} value={item.path}>{item.label} — {item.path} — {item.busy ? item.ownedByApplication ? "In use by IoT.Edu" : "In use" : "Available"}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void identify()} disabled={!setup.programmingPort || programmingDevice?.busy === true || busy != null || toolchain?.available === false}>Identify Hardware</button>
        </div>
        {toolchain && !toolchain.available && (
          <div className="banner bad" role="alert">
            <p>{toolchain.detail}</p>
            <button type="button" className="secondary" onClick={() => void refresh()} disabled={busy != null}>Retry programming tools</button>
          </div>
        )}
        {programmingDevice?.busy && (
          <p className="banner bad" role="alert">
            {programmingDevice.ownedByApplication
              ? "IoT.Edu already has the programming port open."
              : `The programming port is open in ${occupantLabel(programmingDevice)}. Close that program, then detect devices again.`}
          </p>
        )}
        {consoleDevice?.busy && !consoleDevice.ownedByApplication && (
          <p className="banner">The UART console is open in {occupantLabel(consoleDevice)}. IoT.Edu will not close that program. Identification can continue.</p>
        )}
        {consoleDevice?.ownedByApplication && (
          <div className="banner">
            <p>IoT.Edu has this console session open.</p>
            <button type="button" className="secondary" onClick={() => void releaseConsole()} disabled={busy != null}>Stop IoT.Edu console session</button>
          </div>
        )}
        {busy === "identify" && <p>Identifying the connected chip.</p>}
        <dl className="facts">
          <div><dt>Identity</dt><dd>{identityLabel(displayedIdentity)}</dd></div>
          <div><dt>Chip model</dt><dd>{chip?.model && chip.model !== "Not Verified" ? chip.model : setup.deviceModel ?? "Not Verified"}</dd></div>
          <div><dt>Hardware revision</dt><dd>{chip?.revision && chip.revision !== "Not Verified" ? chip.revision : setup.deviceRevision ?? "Not Verified"}</dd></div>
          <div><dt>Flash capacity</dt><dd>{chip?.flash && chip.flash !== "Not Verified" ? chip.flash : setup.deviceFlash ?? "Not Verified"}</dd></div>
          <div><dt>MAC address</dt><dd>{mac ?? "Not Verified"}</dd></div>
          <div><dt>Connection status</dt><dd>{connection}</dd></div>
          {setup.deviceMac && displayedIdentity === "unknown" && <div><dt>Saved history</dt><dd>{setup.deviceMac}. This probe did not confirm it.</dd></div>}
        </dl>
        {probe?.accepted && probeLive && <p>ESP32-H2 identity verified using ROM download mode. Application boot status has not been checked. Flash was not erased. This probe enters download mode. It does not show that the chip was already stuck there.</p>}
        {connectionHelp && (
          <div className="banner" role="alert">
            <p>{setup.programmingPort ? "The programming port is present, but the ESP32-H2 did not return serial data." : "No ESP32-H2 programming interface is connected."} Entering download mode does not erase flash and is not a Matter factory reset.</p>
            <ol>
              <li>Disconnect and reconnect the programming USB cable, then click Detect Connected USB Devices.</li>
              <li>Confirm the programming port is the ESP32-H2 programming interface, not the UART console.</li>
              <li>On this ESP32-H2 Supermini, hold BOOT (GPIO9), press and release RESET, then release BOOT. Holding BOOT for five seconds is the Matter factory reset and is not required here.</li>
              <li>Click Retry Identification once. IoT.Edu does not repeat the probe by itself.</li>
            </ol>
            <button type="button" onClick={() => void identify()} disabled={busy != null || toolchain?.available === false}>Retry Identification</button>
          </div>
        )}
        <details>
          <summary>Diagnostics</summary>
          <p>Identified {formatLocalDateTime(setup.lastHardwareEvidenceAt)}. A probe can reset the USB programming interface into download mode.</p>
          <pre className="log" tabIndex={0}>{probe?.accepted ? probe.detail : "No identification log yet."}</pre>
        </details>
      </section>

      <section className="panel stack" id="install-firmware">
        <h2>Step 2 — Configure & Install Firmware <span className={`pill ${stepState(2) === "Completed" ? "passed" : stepState(2) === "Failed" ? "failed" : stepState(2) === "In Progress" ? "running" : "not_tested"}`}>{stepState(2)}</span></h2>
        {!liveIdentity && !setup.deviceMac && <p className="banner">Identify the connected ESP32-H2 before writing firmware.</p>}
        {nodeTypeError && <p className="banner bad">{nodeTypeError}</p>}
        <label>
          Node Type
          <select
            aria-label="Node type"
            value={nodeTypeId ?? ""}
            onChange={(event) => {
              const id = event.target.value || null;
              setNodeTypeId(id);
              setValidation(null);
              setPlan(null);
              const next = nodeTypes?.find((item) => item.id === id) ?? null;
              update({ selectedBuildId: packageAfterTypeChange(next) });
            }}
          >
            <option value="">Select a Node Type</option>
            {(nodeTypes ?? []).map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        {nodeTypes && nodeTypes.length === 0 && !nodeTypeError && <p>The firmware catalogue has no Node Types.</p>}
        {activeType && (
          <div className="stack tight">
            <p><strong>{activeType.statusLabel}</strong> · {activeType.category} · {activeType.name}</p>
            <p>{activeType.description}</p>
            <p>{activeType.matterCore.name} revision {activeType.matterCore.revision} and {activeType.device.name} revision {activeType.device.revision}. Matter endpoints are created by the host: {activeType.endpoints.length ? activeType.endpoints.join(", ") : "none recorded"}.</p>
            {activeType.pendingReason && <p className="banner">{activeType.pendingReason} Installation stays disabled. Compilation does not start from Setup.</p>}
          </div>
        )}
        {activeType && activeType.packages.length > 1 && (
          <label>
            Firmware Package
            <select
              aria-label="Firmware package"
              value={chosenPackage?.buildId ?? ""}
              onChange={(event) => {
                setValidation(null);
                setPlan(null);
                update({ selectedBuildId: event.target.value || null });
              }}
            >
              <option value="">Select a firmware package</option>
              {activeType.packages.map((item) => (
                <option key={item.buildId} value={item.buildId}>{item.softwareVersionString} · SoftwareVersion {item.softwareVersion} · {releaseLabel(item.releaseState)} · {item.buildStatus}</option>
              ))}
            </select>
          </label>
        )}
        {activeType && activeType.packages.length === 1 && chosenPackage && (
          <p>{chosenPackage.softwareVersionString} · SoftwareVersion {chosenPackage.softwareVersion} · {releaseLabel(chosenPackage.releaseState)} · {chosenPackage.buildStatus}. This is the only compatible package for this Node Type.</p>
        )}
        {activeType && activeType.packages.length === 0 && <p>No compiled firmware package is currently available for this Node Type.</p>}
        {chosenPackage?.releaseState === "release_candidate" && <p>This package is a release candidate. It can be installed manually. It has not been published and it has not been hardware-verified.</p>}
        {chosenPackage?.legacy && <p>This is a previously compiled package. It is not a Neon release record, and it is offered only for this Node Type.</p>}
        {activeType && (
          <div>
            <h3>GPIO configuration</h3>
            <ul>
              {wiring.map((pin) => (
                <li key={`${pin.name}-${pin.gpio}`}>{pin.name}: GPIO {pin.gpio ?? "unset"}. {pin.description} {pin.source === "compiled-package" ? "This is the wiring in the selected binary." : activeType.packages.length > 0 ? "This is the catalogue default until a package is selected." : "This is the catalogue requirement. No binary has been compiled for it."}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3>Connected hardware</h3>
          <dl className="facts">
            <div><dt>Board</dt><dd>{liveIdentity ? `${chip?.model ?? "ESP32-H2"} on ${setup.programmingPort || "no programming port"}` : "Not identified in this session"}</dd></div>
            <div><dt>Flash</dt><dd>{chip?.flash && chip.flash !== "Not Verified" ? chip.flash : "Not read"}</dd></div>
            <div><dt>Package flash</dt><dd>{(requiredFlashBytes / (1024 * 1024)).toLocaleString("en-AU")} MB</dd></div>
          </dl>
          {hardwareMismatch && <p className="banner bad">The connected chip is not an ESP32-H2.</p>}
        </div>
        {olderThanNode && <p className="banner">The selected package is older than the stored Matter SoftwareVersion.</p>}
        {!installGate.allowed && installGate.reason !== "Select a Node Type before installing firmware." && installGate.reason !== "Identify the connected ESP32-H2 before writing firmware." && <p className="banner">{installGate.reason}</p>}
          <div className="write-action">
            <label className="choice">
              <input type="checkbox" checked={writeAck} onChange={(event) => setWriteAck(event.target.checked)} />
              <span>I understand this reboots the commissioned device and does not remove its Matter fabrics.</span>
            </label>
            <button type="button" onClick={() => void flash()} disabled={flashDisabled}>Write and Flash Firmware</button>
          </div>
          {installStage && (
            <ol className="steps install-progress" aria-label="Installation progress">
              {INSTALL_STAGES.map((stage) => {
                const stageIndex = INSTALL_STAGES.indexOf(stage);
                const currentIndex = INSTALL_STAGES.indexOf(installStage);
                const finished = stage === "Complete" && stage === installStage;
                const state = finished ? "done" : stage === installStage ? "active" : stageIndex < currentIndex ? "done" : "pending";
                const label = finished ? "Complete" : stage === installStage ? "Current" : stageIndex < currentIndex ? "Done" : "Waiting";
                return (
                  <li key={stage} data-state={state}>
                    <span className="step-state">{label}</span>
                    {finished ? null : stage}
                  </li>
                );
              })}
            </ol>
          )}
        {headline && <h3>{headline}</h3>}
        {session?.status === "succeeded" && !smartHomeReady && (
          <div className="stack">
            {consoleDevice?.busy && !consoleDevice.ownedByApplication && (
              <p className="banner">The UART console is open in {occupantLabel(consoleDevice)}. Close that serial monitor, then retry. IoT.Edu will not close it.</p>
            )}
            <p className="muted">Retry opens the console, then resets the application, and keeps listening through the bootloader until the application log appears. A ROM banner alone does not finish the check. The USB programming port can be the console for this firmware. Retry does not reflash, erase NVS, or hold GPIO9. If the automatic reset does not finish, press RESET once. Do not hold BOOT.</p>
            <div className="actions">
              <button type="button" onClick={() => void retryBoot()} disabled={busy != null || (!setup.consolePort && !setup.programmingPort)}>Retry Boot Verification</button>
            </div>
            {busy === "verify-boot" && <p>Listening for startup.</p>}
          </div>
        )}
        {session && sessionMac(session) === activeMac && (
          <div>
            <h3>Installation result</h3>
            <p>{headline ?? session.message}</p>
            <dl className="facts">
              <div><dt>Physical MAC</dt><dd>{sessionMac(session) ?? "Not Verified"}</dd></div>
              <div><dt>Firmware</dt><dd>{session.softwareVersionString}</dd></div>
              <div><dt>Package</dt><dd>{session.buildId}</dd></div>
              <div><dt>Mode</dt><dd>{session.intent}</dd></div>
              <div><dt>Session</dt><dd>{session.id}</dd></div>
              <div><dt>Duration</dt><dd>{sessionDuration(session.createdAt, session.updatedAt)}</dd></div>
              <div><dt>Boot verification</dt><dd>{bootPassed ? "Verified from the UART console" : bootCheck?.status === "failed" ? "Failed" : "Not Verified"}</dd></div>
            </dl>
            <div className="background-process" aria-hidden="true">
              <table>
                <caption>Images recorded for this USB write</caption>
                <thead><tr><th>Image</th><th>Offset</th><th>Bytes</th><th>Hash</th><th>Time</th></tr></thead>
                <tbody>
                  {(session.flashImages ?? []).map((image) => (
                    <tr key={image.offset}>
                      <td>{image.label}</td>
                      <td>{`0x${image.offset.toString(16)}`}</td>
                      <td>{image.bytes == null ? "Not Verified" : image.bytes.toLocaleString("en-AU")}</td>
                      <td>{image.hashVerified ? "Verified" : "Not Verified"}</td>
                      <td>{image.seconds == null ? "Not recorded" : `${image.seconds}s`}</td>
                    </tr>
                  ))}
                  {(session.flashImages ?? []).length === 0 && <tr><td colSpan={5}>Not Verified. This session has no recorded flash image.</td></tr>}
                </tbody>
              </table>
              {missingFlashOffsets(session.flashImages ?? []).length > 0 && <p>Not Verified at {missingFlashOffsets(session.flashImages ?? []).map((offset) => `0x${offset.toString(16)}`).join(", ")}. A missing hash result is not a successful write.</p>}
              {headline === "Unable to verify firmware boot. Flash contents were verified, but no application startup was observed." && (
                <p>The USB write finished and the image hashes were verified. No application startup was captured. Matter commissioning has not been performed. Retry can use this USB port and does not write flash again.</p>
              )}
              <h3>Verification stages</h3>
              <ul>
                {firmwareStartupStages({ writeCompleted: session.status === "succeeded", checks: displayedStartupChecks(session.checks, session.monitorLog), monitorLog: session.monitorLog }).map((stage) => (
                  <li key={stage.id}>{stage.label}: {stage.status === "passed" ? "Passed" : stage.status === "failed" ? "Failed" : stage.status === "not_reached" ? "Not reached" : stage.status === "not_applicable" ? "Not applicable" : "Not verified"}. {stage.detail}</li>
                ))}
              </ul>
              <ul>
                {displayedStartupChecks(session.checks, session.monitorLog).filter((item) => item.id !== "factory_reset").map((item) => (
                  <li key={item.id}>{item.label}: {item.status === "passed" ? "Verified" : item.status === "failed" ? "Failed" : item.id === "matter" || item.id === "openthread" ? "Not yet performed" : "Not Verified"}</li>
                ))}
              </ul>
              {session.monitorLog.trim() && (
                <div>
                  <h3>Console capture</h3>
                  <dl className="facts">
                    {bootCaptureReport(session.monitorLog, session.consolePort ?? session.port).map((item) => (
                      <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          </div>
        )}
        <details>
          <summary>Diagnostics</summary>
          {validation && <p>{validation.ok ? "Package validation passed." : "Package validation failed."}</p>}
          {validation && validation.issues.length > 0 && <ul>{validation.issues.map((issue) => <li key={issue.code}>{issue.level}: {issue.message}</li>)}</ul>}
          {selected && <ul>{selected.artifacts.map((item) => <li key={item.name}>{item.name} · {item.size.toLocaleString("en-AU")} bytes</li>)}</ul>}
          <pre className="log" tabIndex={0}>{[session?.logs.join("\n"), session?.monitorLog].filter(Boolean).join("\n") || "No firmware log yet."}</pre>
          {session && <button type="button" className="secondary" onClick={() => void loadFullWriteLog()}>Show programming log</button>}
          {fullWriteLog && <pre className="log" tabIndex={0}>{fullWriteLog}</pre>}
        </details>
      </section>

      <section className="panel stack" id="connect-smart-home">
        <h2>Step 3 — Connect to Smart Home <span className={`pill ${stepState(3) === "Completed" ? "passed" : "not_tested"}`}>{stepState(3)}</span></h2>
        {installVerified ? (
          <div className="stack">
            <p>The application boot and firmware version were verified for this board and this image. Smart Home Connection shows Matter readiness and does not start pairing.</p>
            <div className="actions">
              <Link className="button" to={smartHomeTarget({ name: configName, firmware: selected?.request.softwareVersionString ?? session?.softwareVersionString ?? null, softwareVersion: selected?.request.softwareVersion ?? null, mac: activeMac })}>Connect to Smart Home</Link>
            </div>
          </div>
        ) : (
          <div>
            <p>{headline === "Application boot verified. Matter startup was not reached." ? "USB installation, flash integrity, and application entry are separate from Matter. Smart Home Connection shows those stages and does not invent a commissioning QR." : headline === "Firmware Installed — Verification Failed." ? "A startup check failed, so Smart Home Connection stays closed. Commissioning is not inferred from a boot log." : headline === "Unable to verify firmware boot. Flash contents were verified, but no application startup was observed." ? "Flash hashes were verified. Smart Home Connection stays closed until the UART console shows the application boot. Commissioning has not been performed." : !buildCurrent ? "The selected firmware package is not the image in the verified boot session. Smart Home Connection stays closed for that selection." : "Connect to Smart Home opens after the installed firmware reports a successful application boot and matching version."}</p>
            <button type="button" disabled>Connect to Smart Home</button>
          </div>
        )}
      </section>
      </div>

      <details className="panel stack danger-zone" onToggle={(event) => setRecoveryOpen(event.currentTarget.open)}>
        <summary>Advanced Device Recovery</summary>
        <p className="muted">Maintenance and recovery. Nothing here runs during ordinary installation. Backup before erase stays inside Full Flash Erase.</p>
        <section className="recovery-option">
          <h3>Prepare Matter Factory Reset</h3>
          <p>This watches the console for up to {FACTORY_RESET_WATCH_SECONDS} seconds. It does not press BOOT and it does not erase or reflash the firmware. GPIO9 is active-low. This firmware treats a five-second hold as the long press, then starts the Matter factory reset when you release the button. A short press does not reset the device.</p>
          {reconciliation && <p>{reconciliation}</p>}
          <label className="choice">
            <input type="checkbox" checked={resetApproved} onChange={(event) => setResetApproved(event.target.checked)} />
            <span>I approve starting the factory-reset console watch for this board.</span>
          </label>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setResetGuidance((open) => !open)}>Show procedure</button>
            <button type="button" className="danger" onClick={() => { setResetGuidance(true); void prepareFactoryReset(); }} disabled={!resetApproved || !setup.consolePort || busy != null}>Prepare Matter Factory Reset</button>
          </div>
          {busy === "reset" && <p role="status">Watching the console. {watchElapsed}s of {FACTORY_RESET_WATCH_SECONDS}s. Leave this console connected. Hold BOOT (GPIO9) until the board asks you to release it, then release it.</p>}
          {resetGuidance && (
            <ol>
              <li>Start this watch before touching the button. The selected console is {setup.consolePort ?? "not chosen"}.</li>
              <li>Removing the accessory in Apple Home does not clear a device-side fabric. The board reset does not delete the Home app entry.</li>
              <li>Leave the board powered. Hold BOOT (GPIO9) for five seconds. Release it when the watch is still running.</li>
              <li>A reset is verified only when the following boot retrieves no stored fabric. A reboot, or the five-second hold by itself, is not success.</li>
              <li>If this console disconnects, the watch stops. IoT.Edu will not switch to another serial port.</li>
            </ol>
          )}
          {resetWatch && <p className="banner">{resetWatch.headline}. {resetWatch.detail}{resetWatch.bleAdvertising ? " CHIPoBLE advertising was seen." : ""}{resetWatch.commissioningMode != null ? ` Commissioning mode ${resetWatch.commissioningMode}.` : ""}</p>}
        </section>
        <section className="recovery-option">
          <h3>Full Flash Erase</h3>
          <button type="button" className="danger" disabled={!erase.enabled} onClick={() => setEraseOpen(true)}>
            <span>{erase.label}</span>
          </button>
          {eraseOpen && (
            <RecoveryErase
              active={eraseOpen}
              programmingPort={setup.programmingPort}
              consolePort={setup.consolePort}
              buildId={selected?.id ?? null}
              buildLabel={selected ? `${selected.request.softwareVersionString} / SoftwareVersion ${selected.request.softwareVersion}` : null}
              onContinue={(device) => {
                if (device?.mac && setup.programmingPort && device.chip === "ESP32-H2") {
                  const megabytes = device.flashSizeBytes ? Math.round(device.flashSizeBytes / (1024 * 1024)) : null;
                  const detail = `Chip is ${device.chip} (revision ${device.revision})\nBASE MAC: ${device.mac}\n${megabytes ? `Detected flash size: ${megabytes}MB\n` : ""}USB mode: USB-Serial/JTAG`;
                  setProbeLive(true);
                  setProbe({ port: setup.programmingPort, accepted: true, detail });
                  update(applyLiveIdentity(setup, {
                    accepted: true,
                    mac: device.mac.toLowerCase(),
                    model: device.chip,
                    revision: device.revision,
                    flash: megabytes ? `${megabytes}MB` : null,
                    at: new Date().toISOString(),
                  }, sessionMac(session)));
                }
                setEraseOpen(false);
                document.getElementById("install-firmware")?.scrollIntoView({ block: "start" });
              }}
            />
          )}
        </section>
        <section className="recovery-option">
          <h3>Local Matter peer recovery</h3>
          <p>A saved management record is retired from Overview with Forget Local Record Only. An unsaved local peer can be retired here after its Matter node id is typed twice. The controller identity stays.</p>
          <label>
            Unsaved Matter node id
            <input value={retireId} onChange={(event) => setRetireId(event.target.value)} autoComplete="off" />
          </label>
          <label>
            Type the same Matter node id to confirm
            <input value={retirePhrase} onChange={(event) => setRetirePhrase(event.target.value)} autoComplete="off" />
          </label>
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={busy != null || !/^[1-9][0-9]{0,17}$/.test(retireId) || retirePhrase !== retireId}
              onClick={() => {
                setBusy("retire");
                setRetireMessage(null);
                void api<{ message: string }>("/api/controller/peers/retire", {
                  method: "POST",
                  body: JSON.stringify({ matterNodeId: retireId, confirm: true, phrase: retirePhrase }),
                }).then((body) => setRetireMessage(body.message))
                  .catch((reason: Error) => setRetireMessage(reason.message))
                  .finally(() => setBusy(null));
              }}
            >
              Retire unsaved local peer
            </button>
          </div>
          {retireMessage && <p className="banner">{retireMessage}</p>}
        </section>
        <section className="recovery-option">
          <h3>Advanced diagnostics</h3>
          <button type="button" className="secondary" onClick={() => setLogOpen((open) => !open)}>{logOpen ? "Hide serial log" : "Show serial log"}</button>
          {logOpen && <pre className="log" tabIndex={0}>{[session?.logs.join("\n"), session?.monitorLog, consoleText].filter(Boolean).join("\n") || "No log captured."}</pre>}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void copyReport()}>Copy Diagnostic Report</button>
            <button type="button" className="secondary" onClick={exportReport}>Export Report</button>
          </div>
          <table>
            <caption className="sr-only">Hardware test results</caption>
            <thead><tr><th>Test</th><th>Result</th><th>Evidence</th><th>Time</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.name}</th>
                  <td>{row.status}</td>
                  <td>{row.evidence}</td>
                  <td>{formatLocalDateTime(row.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </details>
    </section>
  );
}
