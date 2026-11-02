/**
 * npm run db:setup
 *
 * Prepares an empty PostgreSQL database for IoT.Edu, or brings an existing one up to date.
 * Safe to run more than once: existing tables and components are left as they are.
 *
 * 1. Account tables (also created automatically on API startup)
 * 2. Catalogue tables (apps/local-api/db/001_catalogue.sql), only if they do not exist yet
 * 3. Firmware release table
 * 4. The starter components that ship in this repository
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAuthSchema } from "./auth-schema.js";
import { repositoryComponents } from "./catalogue-seed.js";
import { cataloguePool, closeCatalogue, ensureFirmwareReleases, importComponents } from "./catalogue-store.js";
import { loadEnvFile } from "./load-env.js";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(apiRoot, "..", "..");

function step(message: string): void {
  console.log(`✓ ${message}`);
}

function hint(message: string): string {
  if (/certificate|self[- ]signed|SSL|TLS/i.test(message)) {
    return "The database must accept TLS connections with a trusted certificate. Hosted PostgreSQL services such as Neon provide this. Add ?sslmode=require to DATABASE_URL.";
  }
  if (/ECONNREFUSED|ENOTFOUND|timeout/i.test(message)) {
    return "The database could not be reached. Check the host name and port in DATABASE_URL, and that the database is running.";
  }
  if (/password authentication|role .* does not exist/i.test(message)) {
    return "The database rejected the user name or password in DATABASE_URL.";
  }
  return "Check DATABASE_URL in apps/local-api/.env.";
}

await loadEnvFile(path.join(apiRoot, ".env"));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add your PostgreSQL connection string to apps/local-api/.env first.");
  console.error("IoT.Edu works without a database (local mode). A database adds accounts and saved Node Types.");
  process.exitCode = 1;
} else {
  try {
    const pool = cataloguePool();
    await pool.query("SELECT 1");
    step("Connected to the database");

    await ensureAuthSchema(pool);
    step("Account tables ready");

    const existing = await pool.query<{ ready: boolean }>("SELECT to_regclass('public.components') IS NOT NULL AS ready");
    if (existing.rows[0]?.ready) {
      step("Catalogue tables already exist");
    } else {
      const sql = await readFile(path.join(apiRoot, "db", "001_catalogue.sql"), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      step("Catalogue tables created");
    }

    await ensureFirmwareReleases();
    step("Firmware release table ready");

    const result = await importComponents(await repositoryComponents(repoRoot));
    step(`Starter components: ${result.inserted.length} added, ${result.skipped.length} already present`);

    console.log("\nDone. Restart IoT.Edu. The first account you create becomes the administrator.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nDatabase setup failed: ${message}`);
    console.error(hint(message));
    process.exitCode = 1;
  } finally {
    await closeCatalogue();
  }
}
