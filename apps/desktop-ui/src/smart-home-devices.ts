import type { HardwareInstallation, ManagedNode, OnboardingDecision } from "@iotedu/contracts";
import { COMMISSIONED_WITHOUT_ONBOARDING, onboardingDecision } from "@iotedu/contracts";
import { sameHardwareMac } from "./setup";

const NO_STORED_ONBOARDING = "No stored Matter onboarding payload is available for this device. IoT.Edu does not invent a pairing code.";

export interface SmartHomeChoice {
  mac: string;
  label: string;
  installation: HardwareInstallation | null;
  node: ManagedNode | null;
}

export function nodeForHardware(nodes: ManagedNode[], mac: string | null): ManagedNode | null {
  if (!mac) return null;
  return nodes.find((node) => !node.simulated && sameHardwareMac(node.hardwareMac, mac)) ?? null;
}

/** A management record proves a fabric only when its hardware MAC is this device. */
export function withNodeFabric(installation: HardwareInstallation, node: ManagedNode | null): HardwareInstallation {
  if (!node || node.simulated || !sameHardwareMac(node.hardwareMac, installation.mac)) return installation;
  const fabrics = node.commissionedFabricCount ?? 0;
  const administered = Boolean(node.matterNodeId);
  if (fabrics <= 0 && !administered) return { ...installation, managedNodeId: node.id };
  return {
    ...installation,
    managedNodeId: node.id,
    commissioningState: "commissioned",
    commissioningDetail: installation.deviceOnboarding
      ? "This device has a Matter fabric. The stored code is the original setup code and does not by itself add another administrator."
      : installation.commissioningDetail,
  };
}

export function smartHomeChoices(installations: HardwareInstallation[], nodes: ManagedNode[]): SmartHomeChoice[] {
  const byMac = new Map<string, SmartHomeChoice>();
  const ranked = [...installations].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  for (const installation of ranked) {
    if (!installation.mac) continue;
    const mac = installation.mac.toLowerCase();
    if (byMac.has(mac)) continue;
    const node = nodeForHardware(nodes, mac);
    byMac.set(mac, {
      mac,
      label: deviceLabel(node, mac),
      installation: withNodeFabric(installation, node),
      node,
    });
  }
  for (const node of nodes) {
    if (node.simulated || !node.hardwareMac) continue;
    const mac = node.hardwareMac.toLowerCase();
    const existing = byMac.get(mac);
    if (existing) {
      existing.node = node;
      existing.label = deviceLabel(node, mac);
      if (existing.installation) existing.installation = withNodeFabric(existing.installation, node);
      continue;
    }
    byMac.set(mac, { mac, label: deviceLabel(node, mac), installation: null, node });
  }
  return [...byMac.values()];
}

export function decisionForChoice(choice: SmartHomeChoice | null, unresolved: boolean): OnboardingDecision {
  if (!choice) {
    return {
      show: false,
      payload: null,
      manualCode: null,
      reason: unresolved ? "Select or Identify Device" : NO_STORED_ONBOARDING,
      windowWarning: null,
    };
  }
  if (choice.installation) return onboardingDecision(choice.installation);
  const fabrics = choice.node?.commissionedFabricCount ?? 0;
  if (fabrics > 0 || choice.node?.matterNodeId) {
    return { show: false, payload: null, manualCode: null, reason: COMMISSIONED_WITHOUT_ONBOARDING, windowWarning: null };
  }
  return { show: false, payload: null, manualCode: null, reason: NO_STORED_ONBOARDING, windowWarning: null };
}

export function deviceIsCommissioned(choice: SmartHomeChoice | null, installation: HardwareInstallation | null): boolean {
  if (installation?.commissioningState === "commissioned") return true;
  const fabrics = choice?.node?.commissionedFabricCount ?? 0;
  return fabrics > 0 || Boolean(choice?.node?.matterNodeId);
}

function deviceLabel(node: ManagedNode | null, mac: string): string {
  return node?.name ? `${node.name} — ${mac}` : `ESP32-H2 — ${mac}`;
}
