import type { AttributeObservation } from "./identity-read.js";

export const DESCRIPTOR_CLUSTER_ID = 0x001d;
export const PARTS_LIST_ATTRIBUTE_ID = 0x0003;
export const DEVICE_TYPE_LIST_ATTRIBUTE_ID = 0x0000;
export const SERVER_LIST_ATTRIBUTE_ID = 0x0001;

export interface ApplicationEndpoint {
  endpointId: number;
  deviceTypes: number[];
  serverClusters: number[];
}

export function interpretApplicationModel(parts: number[], reports: AttributeObservation[]): ApplicationEndpoint[] {
  const endpointIds = [...new Set(parts.filter((endpointId) => Number.isInteger(endpointId) && endpointId >= 0))].slice(0, 16);
  return endpointIds.map((endpointId) => ({
    endpointId,
    deviceTypes: numbersFrom(reportValue(reports, endpointId, DEVICE_TYPE_LIST_ATTRIBUTE_ID), "deviceType"),
    serverClusters: numbersFrom(reportValue(reports, endpointId, SERVER_LIST_ATTRIBUTE_ID), "clusterId"),
  }));
}

export function partsFrom(reports: AttributeObservation[]): number[] {
  const report = reports.find((item) => item.kind === "value" && item.clusterId === DESCRIPTOR_CLUSTER_ID && item.attributeId === PARTS_LIST_ATTRIBUTE_ID);
  return numbersFrom(report?.value, "endpoint");
}

function reportValue(reports: AttributeObservation[], endpointId: number, attributeId: number): unknown {
  return reports.find((item) => item.kind === "value" && item.endpointId === endpointId && item.clusterId === DESCRIPTOR_CLUSTER_ID && item.attributeId === attributeId)?.value;
}

function numbersFrom(value: unknown, named: "deviceType" | "clusterId" | "endpoint"): number[] {
  if (!Array.isArray(value)) return [];
  const numbers: number[] = [];
  for (const item of value) {
    const parsed = oneNumber(item, named);
    if (parsed != null) numbers.push(parsed);
  }
  return numbers;
}

function oneNumber(value: unknown, named: "deviceType" | "clusterId" | "endpoint"): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return oneNumber(value[0], named);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return oneNumber(record[named] ?? record.deviceType ?? record.clusterId ?? record.id, named);
  }
  return null;
}
