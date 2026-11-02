import { z } from "zod";

export const APP_VERSION = "0.1.0";
export const FABRIC_LABEL = "IoT.Edu Management";

export const capabilityStateSchema = z.enum([
  "available",
  "needs_setup",
  "unsupported",
  "mock_only",
  "temporarily_unavailable",
]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const componentStatusSchema = z.enum([
  "verified",
  "experimental",
  "template",
  "planned",
]);
export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const componentTypeSchema = z.enum([
  "sensor",
  "actuator",
  "core",
  "template",
]);
export type ComponentType = z.infer<typeof componentTypeSchema>;

export const kconfigPinSchema = z.object({
  key: z.string().min(1),
  pinName: z.string().min(1),
  default: z.number().int(),
});

export const firmwareBindingSchema = z.object({
  idfComponentDir: z.string().min(1),
  registerFunction: z.string().min(1).nullable(),
  requires: z.array(z.string()),
  kconfig: z.array(kconfigPinSchema),
  matter: z.object({
    endpoints: z.array(z.string()),
    clusters: z.array(z.string()),
  }),
});

export const componentManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  type: componentTypeSchema,
  version: z.string().min(1),
  status: componentStatusSchema,
  source: z.literal("local"),
  target: z.literal("esp32h2"),
  idfCompatibility: z.string().min(1),
  selectableForBuild: z.boolean(),
  firmware: firmwareBindingSchema.nullable(),
});
export type ComponentManifest = z.infer<typeof componentManifestSchema>;

export const checkStatusSchema = z.enum(["passed", "failed", "unknown", "warning"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const readinessSchema = z.enum(["not_checked", "ready", "not_ready", "check_failed"]);
export type Readiness = z.infer<typeof readinessSchema>;

export const preflightCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  readiness: readinessSchema.optional(),
  mandatory: z.boolean(),
  detail: z.string(),
});
export type PreflightCheck = z.infer<typeof preflightCheckSchema>;

export const managedNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  simulated: z.boolean(),
  matterNodeId: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  productId: z.number().int().nullable(),
  softwareVersion: z.number().int().nullable(),
  softwareVersionString: z.string().nullable(),
  hardwareMac: z.string().nullable().optional(),
  hardware: z.string(),
  reachable: z.boolean().nullable(),
  fabricLabel: z.string(),
  commissionedFabricCount: z.number().int().nullable(),
  otherFabricCount: z.number().int().nullable(),
  partitionLayoutId: z.string().nullable(),
  hardwareVersion: z.number().int().nullable().optional(),
  hardwareVersionString: z.string().nullable().optional(),
  connection: z.enum(["commissioned", "reachable", "offline", "unknown"]).optional(),
  lastCommunicationAt: z.string().nullable().optional(),
  presence: z.enum(["online", "unreachable", "checking", "unknown", "stale"]).optional(),
  lastSuccessfulCommunicationAt: z.string().nullable().optional(),
  lastFailedCommunicationAt: z.string().nullable().optional(),
  lastReachabilityCheckAt: z.string().nullable().optional(),
  reachabilityError: z.string().nullable().optional(),
  firmwareUpdateEligible: z.boolean().nullable().optional(),
  managementFabricId: z.string().nullable().optional(),
  installedComponents: z.array(z.string()),
  history: z.array(
    z.object({
      at: z.string(),
      kind: z.string(),
      detail: z.string(),
    }),
  ),
  operationalReverification: z.enum(["required"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedNode = z.infer<typeof managedNodeSchema>;

export const commissionRequestSchema = z.object({
  path: z.enum(["new_device", "smart_home"]),
  name: z.string().min(1).max(80),
  pairingCode: z.string().max(512).optional(),
  confirm: z.literal(true),
  acknowledgeSimulation: z.literal(true).optional(),
  preserveUnresolvedPeers: z.literal(true).optional(),
  expectedHardwareMac: z.string().max(32).optional(),
});
export type CommissionRequest = z.infer<typeof commissionRequestSchema>;

export const commissionResultSchema = z.object({
  simulated: z.boolean(),
  matterSessionOpened: z.boolean(),
  node: managedNodeSchema,
  message: z.string(),
  limitation: z.string().nullable(),
}).refine((result) => result.simulated !== result.matterSessionOpened, {
  message: "A simulated record cannot be a live Matter session",
});
export type CommissionResult = z.infer<typeof commissionResultSchema>;

export const recoverExistingRequestSchema = z.object({
  name: z.string().min(1).max(80),
  confirm: z.literal(true),
  matterNodeId: z.string().min(1).max(80).optional(),
  expectedHardwareMac: z.string().max(32).optional(),
  expectedVendorId: z.number().int().nonnegative().optional(),
  expectedProductId: z.number().int().nonnegative().optional(),
  expectedSoftwareVersion: z.number().int().nonnegative().optional(),
  expectedSoftwareVersionString: z.string().max(32).optional(),
  registerWithoutHardwareLink: z.boolean().optional(),
});
export type RecoverExistingRequest = z.infer<typeof recoverExistingRequestSchema>;

export const commissionProgressSchema = z.object({
  stage: z.enum([
    "validating_code",
    "discovering",
    "operational_case",
    "verifying_firmware",
    "ready",
    "failed",
    "locate_peer",
    "discover_operational",
    "case_session",
    "read_basic_information",
    "verify_identity",
    "management_ready",
    "register_node",
  ]),
  message: z.string(),
});
export type CommissionProgress = z.infer<typeof commissionProgressSchema>;

export const controllerStatusSchema = z.object({
  identityLoaded: z.boolean(),
  persisted: z.boolean(),
  fabricLabel: z.string(),
  fabricId: z.string().nullable(),
  credentialId: z.string().nullable(),
  controllerNodeId: z.string().nullable(),
  matterJsVersion: z.string().nullable(),
  regenerationBlocked: z.boolean(),
  message: z.string(),
  backup: z.string(),
});
export type ControllerStatus = z.infer<typeof controllerStatusSchema>;

export const refreshResultSchema = z.object({
  node: managedNodeSchema,
  liveRead: z.enum(["unavailable", "read", "failed"]),
  message: z.string(),
});
export type RefreshResult = z.infer<typeof refreshResultSchema>;

export interface ControllerReconciliationPlan {
  controllerIdentityPreserved: boolean;
  identityReady: boolean;
  executed: false;
  credentialStoreEdited: false;
  peers: Array<{
    matterNodeId: string;
    commissionedAt: number | null;
    savedNodeId: string | null;
    role: "saved-managed-node" | "unsaved-stale-peer";
  }>;
  retireAfterFactoryReset: string;
  notUsed: string[];
  blocker: string | null;
}

export const commissioningWindowResultSchema = z.object({
  opened: z.boolean(),
  message: z.string(),
  manualPairingCode: z.string().optional(),
  qrPairingCode: z.string().optional(),
  durationSeconds: z.number().int().positive().optional(),
  openedAt: z.string().optional(),
});
export type CommissioningWindowResult = z.infer<typeof commissioningWindowResultSchema>;

export const buildModeSchema = z.enum(["mock", "native", "docker"]);
export type BuildMode = z.infer<typeof buildModeSchema>;

export const codeSourceSchema = z.enum(["approved", "upload", "ai_draft"]);

export const pinAssignmentSchema = z.object({
  componentId: z.string(),
  pinName: z.string(),
  gpio: z.number().int(),
});

export const firmwareBuildRequestSchema = z.object({
  mode: buildModeSchema,
  codeSource: codeSourceSchema,
  nodeId: z.string().nullable(),
  hardware: z.literal("esp32h2"),
  baseFirmwareId: z.string(),
  componentIds: z.array(z.string()),
  pins: z.array(pinAssignmentSchema),
  softwareVersion: z.number().int().positive(),
  softwareVersionString: z.string().min(1).max(32),
  uploadId: z.string().nullable(),
  confirm: z.literal(true),
});
export type FirmwareBuildRequest = z.infer<typeof firmwareBuildRequestSchema>;

export const validationIssueSchema = z.object({
  level: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const validationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(validationIssueSchema),
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const jobStatusSchema = z.enum([
  "simulated",
  "blocked",
  "failed",
  "succeeded",
  "interrupted",
  "running",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const firmwareVerificationSchema = z.enum([
  "simulated",
  "compiled",
  "hardware_verified",
]);
export type FirmwareVerification = z.infer<typeof firmwareVerificationSchema>;

export const buildArtifactSchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  simulated: z.boolean(),
  deployable: z.boolean(),
});
export type BuildArtifact = z.infer<typeof buildArtifactSchema>;

export const buildJobSchema = z.object({
  id: z.string(),
  simulated: z.boolean(),
  verification: firmwareVerificationSchema.nullable(),
  status: jobStatusSchema,
  request: firmwareBuildRequestSchema,
  validation: validationResultSchema,
  logs: z.array(z.string()),
  artifacts: z.array(buildArtifactSchema),
  partitionLayoutId: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BuildJob = z.infer<typeof buildJobSchema>;

export const otaRequestSchema = z
  .object({
    nodeId: z.string().min(1),
    buildId: z.string().min(1),
    artifactName: z.string().min(1),
    userApproved: z.boolean(),
    confirm: z.literal(true),
    migrationRisk: z.enum(["A", "B", "C"]).optional(),
    migrationAcknowledged: z.boolean().optional(),
  })
  .strict();
export type OtaRequest = z.infer<typeof otaRequestSchema>;

export const preflightResultSchema = z.object({
  allowed: z.boolean(),
  checks: z.array(preflightCheckSchema),
  message: z.string(),
});
export type PreflightResult = z.infer<typeof preflightResultSchema>;

export const otaStageSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["not_observed", "observed", "inferred", "failed", "interrupted"]),
  detail: z.string(),
});

export const otaVerificationSchema = z.object({
  state: z.enum(["needs_verification", "installed", "not_installed", "unavailable"]),
  softwareVersion: z.number().int().nullable(),
  softwareVersionString: z.string().nullable(),
  vendorId: z.number().int().nullable(),
  productId: z.number().int().nullable(),
  endpointIds: z.array(z.number().int()),
  deviceTypes: z.array(z.object({ endpointId: z.number().int(), deviceType: z.number().int() })),
  detail: z.string(),
  checkedAt: z.string().nullable(),
});
export type OtaVerification = z.infer<typeof otaVerificationSchema>;

export const otaJobSchema = z.object({
  id: z.string(),
  simulated: z.boolean(),
  status: jobStatusSchema,
  request: otaRequestSchema,
  preflight: preflightResultSchema,
  stages: z.array(otaStageSchema),
  matterNodeId: z.string().nullable(),
  expectedSoftwareVersion: z.number().int().nullable(),
  previousSoftwareVersion: z.number().int().nullable(),
  installedVersionConfirmed: z.boolean(),
  message: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verification: otaVerificationSchema.optional(),
});
export type OtaJob = z.infer<typeof otaJobSchema>;

export const otaProviderStatusSchema = z.object({
  running: z.boolean(),
  endpointNumber: z.number().int().nullable(),
  fabricScoped: z.boolean(),
  ledgerOffline: z.boolean(),
  architecture: z.enum(["controller-node-endpoint", "unavailable"]).optional(),
});
export type OtaProviderStatus = z.infer<typeof otaProviderStatusSchema>;

export const otaProviderEventSchema = z.object({
  type: z.enum(["bdx-start", "bdx-progress", "bdx-complete", "bdx-interrupted", "applying", "failed"]),
  matterNodeId: z.string(),
  detail: z.string(),
  bytesTransferred: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().nullable().optional(),
});

export const otaRequestorReportSchema = z.object({
  matterNodeId: z.string(),
  clusterPresent: z.boolean(),
  updatePossible: z.boolean().nullable(),
  updateState: z.number().int().nullable(),
  updateStateProgress: z.number().int().nullable(),
  defaultProviderCount: z.number().int().nullable(),
  announceAccepted: z.boolean().nullable(),
  controllerCanAnnounce: z.boolean().nullable(),
  aclRead: z.enum(["read", "failed", "not_checked"]),
  detail: z.string(),
});
export type OtaRequestorReport = z.infer<typeof otaRequestorReportSchema>;
export type OtaProviderEvent = z.infer<typeof otaProviderEventSchema>;

export const capabilityReportSchema = z.object({
  applicationVersion: z.string(),
  matterCommissioning: capabilityStateSchema,
  bleCommissioning: capabilityStateSchema,
  threadDataset: capabilityStateSchema,
  firmwareBuild: capabilityStateSchema,
  otaProvider: capabilityStateSchema,
  usbFlash: capabilityStateSchema,
  ai: capabilityStateSchema,
  notes: z.array(z.string()),
});
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const renameNodeSchema = z.object({
  name: z.string().min(1).max(80),
  confirm: z.literal(true),
});

export const aiDraftRequestSchema = z.object({
  peripheralName: z.string().min(1),
  interfaceName: z.string().min(1),
  gpioNotes: z.string().min(1),
  behaviour: z.string().min(1),
  matterFunction: z.string().min(1),
  dependencies: z.string(),
});
export type AiDraftRequest = z.infer<typeof aiDraftRequestSchema>;

export interface CatalogRepository {
  list(): Promise<ComponentManifest[]>;
  getById(id: string): Promise<ComponentManifest | null>;
  validate(): Promise<ValidationResult>;
  search(query: string, status?: ComponentStatus): Promise<ComponentManifest[]>;
}

export const removeNodeRequestSchema = z.object({
  mode: z.enum(["decommission", "forget"]),
  confirm: z.literal(true),
  phrase: z.string().min(1).max(80),
});
export type RemoveNodeRequest = z.infer<typeof removeNodeRequestSchema>;

export interface RemoveNodeResult {
  mode: "decommission" | "forget";
  physicalFabricRemoved: boolean;
  localRecordRemoved: boolean;
  message: string;
}

export interface NodeRepository {
  list(): Promise<ManagedNode[]>;
  getById(id: string): Promise<ManagedNode | null>;
  save(node: ManagedNode): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface FirmwareBuildService {
  validate(input: FirmwareBuildRequest): Promise<ValidationResult>;
  build(input: FirmwareBuildRequest): Promise<BuildJob>;
  get(id: string): Promise<BuildJob | null>;
  list(): Promise<BuildJob[]>;
}

export interface MatterManagementService {
  getCapabilities(): Promise<CapabilityReport>;
  getControllerStatus(): Promise<ControllerStatus>;
  createIdentity(): Promise<ControllerStatus>;
  restore(): Promise<void>;
  close(): Promise<void>;
  commission(input: CommissionRequest, onProgress?: (event: CommissionProgress) => void): Promise<CommissionResult>;
  listUnsavedPeers(): Promise<Array<{ matterNodeId: string; commissionedAt: number | null }>>;
  recoverExisting(input: RecoverExistingRequest | string, onProgress?: (event: CommissionProgress) => void): Promise<CommissionResult>;
  refreshNode(nodeId: string): Promise<RefreshResult>;
  removeNode(nodeId: string, input: RemoveNodeRequest): Promise<RemoveNodeResult>;
  retireUnsavedPeer(input: RetirePeerRequest): Promise<RetirePeerResult>;
  reconciliationPlan(): Promise<ControllerReconciliationPlan>;
  openCommissioningWindow(nodeId: string): Promise<CommissioningWindowResult>;
  readInstalledSoftwareVersion(matterNodeId: string): Promise<number | null>;
  readApplicationModel?(matterNodeId: string): Promise<Array<{ endpointId: number; deviceTypes: number[]; serverClusters: number[] }> | null>;
}

export const programIntentSchema = z.enum(["initial_install", "reflash", "commissioned_maintenance"]);
export type ProgramIntent = z.infer<typeof programIntentSchema>;

export const programRequestSchema = z
  .object({
    buildId: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
    port: z.string().min(1).max(128),
    intent: programIntentSchema,
    confirm: z.literal(true),
    preserveNvs: z.literal(true),
    acknowledgeCommissioned: z.boolean().optional(),
  })
  .strict();
export type ProgramRequest = z.infer<typeof programRequestSchema>;

export const startupCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["passed", "failed", "unknown"]),
  detail: z.string(),
});
export type StartupCheck = z.infer<typeof startupCheckSchema>;

export const programSessionSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  port: z.string(),
  intent: programIntentSchema,
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  stage: z.enum(["writing", "monitoring", "idle"]),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  logs: z.array(z.string()),
  monitorLog: z.string(),
  checks: z.array(startupCheckSchema),
  message: z.string(),
  eraseAll: z.literal(false),
  nvsPreserved: z.literal(true),
  hardwareVerified: z.literal(false),
  softwareVersionString: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  baseMac: z.string().nullable().optional(),
  consolePort: z.string().nullable().optional(),
  deviceOnboarding: z.object({
    qrPayload: z.string(),
    manualCode: z.string(),
  }).nullable().optional(),
  onboardingCheck: z.object({
    status: z.enum(["verified", "image_verified", "not_verified", "invalid"]),
    reason: z.string(),
    discriminatorMatched: z.boolean().nullable(),
    vendorMatched: z.boolean().nullable(),
    productMatched: z.boolean().nullable(),
    payloadConsistent: z.boolean().nullable(),
    checkedAt: z.string(),
  }).nullable().optional(),
  flashImages: z.array(z.object({
    label: z.string(),
    offset: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().nullable(),
    hashVerified: z.boolean(),
    seconds: z.number().nullable(),
  })).optional(),
  savedSerialLog: z.string().optional(),
});
export type ProgramSession = z.infer<typeof programSessionSchema>;

export const DOWNLOAD_MODE_WARNING =
  "Inspecting the chip resets the USB programming interface into download mode. This is not a Matter or firmware factory reset, and it does not erase flash.";

export const ERASE_WARNING =
  "Full Flash Erase will remove the firmware, bootloader, partition table, Matter commissioning information, Thread network credentials and other data stored in the ESP32-H2 flash memory. The device will not run its application again until compatible firmware is installed. Existing Apple Home and IoT.Edu commissioning relationships will need to be established again.";

export const recoveryBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  action: z.string(),
});
export type RecoveryBlocker = z.infer<typeof recoveryBlockerSchema>;

export const flashRegionBackupSchema = z.object({
  name: z.string(),
  offset: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  sha256: z.string(),
  classification: z.enum(["factory", "provisioning", "calibration", "operational", "firmware"]),
  state: z.enum(["blank", "present"]),
  requiredForPackage: z.boolean(),
});
export type FlashRegionBackup = z.infer<typeof flashRegionBackupSchema>;

export const flashBackupSchema = z.object({
  id: z.string(),
  mac: z.string(),
  chip: z.string(),
  revision: z.string(),
  flashSizeBytes: z.number().int().positive(),
  flashMode: z.string(),
  flashFrequency: z.string(),
  createdAt: z.string(),
  location: z.string(),
  verified: z.boolean(),
  suitableForRestore: z.boolean(),
  complete: z.boolean(),
  credentialMode: z.enum(["example_dac", "secure_cert", "unknown"]),
  firmwareBuildId: z.string(),
  regions: z.array(flashRegionBackupSchema),
  partitionTableSha256: z.string(),
});
export type FlashBackupRecord = z.infer<typeof flashBackupSchema>;

export const deviceSecuritySchema = z.object({
  known: z.boolean(),
  secureBoot: z.enum(["disabled", "enabled", "unknown"]),
  flashEncryption: z.enum(["disabled", "enabled", "unknown"]),
  downloadMode: z.enum(["allowed", "disabled", "unknown"]),
  usbDownload: z.enum(["allowed", "disabled", "unknown"]),
  reflashable: z.boolean(),
  detail: z.string(),
});
export type DeviceSecurity = z.infer<typeof deviceSecuritySchema>;

export const eraseAssessmentSchema = z.object({
  enabled: z.boolean(),
  blockers: z.array(recoveryBlockerSchema),
  downloadModeWarning: z.string(),
  port: z.string().nullable(),
  consolePort: z.string().nullable(),
  device: z.object({
    connected: z.boolean(),
    chip: z.string(),
    revision: z.string(),
    mac: z.string().nullable(),
    flashSizeBytes: z.number().int().positive().nullable(),
    flashMode: z.string(),
    flashFrequency: z.string(),
    partitionLabels: z.array(z.string()),
    partitionLayoutKnown: z.boolean(),
    programmingPort: z.string(),
  }).nullable(),
  security: deviceSecuritySchema.nullable(),
  backup: flashBackupSchema.nullable(),
  firmware: z.object({
    ready: z.boolean(),
    buildId: z.string().nullable(),
    detail: z.string(),
    credentialMode: z.enum(["example_dac", "secure_cert", "unknown"]),
  }),
  toolchain: z.object({
    available: z.boolean(),
    detail: z.string(),
  }),
  previouslyCommissionedBlocksErase: z.literal(false),
});
export type EraseAssessment = z.infer<typeof eraseAssessmentSchema>;

export const eraseRequestSchema = z.object({
  port: z.string().min(1).max(128),
  consolePort: z.string().min(1).max(128).nullable().optional(),
  buildId: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
  backupId: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
  mac: z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/),
  confirmDevice: z.literal(true),
  confirmBackup: z.literal(true),
  acknowledgeCommissioningLoss: z.literal(true),
  confirm: z.literal(true),
}).strict();
export type EraseRequest = z.infer<typeof eraseRequestSchema>;

export const eraseSessionSchema = z.object({
  id: z.string(),
  port: z.string(),
  buildId: z.string(),
  backupId: z.string(),
  mac: z.string(),
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  verifiedBlank: z.boolean(),
  needsFirmware: z.boolean(),
  hardwareVerified: z.literal(false),
  message: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EraseSession = z.infer<typeof eraseSessionSchema>;

export const retirePeerRequestSchema = z.object({
  matterNodeId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  confirm: z.literal(true),
  phrase: z.string().min(1).max(40),
}).strict();
export type RetirePeerRequest = z.infer<typeof retirePeerRequestSchema>;

export const retirePeerResultSchema = z.object({
  matterNodeId: z.string(),
  localPeerRemoved: z.boolean(),
  savedRecordRemoved: z.literal(false),
  physicalFabricRemoved: z.literal(false),
  message: z.string(),
});
export type RetirePeerResult = z.infer<typeof retirePeerResultSchema>;

export const OTA_LIFECYCLE = [
  { id: "preflight", label: "Preflight completed" },
  { id: "provider_ready", label: "Provider ready" },
  { id: "update_request", label: "Device update request received" },
  { id: "transfer_started", label: "Image transfer started" },
  { id: "transfer_completed", label: "Image transfer completed" },
  { id: "applying", label: "Device applying update" },
  { id: "restart", label: "Device restart or temporary disconnection" },
  { id: "reconnected", label: "Device reconnected" },
  { id: "version_verified", label: "New SoftwareVersion verified" },
] as const;

export {
  DEVELOPMENT_ONBOARDING,
  compiledTestOnboarding,
  commissioningChecksPassed,
  commissioningFromLog,
  currentCommissioningLog,
  decodeMatterPayload,
  hardwareInstallationSchema,
  identifyHardwareMac,
  installationIdentity,
  macFromDeviceLog,
  macSourceSchema,
  missingFlashOffsets,
  elfSha256Matches,
  firmwareStartupStages,
  readDeviceOnboarding,
  COMMISSIONED_WITHOUT_ONBOARDING,
  onboardingDecision,
  readElfSha256Prefix,
  smartHomeCommissioningCopy,
  readAdvertisedOnboarding,
  startupCheckStatus,
  usesCompiledTestDiscriminator,
  verifyOnboarding,
  type CommissioningState,
  type FirmwareStage,
  type FlashImageResult,
  type HardwareInstallation,
  type MacSource,
  type OnboardingDecision,
  type OnboardingVerification,
} from "./hardware-installation.js";

export {
  libraryComponentSchema,
  libraryCreateRequestSchema,
  libraryFileSchema,
  libraryGpioSchema,
  libraryIntegrationSchema,
  libraryStageRequestSchema,
  libraryUpdateRequestSchema,
  libraryValidateRequestSchema,
  libraryValidationResponseSchema,
  type LibraryComponent,
  type LibraryCreateRequest,
  type LibraryFile,
  type LibraryGpio,
  type LibraryIntegration,
  type LibraryStageRequest,
  type LibraryUpdateRequest,
  type LibraryValidateRequest,
  type LibraryValidationResponse,
} from "./firmware-library.js";

export {
  FACTORY_RESET_WATCH_MAX_SECONDS,
  FACTORY_RESET_WATCH_MIN_SECONDS,
  FACTORY_RESET_WATCH_SECONDS,
  GPIO9_LONG_PRESS_MS,
  assessFactoryResetCapture,
  commissioningOverlayFromReset,
  factoryResetConsoleRecovery,
  managedNodeAfterResetDecision,
  type FactoryResetAssessment,
  type FactoryResetStage,
} from "./factory-reset.js";
