import { createHash } from "node:crypto";
import pg from "pg";
import { libraryComponentSchema, libraryIntegrationSchema, type LibraryComponent, type LibraryIntegration } from "@iotedu/contracts";
import { gpioAssignmentIssues, STORAGE_LIMIT_BYTES, storageDecision, type StorageLevel } from "./catalogue-policy.js";

const { Pool } = pg;

export interface PendingComponent {
  id: string;
  name: string;
  description: string;
  type: "sensor" | "actuator";
  validationState: string;
  revision: number;
  gpio: { name: string; gpio: number | null; description: string }[];
  files: { path: string; bytes: number; role: string }[];
  summary: string;
}

export interface CatalogueStorage {
  configured: true;
  databaseBytes: number;
  blobBytes: number;
  blobCount: number;
  componentCount: number;
  versionCount: number;
  limitBytes: number;
  percent: number;
  level: StorageLevel;
  message: string;
}

let pool: pg.Pool | null = null;

/** Shown wherever a feature needs the optional PostgreSQL database. */
export const NO_DATABASE_MESSAGE = "No database is connected. Saving Node Types, firmware recipes and release records needs one. See \"Database (optional)\" in the README.";

export function catalogueEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function cataloguePool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 2,
      ssl: { rejectUnauthorized: true },
    });
    pool.on("error", (error: Error) => {
      const code = "code" in error && typeof error.code === "string" ? error.code : "unknown";
      console.error(JSON.stringify({ source: "iotedu-catalogue", message: "Database connection closed.", code }));
    });
  }
  return pool;
}

export async function closeCatalogue(): Promise<void> {
  await pool?.end();
  pool = null;
}

export class CatalogueError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

export async function listPending(): Promise<PendingComponent[]> {
  const result = await cataloguePool().query<{
    component_id: string;
    name: string;
    description: string;
    component_type: "sensor" | "actuator";
    validation_state: string;
    revision: number;
    component_version_id: string;
    notes: string | null;
  }>(`
    SELECT c.component_id, c.name, c.description, c.component_type, v.validation_state, v.revision, v.component_version_id, m.notes
    FROM components c
    JOIN component_versions v ON v.component_id = c.component_id
    LEFT JOIN matter_requirements m ON m.component_version_id = v.component_version_id
    WHERE c.component_type IN ('sensor', 'actuator')
      AND v.validation_state <> 'validated'
      AND v.revision = (SELECT max(revision) FROM component_versions WHERE component_id = c.component_id)
    ORDER BY c.name
  `);
  const pending: PendingComponent[] = [];
  for (const row of result.rows) {
    const gpio = await cataloguePool().query<{ connection_name: string; default_gpio: number | null; description: string }>(
      "SELECT connection_name, default_gpio, description FROM gpio_requirements WHERE component_version_id = $1 ORDER BY connection_name",
      [row.component_version_id],
    );
    const files = await cataloguePool().query<{ relative_path: string; byte_size: number; file_role: string }>(
      `SELECT f.relative_path, b.byte_size, f.file_role
       FROM component_files f JOIN source_blobs b ON b.sha256_hash = f.source_hash
       WHERE f.component_version_id = $1 ORDER BY f.relative_path`,
      [row.component_version_id],
    );
    pending.push({
      id: row.component_id,
      name: row.name,
      description: row.description,
      type: row.component_type,
      validationState: row.validation_state,
      revision: row.revision,
      gpio: gpio.rows.map((pin) => ({ name: pin.connection_name, gpio: pin.default_gpio, description: pin.description })),
      files: files.rows.map((file) => ({ path: file.relative_path, bytes: file.byte_size, role: file.file_role })),
      summary: row.notes ?? "This import is not build-ready.",
    });
  }
  return pending;
}

export async function catalogueStorage(): Promise<CatalogueStorage> {
  const database = await cataloguePool().query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  const blobs = await cataloguePool().query<{ bytes: string; count: string }>("SELECT coalesce(sum(byte_size), 0)::text AS bytes, count(*)::text AS count FROM source_blobs");
  const counts = await cataloguePool().query<{ components: string; versions: string }>("SELECT (SELECT count(*) FROM components)::text AS components, (SELECT count(*) FROM component_versions)::text AS versions");
  const databaseBytes = Number(database.rows[0]?.bytes ?? "0");
  const decision = storageDecision(databaseBytes, 0);
  return {
    configured: true,
    databaseBytes,
    blobBytes: Number(blobs.rows[0]?.bytes ?? "0"),
    blobCount: Number(blobs.rows[0]?.count ?? "0"),
    componentCount: Number(counts.rows[0]?.components ?? "0"),
    versionCount: Number(counts.rows[0]?.versions ?? "0"),
    limitBytes: STORAGE_LIMIT_BYTES,
    percent: Math.round((databaseBytes / STORAGE_LIMIT_BYTES) * 1000) / 10,
    level: decision.level,
    message: decision.message,
  };
}

export interface ImportFile {
  path: string;
  role: "source" | "header" | "build" | "config" | "host_snapshot";
  content: string;
}

export interface ImportComponent {
  id: string;
  name: string;
  description: string;
  type: "matter_core" | "sensor" | "actuator" | "shared_library";
  validationState: "draft" | "validation_required" | "validated" | "incompatible";
  files: ImportFile[];
  gpio: { name: string; peripheral: string; gpio: number | null; constraints: string; description: string }[];
  matter: { endpoints: string[]; clusters: string[]; attributes: string[]; ownedBy: "host" | "component" | "none"; interfaceName: string | null; signature?: string; notes: string };
  dependsOn: { id: string; type: "matter_core" | "shared_library" | "idf_component"; constraint: string }[];
  validation: { errors: number; warnings: number; issues: { level: string; message: string }[]; nativeCompile: string; integrationCompile: string };
  archiveName: string;
}

function fingerprint(files: ImportFile[]): string {
  const lines = files.map((file) => `${file.role}:${file.path}:${createHash("sha256").update(file.content).digest("hex")}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function importComponents(components: ImportComponent[]): Promise<{ inserted: string[]; skipped: string[]; blobCount: number }> {
  const additional = components.reduce((sum, component) => sum + component.files.reduce((inner, file) => inner + Buffer.byteLength(file.content), 0), 0);
  const current = await cataloguePool().query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  const decision = storageDecision(Number(current.rows[0]?.bytes ?? "NaN"), additional * 3);
  if (!decision.allow) throw new CatalogueError(decision.message, 507, "storage_budget");
  const client = await cataloguePool().connect();
  const inserted: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query("BEGIN");
    for (const component of components) {
      const existing = await client.query("SELECT 1 FROM components WHERE component_id = $1", [component.id]);
      if (existing.rowCount) {
        skipped.push(component.id);
        continue;
      }
      await client.query(
        "INSERT INTO components (component_id, name, description, component_type, provenance) VALUES ($1, $2, $3, $4, 'custom_code')",
        [component.id, component.name, component.description, component.type],
      );
      const versionId = `${component.id}-r1`;
      const hash = fingerprint(component.files);
      await client.query(
        `INSERT INTO component_versions (component_version_id, component_id, revision, content_fingerprint, integration, validation_state)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [versionId, component.id, hash, component.matter.interfaceName ? JSON.stringify({ functionName: component.matter.interfaceName, endpointOwnedBy: component.matter.ownedBy }) : null, component.validationState],
      );
      for (const file of component.files) {
        const fileHash = createHash("sha256").update(file.content).digest("hex");
        await client.query(
          `INSERT INTO source_blobs (sha256_hash, content, byte_size) VALUES ($1, $2, $3)
           ON CONFLICT (sha256_hash) DO NOTHING`,
          [fileHash, file.content, Buffer.byteLength(file.content)],
        );
        await client.query(
          "INSERT INTO component_files (component_version_id, relative_path, source_hash, file_role) VALUES ($1, $2, $3, $4)",
          [versionId, file.path, fileHash, file.role],
        );
      }
      for (const pin of component.gpio) {
        await client.query(
          `INSERT INTO gpio_requirements (component_version_id, connection_name, peripheral_function, default_gpio, allowed_gpio_constraints, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [versionId, pin.name, pin.peripheral, pin.gpio, pin.constraints, pin.description],
        );
      }
      await client.query(
        `INSERT INTO matter_requirements (component_version_id, endpoint_types, clusters, attributes, endpoint_owned_by, initialisation_interface, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [versionId, component.matter.endpoints, component.matter.clusters, component.matter.attributes, component.matter.ownedBy, component.matter.interfaceName, component.matter.notes],
      );
      await client.query(
        `INSERT INTO validation_runs (validation_run_id, component_version_id, content_fingerprint, error_count, warning_count, issues, native_compile, integration_compile, toolchain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`${versionId}-import`, versionId, hash, component.validation.errors, component.validation.warnings, JSON.stringify(component.validation.issues), component.validation.nativeCompile, component.validation.integrationCompile, "esp-idf-v5.4.1"],
      );
      for (const dependency of component.dependsOn) {
        await client.query(
          `INSERT INTO component_dependencies (component_version_id, dependency_component_id, dependency_version_constraint, dependency_type)
           VALUES ($1, $2, $3, $4)`,
          [versionId, dependency.id, dependency.constraint, dependency.type],
        );
      }
      await client.query(
        "INSERT INTO import_audits (import_id, archive_name, component_version_id, report) VALUES ($1, $2, $3, $4)",
        [`${versionId}-audit`, component.archiveName, versionId, JSON.stringify({ validationState: component.validationState })],
      );
      inserted.push(component.id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const blobs = await cataloguePool().query<{ count: string }>("SELECT count(*)::text AS count FROM source_blobs");
  return { inserted, skipped, blobCount: Number(blobs.rows[0]?.count ?? "0") };
}

function recordedIssues(value: unknown): LibraryComponent["validation"]["issues"] {
  if (!Array.isArray(value)) return [];
  const issues: LibraryComponent["validation"]["issues"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { level?: unknown; code?: unknown; message?: unknown; file?: unknown; line?: unknown };
    const level = row.level === "warning" || row.level === "info" || row.level === "error" ? row.level : null;
    if (!level || typeof row.message !== "string" || row.message.length === 0) continue;
    const issue: LibraryComponent["validation"]["issues"][number] = {
      level,
      code: typeof row.code === "string" && row.code.length > 0 ? row.code : "recorded",
      message: row.message.slice(0, 500),
    };
    if (typeof row.file === "string" && row.file.length > 0 && row.file.length <= 240) issue.file = row.file;
    if (typeof row.line === "number" && Number.isInteger(row.line) && row.line > 0) issue.line = row.line;
    issues.push(issue);
  }
  return issues;
}

function unavailable(error: unknown): never {
  if (error instanceof CatalogueError) throw error;
  throw new CatalogueError("The firmware catalogue database is unavailable. The component was not saved to the file library.", 503, "catalogue_unavailable");
}

export async function listValidatedComponents(): Promise<LibraryComponent[]> {
  try {
    const result = await cataloguePool().query<{
      component_id: string;
      name: string;
      description: string;
      component_type: "sensor" | "actuator";
      revision: number;
      content_fingerprint: string;
      integration: LibraryIntegration | null;
      created_at: Date;
      updated_at: Date;
      component_version_id: string;
      validated_at: Date | null;
      issues: LibraryComponent["validation"]["issues"];
    }>(`
      SELECT c.component_id, c.name, c.description, c.component_type, v.revision, v.content_fingerprint,
             v.integration, c.created_at, c.updated_at, v.component_version_id, r.created_at AS validated_at, r.issues
      FROM components c
      JOIN component_versions v ON v.component_id = c.component_id
      LEFT JOIN validation_runs r ON r.validation_run_id = (
        SELECT validation_run_id FROM validation_runs
        WHERE component_version_id = v.component_version_id
        ORDER BY created_at DESC
        LIMIT 1
      )
      WHERE c.component_type IN ('sensor', 'actuator')
        AND c.provenance = 'custom_code'
        AND v.validation_state = 'validated'
        AND v.revision = (SELECT max(revision) FROM component_versions WHERE component_id = c.component_id)
      ORDER BY c.name
    `);
    const components: LibraryComponent[] = [];
    for (const row of result.rows) {
      const gpio = await cataloguePool().query<{ connection_name: string; default_gpio: number; description: string }>(
        "SELECT connection_name, default_gpio, description FROM gpio_requirements WHERE component_version_id = $1 ORDER BY connection_name",
        [row.component_version_id],
      );
      const files = await cataloguePool().query<{ relative_path: string; source_hash: string; byte_size: number }>(
        `SELECT f.relative_path, f.source_hash, b.byte_size
         FROM component_files f JOIN source_blobs b ON b.sha256_hash = f.source_hash
         WHERE f.component_version_id = $1 AND f.file_role <> 'host_snapshot'
         ORDER BY f.relative_path`,
        [row.component_version_id],
      );
      const listed = files.rows.map((file) => ({ name: file.relative_path, sha256: file.source_hash.trim(), bytes: file.byte_size }));
      const contentHash = createHash("sha256").update(listed.map((file) => `${file.name}:${file.sha256}`).sort().join("\n")).digest("hex");
      components.push(libraryComponentSchema.parse({
        id: row.component_id,
        name: row.name,
        description: row.description,
        type: row.component_type,
        provenance: "custom",
        target: "esp32h2",
        compatibility: null,
        gpio: gpio.rows.filter((pin) => pin.default_gpio != null).map((pin) => ({ name: pin.connection_name, gpio: pin.default_gpio, description: pin.description })),
        files: listed,
        revision: row.revision,
        contentHash,
        validation: {
          fingerprint: row.content_fingerprint.trim(),
          nativeCompile: true,
          validatedAt: (row.validated_at ?? row.updated_at).toISOString(),
          issues: recordedIssues(row.issues),
          integration: row.integration,
        },
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    }
    return components;
  } catch (error) {
    unavailable(error);
  }
}

export async function readCatalogueFile(componentId: string, relativePath: string): Promise<Buffer> {
  try {
    const result = await cataloguePool().query<{ content: string }>(`
      SELECT b.content
      FROM component_versions v
      JOIN component_files f ON f.component_version_id = v.component_version_id
      JOIN source_blobs b ON b.sha256_hash = f.source_hash
      WHERE v.component_id = $1 AND f.relative_path = $2
        AND v.revision = (SELECT max(revision) FROM component_versions WHERE component_id = $1)
    `, [componentId, relativePath]);
    const content = result.rows[0]?.content;
    if (content == null) throw new CatalogueError("A saved source file was not found in the catalogue.", 404, "not_found");
    return Buffer.from(content, "utf8");
  } catch (error) {
    unavailable(error);
  }
}

export async function saveCatalogueRevision(component: LibraryComponent, files: { name: string; data: Buffer }[]): Promise<void> {
  const additional = files.reduce((sum, file) => sum + file.data.length, 0);
  try {
    const current = await cataloguePool().query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
    const decision = storageDecision(Number(current.rows[0]?.bytes ?? "NaN"), additional * 3);
    if (!decision.allow) throw new CatalogueError(decision.message, 507, "storage_budget");
    const client = await cataloguePool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO components (component_id, name, description, component_type, provenance)
         VALUES ($1, $2, $3, $4, 'custom_code')
         ON CONFLICT (component_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()`,
        [component.id, component.name, component.description, component.type],
      );
      const versionId = `${component.id}-r${component.revision}`;
      await client.query(
        `INSERT INTO component_versions (component_version_id, component_id, revision, content_fingerprint, integration, validation_state)
         VALUES ($1, $2, $3, $4, $5, 'validated')`,
        [versionId, component.id, component.revision, component.validation.fingerprint, component.validation.integration ? JSON.stringify(component.validation.integration) : null],
      );
      for (const file of files) {
        const hash = createHash("sha256").update(file.data).digest("hex");
        const text = file.data.toString("utf8");
        await client.query(
          "INSERT INTO source_blobs (sha256_hash, content, byte_size) VALUES ($1, $2, $3) ON CONFLICT (sha256_hash) DO NOTHING",
          [hash, text, file.data.length],
        );
        const role = file.name.endsWith(".h") || file.name.endsWith(".hpp") ? "header" : file.name.endsWith("CMakeLists.txt") || file.name.startsWith("Kconfig") ? "build" : "source";
        await client.query(
          "INSERT INTO component_files (component_version_id, relative_path, source_hash, file_role) VALUES ($1, $2, $3, $4)",
          [versionId, file.name, hash, role],
        );
      }
      for (const pin of component.gpio) {
        await client.query(
          `INSERT INTO gpio_requirements (component_version_id, connection_name, peripheral_function, default_gpio, allowed_gpio_constraints, description)
           VALUES ($1, $2, 'gpio', $3, 'ESP32-H2 GPIO 0-27 except reserved pins', $4)`,
          [versionId, pin.name, pin.gpio, pin.description],
        );
      }
      const integration = component.validation.integration;
      await client.query(
        `INSERT INTO matter_requirements (component_version_id, endpoint_types, clusters, attributes, endpoint_owned_by, initialisation_interface, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [versionId, [], [], [], integration?.endpointOwnedBy ?? "none", integration?.functionName ?? null, integration?.signature ?? "Validated through Firmware Builder."],
      );
      await client.query(
        `INSERT INTO validation_runs (validation_run_id, component_version_id, content_fingerprint, error_count, warning_count, issues, native_compile, integration_compile, toolchain)
         VALUES ($1, $2, $3, 0, 0, $4, 'succeeded', 'component', 'esp-idf')`,
        [`${versionId}-import`, versionId, component.validation.fingerprint, JSON.stringify(component.validation.issues)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    unavailable(error);
  }
}

const RESERVED_GPIO = [
  { gpio: 8, reason: "GPIO8 is a strapping pin" },
  { gpio: 9, reason: "GPIO9 is the BOOT and factory-reset button" },
];

export async function catalogueComponent(id: string): Promise<LibraryComponent | null> {
  try {
    const result = await cataloguePool().query<{
      component_id: string;
      name: string;
      description: string;
      component_type: "sensor" | "actuator";
      revision: number;
      content_fingerprint: string;
      integration: unknown;
      validation_state: string;
      created_at: Date;
      updated_at: Date;
      component_version_id: string;
    }>(`
      SELECT c.component_id, c.name, c.description, c.component_type, v.revision, v.content_fingerprint,
             v.integration, v.validation_state, c.created_at, c.updated_at, v.component_version_id
      FROM components c
      JOIN component_versions v ON v.component_id = c.component_id
      WHERE c.component_id = $1 AND c.provenance = 'custom_code' AND c.component_type IN ('sensor', 'actuator')
        AND v.revision = (SELECT max(revision) FROM component_versions WHERE component_id = c.component_id)
    `, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const gpio = await cataloguePool().query<{ connection_name: string; default_gpio: number | null; description: string }>(
      "SELECT connection_name, default_gpio, description FROM gpio_requirements WHERE component_version_id = $1 ORDER BY connection_name",
      [row.component_version_id],
    );
    const files = await cataloguePool().query<{ relative_path: string; source_hash: string; byte_size: number }>(
      `SELECT f.relative_path, f.source_hash, b.byte_size
       FROM component_files f JOIN source_blobs b ON b.sha256_hash = f.source_hash
       WHERE f.component_version_id = $1 AND f.file_role <> 'host_snapshot'
       ORDER BY f.relative_path`,
      [row.component_version_id],
    );
    const listed = files.rows.map((file) => ({ name: file.relative_path, sha256: file.source_hash.trim(), bytes: file.byte_size }));
    const contentHash = createHash("sha256").update(listed.map((file) => `${file.name}:${file.sha256}`).sort().join("\n")).digest("hex");
    const integration = libraryIntegrationSchema.safeParse(row.integration);
    return libraryComponentSchema.parse({
      id: row.component_id,
      name: row.name,
      description: row.description,
      type: row.component_type,
      provenance: "custom",
      target: "esp32h2",
      compatibility: null,
      gpio: gpio.rows.filter((pin) => pin.default_gpio != null).map((pin) => ({ name: pin.connection_name, gpio: pin.default_gpio, description: pin.description })),
      files: listed,
      revision: row.revision,
      contentHash,
      validation: {
        fingerprint: row.content_fingerprint.trim(),
        nativeCompile: row.validation_state === "validated",
        validatedAt: row.updated_at.toISOString(),
        issues: [],
        integration: integration.success ? integration.data : null,
      },
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error) {
    unavailable(error);
  }
}

export async function addCatalogueRevision(component: ImportComponent): Promise<"inserted" | "unchanged"> {
  const additional = component.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const current = await cataloguePool().query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  const decision = storageDecision(Number(current.rows[0]?.bytes ?? "NaN"), additional * 3);
  if (!decision.allow) throw new CatalogueError(decision.message, 507, "storage_budget");
  const hash = fingerprint(component.files);
  const client = await cataloguePool().connect();
  try {
    await client.query("BEGIN");
    const latest = await client.query<{ revision: number; content_fingerprint: string; component_version_id: string; validation_state: string }>(
      "SELECT revision, content_fingerprint, component_version_id, validation_state FROM component_versions WHERE component_id = $1 ORDER BY revision DESC LIMIT 1",
      [component.id],
    );
    if (!latest.rowCount) throw new CatalogueError(`Component ${component.id} does not exist.`, 404, "not_found");
    if (latest.rows[0]?.content_fingerprint.trim() === hash) {
      const current = latest.rows[0];
      if (current && component.validationState === "validated" && current.validation_state !== "validated") {
        await client.query("UPDATE component_versions SET validation_state = 'validated' WHERE component_version_id = $1", [current.component_version_id]);
      }
      await client.query(
        `INSERT INTO validation_runs (validation_run_id, component_version_id, content_fingerprint, error_count, warning_count, issues, native_compile, integration_compile, toolchain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`${current?.component_version_id}-${Date.now()}`, current?.component_version_id, hash, component.validation.errors, component.validation.warnings, JSON.stringify(component.validation.issues), component.validation.nativeCompile, component.validation.integrationCompile, "esp-idf-v5.4.1"],
      );
      await client.query("COMMIT");
      return "unchanged";
    }
    const revision = (latest.rows[0]?.revision ?? 0) + 1;
    const versionId = `${component.id}-r${revision}`;
    await client.query(
      `INSERT INTO component_versions (component_version_id, component_id, revision, content_fingerprint, integration, validation_state)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [versionId, component.id, revision, hash, component.matter.interfaceName && component.matter.ownedBy !== "none" ? JSON.stringify({ functionName: component.matter.interfaceName, signature: (component.matter.signature ?? component.matter.interfaceName).slice(0, 160), endpointOwnedBy: component.matter.ownedBy }) : null, component.validationState],
    );
    for (const file of component.files) {
      const fileHash = createHash("sha256").update(file.content).digest("hex");
      await client.query(
        "INSERT INTO source_blobs (sha256_hash, content, byte_size) VALUES ($1, $2, $3) ON CONFLICT (sha256_hash) DO NOTHING",
        [fileHash, file.content, Buffer.byteLength(file.content)],
      );
      await client.query(
        "INSERT INTO component_files (component_version_id, relative_path, source_hash, file_role) VALUES ($1, $2, $3, $4)",
        [versionId, file.path, fileHash, file.role],
      );
    }
    for (const pin of component.gpio) {
      await client.query(
        `INSERT INTO gpio_requirements (component_version_id, connection_name, peripheral_function, default_gpio, allowed_gpio_constraints, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [versionId, pin.name, pin.peripheral, pin.gpio, pin.constraints, pin.description],
      );
    }
    await client.query(
      `INSERT INTO matter_requirements (component_version_id, endpoint_types, clusters, attributes, endpoint_owned_by, initialisation_interface, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [versionId, component.matter.endpoints, component.matter.clusters, component.matter.attributes, component.matter.ownedBy, component.matter.interfaceName, component.matter.notes],
    );
    await client.query(
      `INSERT INTO validation_runs (validation_run_id, component_version_id, content_fingerprint, error_count, warning_count, issues, native_compile, integration_compile, toolchain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`${versionId}-import`, versionId, hash, component.validation.errors, component.validation.warnings, JSON.stringify(component.validation.issues), component.validation.nativeCompile, component.validation.integrationCompile, "esp-idf-v5.4.1"],
    );
    for (const dependency of component.dependsOn) {
      await client.query(
        `INSERT INTO component_dependencies (component_version_id, dependency_component_id, dependency_version_constraint, dependency_type)
         VALUES ($1, $2, $3, $4)`,
        [versionId, dependency.id, dependency.constraint, dependency.type],
      );
    }
    await client.query("COMMIT");
    return "inserted";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function saveSelection(componentIds: string[]): Promise<{ recipeId: string; revisions: { id: string; revision: number; versionId: string }[] }> {
  if (!catalogueEnabled()) throw new CatalogueError(NO_DATABASE_MESSAGE, 503, "catalogue_unavailable");
  const unique = [...new Set(componentIds)];
  if (unique.length === 0) throw new CatalogueError("Select at least one validated component.", 400, "empty_selection");
  const revisions: { id: string; name: string; revision: number; versionId: string; gpio: { name: string; gpio: number | null }[] }[] = [];
  for (const id of unique) {
    const row = await cataloguePool().query<{ name: string; revision: number; component_version_id: string; validation_state: string }>(`
      SELECT c.name, v.revision, v.component_version_id, v.validation_state
      FROM components c JOIN component_versions v ON v.component_id = c.component_id
      WHERE c.component_id = $1 AND v.revision = (SELECT max(revision) FROM component_versions WHERE component_id = c.component_id)
    `, [id]);
    const latest = row.rows[0];
    if (!latest || latest.validation_state !== "validated") {
      throw new CatalogueError("Only components that have passed native validation can be selected.", 409, "not_validated");
    }
    const gpio = await cataloguePool().query<{ connection_name: string; default_gpio: number | null }>(
      "SELECT connection_name, default_gpio FROM gpio_requirements WHERE component_version_id = $1",
      [latest.component_version_id],
    );
    revisions.push({ id, name: latest.name, revision: latest.revision, versionId: latest.component_version_id, gpio: gpio.rows.map((pin) => ({ name: pin.connection_name, gpio: pin.default_gpio })) });
  }
  const conflicts = gpioAssignmentIssues(revisions.flatMap((item) => item.gpio.map((pin) => ({
    componentName: item.name,
    connectionName: pin.name,
    gpio: pin.gpio,
  }))), RESERVED_GPIO);
  if (conflicts.length > 0) throw new CatalogueError(conflicts.join(" "), 409, "gpio_conflict");
  const recipeId = `recipe-${createHash("sha256").update(revisions.map((item) => item.versionId).sort().join("\n")).digest("hex").slice(0, 16)}`;
  await cataloguePool().query(
    "INSERT INTO firmware_recipes (recipe_id, name, target) VALUES ($1, $2, 'esp32h2') ON CONFLICT (recipe_id) DO NOTHING",
    [recipeId, revisions.map((item) => item.name).join(", ").slice(0, 120)],
  );
  for (const item of revisions) {
    await cataloguePool().query(
      "INSERT INTO recipe_components (recipe_id, component_version_id, gpio_assignments) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [recipeId, item.versionId, JSON.stringify(item.gpio)],
    );
  }
  return { recipeId, revisions: revisions.map(({ id, revision, versionId }) => ({ id, revision, versionId })) };
}

export function compositionStatus(): { available: false; reason: string } {
  return {
    available: false,
    reason: "Native firmware composition is not available. No complete ESP-IDF application has been assembled from the catalogue and compiled for ESP32-H2. Existing firmware packages and the installer are unchanged.",
  };
}

export interface CatalogueRevisionFile {
  relativePath: string;
  role: string;
  sha256: string;
  content: string;
}

export interface CatalogueRevision {
  componentId: string;
  revision: number;
  versionId: string;
  fingerprint: string;
  validationState: string;
  provenance: string;
  files: CatalogueRevisionFile[];
}

export async function loadCatalogueRevision(componentId: string, revision: number): Promise<CatalogueRevision> {
  try {
    const result = await cataloguePool().query<{
      component_version_id: string;
      content_fingerprint: string;
      validation_state: string;
      provenance: string;
      relative_path: string;
      file_role: string;
      source_hash: string;
      content: string;
      byte_size: number;
    }>(`
      SELECT v.component_version_id, v.content_fingerprint, v.validation_state, c.provenance,
             f.relative_path, f.file_role, f.source_hash, b.content, b.byte_size
      FROM component_versions v
      JOIN components c ON c.component_id = v.component_id
      JOIN component_files f ON f.component_version_id = v.component_version_id
      JOIN source_blobs b ON b.sha256_hash = f.source_hash
      WHERE v.component_id = $1 AND v.revision = $2 AND f.file_role <> 'host_snapshot'
      ORDER BY f.relative_path
    `, [componentId, revision]);
    const first = result.rows[0];
    if (!first) throw new CatalogueError(`${componentId} revision ${revision} was not found.`, 404, "not_found");
    const files = result.rows.map((row) => {
      const sha256 = row.source_hash.trim();
      const actual = createHash("sha256").update(row.content, "utf8").digest("hex");
      if (actual !== sha256 || Buffer.byteLength(row.content) !== row.byte_size) {
        throw new CatalogueError(`Stored source for ${row.relative_path} does not match its hash.`, 409, "source_mismatch");
      }
      return { relativePath: row.relative_path, role: row.file_role, sha256, content: row.content };
    });
    const fingerprint = createHash("sha256")
      .update(files.map((file) => `${file.role}:${file.relativePath}:${file.sha256}`).sort().join("\n"))
      .digest("hex");
    const stored = first.content_fingerprint.trim();
    if (fingerprint !== stored) {
      throw new CatalogueError(`${componentId} revision ${revision} fingerprint does not match its source files.`, 409, "source_mismatch");
    }
    return {
      componentId,
      revision,
      versionId: first.component_version_id,
      fingerprint,
      validationState: first.validation_state,
      provenance: first.provenance,
      files,
    };
  } catch (error) {
    unavailable(error);
  }
}

export async function saveCompositionRecipe(input: {
  recipeId: string;
  name: string;
  versions: { versionId: string; gpio: { name: string; gpio: number }[] }[];
}): Promise<void> {
  try {
    const current = await cataloguePool().query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
    const decision = storageDecision(Number(current.rows[0]?.bytes ?? "NaN"), 4000);
    if (!decision.allow) throw new CatalogueError(decision.message, 507, "storage_budget");
    await cataloguePool().query(
      "INSERT INTO firmware_recipes (recipe_id, name, target) VALUES ($1, $2, 'esp32h2') ON CONFLICT (recipe_id) DO NOTHING",
      [input.recipeId, input.name.slice(0, 120)],
    );
    for (const version of input.versions) {
      await cataloguePool().query(
        "INSERT INTO recipe_components (recipe_id, component_version_id, gpio_assignments) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [input.recipeId, version.versionId, JSON.stringify(version.gpio)],
      );
    }
  } catch (error) {
    unavailable(error);
  }
}

export async function recordCompositionBuild(input: {
  buildId: string;
  recipeId: string;
  softwareVersion: number;
  softwareVersionString: string;
  espIdfVersion: string;
  toolchain: string;
  inputFingerprint: string;
  imageSha256: string | null;
  artifactPath: string | null;
  versions: { versionId: string; fingerprint: string }[];
  errorCount: number;
  warningCount: number;
  issues: { level: string; code: string; message: string }[];
  integrationCompile: string;
  promoteVersionIds: string[];
}): Promise<void> {
  try {
    const client = await cataloguePool().connect();
    try {
      await client.query("BEGIN");
      if (input.imageSha256 && input.artifactPath) {
        await client.query(
          `INSERT INTO build_artifacts (
             build_id, recipe_id, target, software_version, software_version_string,
             esp_idf_version, input_fingerprint, image_sha256, artifact_path
           ) VALUES ($1, $2, 'esp32h2', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (build_id) DO NOTHING`,
          [
            input.buildId,
            input.recipeId,
            input.softwareVersion,
            input.softwareVersionString,
            input.espIdfVersion.slice(0, 80),
            input.inputFingerprint,
            input.imageSha256,
            input.artifactPath.slice(0, 400),
          ],
        );
      }
      for (const version of input.versions) {
        await client.query(
          `INSERT INTO validation_runs (
             validation_run_id, component_version_id, content_fingerprint, error_count, warning_count,
             issues, native_compile, integration_compile, toolchain
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            `${version.versionId}-matter-${input.buildId}`.slice(0, 180),
            version.versionId,
            version.fingerprint,
            input.errorCount,
            input.warningCount,
            JSON.stringify(input.issues.slice(0, 40)),
            input.integrationCompile === "matter-firmware" ? "succeeded" : "failed",
            input.integrationCompile,
            input.toolchain.slice(0, 240),
          ],
        );
        if (input.promoteVersionIds.includes(version.versionId)) {
          await client.query(
            `UPDATE component_versions
             SET validation_state = 'validated'
             WHERE component_version_id = $1 AND validation_state IN ('draft', 'validation_required')`,
            [version.versionId],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    unavailable(error);
  }
}

let releaseSchemaReady = false;

const RELEASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS firmware_releases (
  release_id text PRIMARY KEY,
  build_id text NOT NULL,
  recipe_id text,
  recipe_fingerprint char(64) NOT NULL,
  state text NOT NULL,
  software_version integer NOT NULL,
  software_version_string text NOT NULL,
  vendor_id integer NOT NULL,
  product_id integer NOT NULL,
  hardware_target text NOT NULL DEFAULT 'esp32h2',
  partition_layout_id text,
  application_sha256 char(64),
  ota_sha256 char(64),
  component_revisions jsonb NOT NULL DEFAULT '[]',
  validation jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT firmware_releases_state CHECK (
    state IN ('draft','build_failed','build_successful','release_candidate','published','superseded')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS firmware_release_version_uidx
  ON firmware_releases (vendor_id, product_id, software_version)
  WHERE state <> 'build_failed';
`;

export interface StoredFirmwareRelease {
  releaseId: string;
  buildId: string;
  recipeId: string | null;
  recipeFingerprint: string;
  state: "draft" | "build_failed" | "build_successful" | "release_candidate" | "published" | "superseded";
  softwareVersion: number;
  softwareVersionString: string;
  vendorId: number;
  productId: number;
  hardwareTarget: string;
  partitionLayoutId: string | null;
  applicationSha256: string | null;
  otaSha256: string | null;
  createdAt: string;
  releasedAt: string | null;
}

export async function ensureFirmwareReleases(): Promise<void> {
  if (!catalogueEnabled()) throw new CatalogueError(NO_DATABASE_MESSAGE, 503, "catalogue_unavailable");
  if (releaseSchemaReady) return;
  await cataloguePool().query(RELEASE_SCHEMA_SQL);
  releaseSchemaReady = true;
}

export async function listFirmwareReleases(): Promise<StoredFirmwareRelease[]> {
  await ensureFirmwareReleases();
  const result = await cataloguePool().query<{
    release_id: string;
    build_id: string;
    recipe_id: string | null;
    recipe_fingerprint: string;
    state: StoredFirmwareRelease["state"];
    software_version: number;
    software_version_string: string;
    vendor_id: number;
    product_id: number;
    hardware_target: string;
    partition_layout_id: string | null;
    application_sha256: string | null;
    ota_sha256: string | null;
    created_at: Date;
    released_at: Date | null;
  }>("SELECT * FROM firmware_releases ORDER BY software_version, created_at");
  return result.rows.map((row) => ({
    releaseId: row.release_id,
    buildId: row.build_id,
    recipeId: row.recipe_id,
    recipeFingerprint: row.recipe_fingerprint.trim(),
    state: row.state,
    softwareVersion: row.software_version,
    softwareVersionString: row.software_version_string,
    vendorId: row.vendor_id,
    productId: row.product_id,
    hardwareTarget: row.hardware_target,
    partitionLayoutId: row.partition_layout_id,
    applicationSha256: row.application_sha256?.trim() ?? null,
    otaSha256: row.ota_sha256?.trim() ?? null,
    createdAt: row.created_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
  }));
}

export async function insertFirmwareRelease(input: {
  releaseId: string;
  buildId: string;
  recipeId: string | null;
  recipeFingerprint: string;
  state: StoredFirmwareRelease["state"];
  softwareVersion: number;
  softwareVersionString: string;
  vendorId: number;
  productId: number;
  partitionLayoutId: string | null;
  applicationSha256: string | null;
  otaSha256: string | null;
  componentRevisions: unknown;
  validation: unknown;
}): Promise<"inserted" | "present" | "conflict"> {
  await ensureFirmwareReleases();
  try {
    const result = await cataloguePool().query(
      `INSERT INTO firmware_releases (
         release_id, build_id, recipe_id, recipe_fingerprint, state, software_version, software_version_string,
         vendor_id, product_id, hardware_target, partition_layout_id, application_sha256, ota_sha256,
         component_revisions, validation, released_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'esp32h2',$10,$11,$12,$13,$14,
         CASE WHEN $5 IN ('release_candidate','published') THEN now() ELSE NULL END
       ) ON CONFLICT (release_id) DO NOTHING`,
      [
        input.releaseId,
        input.buildId,
        input.recipeId,
        input.recipeFingerprint,
        input.state,
        input.softwareVersion,
        input.softwareVersionString,
        input.vendorId,
        input.productId,
        input.partitionLayoutId,
        input.applicationSha256,
        input.otaSha256,
        JSON.stringify(input.componentRevisions),
        JSON.stringify(input.validation),
      ],
    );
    return result.rowCount ? "inserted" : "present";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return "conflict";
    unavailable(error);
  }
}

export async function finishFirmwareRelease(input: {
  releaseId: string;
  buildId: string | null;
  state: StoredFirmwareRelease["state"];
  applicationSha256: string | null;
  otaSha256: string | null;
  validation: unknown;
}): Promise<void> {
  await ensureFirmwareReleases();
  const current = await cataloguePool().query<{ state: string; application_sha256: string | null }>(
    "SELECT state, application_sha256 FROM firmware_releases WHERE release_id = $1",
    [input.releaseId],
  );
  const row = current.rows[0];
  if (!row) throw new CatalogueError("The firmware release record was not found.", 404, "not_found");
  const recorded = row.application_sha256?.trim() ?? null;
  if ((row.state === "published" || row.state === "release_candidate") && recorded && input.applicationSha256 && recorded !== input.applicationSha256) {
    throw new CatalogueError("A recorded release image cannot be replaced.", 409, "release_immutable");
  }
  if (row.state === "published" || row.state === "release_candidate" || row.state === "superseded") return;
  await cataloguePool().query(
    `UPDATE firmware_releases
     SET state = $2, build_id = COALESCE($3, build_id), application_sha256 = COALESCE($4, application_sha256),
         ota_sha256 = COALESCE($5, ota_sha256), validation = $6,
         released_at = CASE WHEN $2 IN ('release_candidate','published') THEN now() ELSE released_at END
     WHERE release_id = $1 AND (
       state IN ('draft', 'build_successful')
       OR (state = 'build_failed' AND application_sha256 IS NULL)
     )`,
    [input.releaseId, input.state, input.buildId, input.applicationSha256, input.otaSha256, JSON.stringify(input.validation)],
  );
}
