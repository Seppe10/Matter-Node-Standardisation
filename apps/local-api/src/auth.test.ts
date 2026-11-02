import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { componentManifestDir } from "@iotedu/contracts/paths";
import { buildApp, readBoardProfile } from "./app.js";
import { attachAuth, authorise, LOGIN_LIMITS, LoginLimiter, type Access } from "./auth-http.js";
import { hashPassword, hashSessionToken, PASSWORD_HASH, passwordError, verifyPassword } from "./auth-passwords.js";
import { AUTH_LOCK_KEY, MemoryAuthStore, unavailableAuthStore, type AuthStore } from "./auth-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const passphrase = "a unique passphrase";
const closers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((app) => app.close()));
});

function cookie(response: { headers: Record<string, unknown> }): { token: string; header: string } {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join(";") : String(raw ?? "");
  const match = /iotedu_session=([^;]*)/.exec(header);
  return { token: decodeURIComponent(match?.[1] ?? ""), header };
}

async function authApp(store: AuthStore = new MemoryAuthStore(), limiter?: LoginLimiter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  attachAuth(app, store, limiter ? { limiter } : {});
  app.get("/api/nodes", async () => ({ nodes: [] }));
  app.get("/api/events", async (_request, reply) => {
    reply.header("content-type", "text/event-stream");
    return "data: {}\n\n";
  });
  await app.ready();
  closers.push(app);
  return app;
}

describe("password hashing", () => {
  it("uses Argon2id with the deployment parameters", async () => {
    expect(PASSWORD_HASH.type).toBe(argon2.argon2id);
    expect(PASSWORD_HASH.memoryCost).toBe(19456);
    expect(PASSWORD_HASH.timeCost).toBe(2);
    expect(PASSWORD_HASH.parallelism).toBe(1);
    const hash = await hashPassword(passphrase);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456,t=2,p=1");
    expect(hash).not.toContain(passphrase);
    expect(await verifyPassword(passphrase, hash)).toBe(true);
    expect(await verifyPassword(`${passphrase} `, hash)).toBe(false);
    expect(await verifyPassword(passphrase.trim(), await hashPassword(` ${passphrase}`))).toBe(false);
  });

  it("rejects short, common, and mismatched passwords without changing them", () => {
    expect(passwordError("")).toBe("Enter your password.");
    expect(passwordError("short-one")).toBe("Use at least 12 characters.");
    expect(passwordError("password12345")).toBe("Choose a password that is not commonly used.");
    expect(passwordError("aaaaaaaaaaaa")).toBe("Choose a password that is not commonly used.");
    expect(passwordError("horse battery staple", "horse battery staple@example.com")).toBe("Choose a password that does not match your email address.");
    expect(passwordError("horse battery staple")).toBeNull();
  });
});

describe("authorisation decisions", () => {
  const cases: [string, string, "administrator" | "user" | null, Access][] = [
    ["GET", "/api/health", null, "public"],
    ["POST", "/api/auth/login", null, "public"],
    ["POST", "/api/auth/register", null, "public"],
    ["GET", "/api/auth/registration", null, "public"],
    ["GET", "/api/nodes", null, "unauthenticated"],
    ["GET", "/api/events", null, "unauthenticated"],
    ["POST", "/api/builds", null, "unauthenticated"],
    ["GET", "/api/settings", null, "unauthenticated"],
    ["GET", "/api/account", null, "unauthenticated"],
    ["GET", "/api/account", "user", "ok"],
    ["POST", "/api/auth/change-password", "user", "ok"],
    ["GET", "/api/nodes", "user", "forbidden"],
    ["GET", "/api/events", "user", "forbidden"],
    ["POST", "/api/programmer/sessions", "user", "forbidden"],
    ["PATCH", "/api/users", "user", "forbidden"],
    ["GET", "/api/settings", "user", "forbidden"],
    ["GET", "/api/hardware/installations", null, "unauthenticated"],
    ["GET", "/api/hardware/installations", "user", "forbidden"],
    ["GET", "/api/hardware/installations", "administrator", "ok"],
    ["POST", "/api/nodes/node-1/commissioning-window", "user", "forbidden"],
    ["POST", "/api/nodes/node-1/commissioning-window", "administrator", "ok"],
    ["GET", "/api/nodes", "administrator", "ok"],
    ["GET", "/api/events", "administrator", "ok"],
    ["POST", "/api/users", "administrator", "ok"],
  ];

  it("keeps management routes administrator-only", () => {
    for (const [method, path, role, expected] of cases) {
      expect(authorise(method, path, role), `${method} ${path} ${role}`).toBe(expected);
    }
    expect(LOGIN_LIMITS.account).toBe(8);
    expect(LOGIN_LIMITS.ip).toBe(30);
  });
});

describe("authentication schema", () => {
  it("adds reversible account tables without touching catalogue data", async () => {
    const up = await readFile(new URL("../migrations/001_auth.sql", import.meta.url), "utf8");
    const down = await readFile(new URL("../migrations/001_auth.down.sql", import.meta.url), "utf8");
    expect(up).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(up).toContain("CREATE TABLE IF NOT EXISTS user_sessions");
    expect(up).toContain("password_hash text NOT NULL");
    expect(up).toContain("token_hash text NOT NULL");
    expect(up).toContain("REFERENCES users (id)");
    expect(up).toContain("UNIQUE (email_normalized)");
    expect(up.toLowerCase()).not.toContain("drop table");
    expect(up).not.toMatch(/\bpassword\s+(text|varchar)/i);
    expect(up).not.toMatch(/\btoken\s+(text|varchar)/i);
    expect(down).toContain("DROP TABLE IF EXISTS user_sessions");
    expect(down).toContain("DROP TABLE IF EXISTS users");
    expect(down).toContain("DROP TABLE IF EXISTS auth_policy");
    expect(down).not.toMatch(/components|firmware_releases|node_types|source_blobs/);
    const source = await readFile(new URL("./auth-store.ts", import.meta.url), "utf8");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("ROLLBACK");
    expect(source).toContain(AUTH_LOCK_KEY);
    expect(source).toContain("$1");
  });
});

describe("account sessions", () => {
  it("bootstraps one administrator and rejects a concurrent second account", async () => {
    const store = new MemoryAuthStore();
    const passwordHash = "stored-hash-not-plaintext";
    const input = (email: string) => ({ displayName: "Ada", email, emailNormalized: email.toLowerCase(), passwordHash });
    const settled = await Promise.allSettled([
      store.register(input("One@Example.com")),
      store.register(input("two@example.com")),
    ]);
    const created = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (created[0]?.status !== "fulfilled") throw new Error("expected the first account");
    expect(created[0].value.role).toBe("administrator");
    expect(created[0].value).not.toHaveProperty("passwordHash");
    await store.setSelfRegistration(true);
    await expect(store.register(input("one@example.com"))).rejects.toMatchObject({ code: "email_taken" });
    const second = await store.register(input("two@example.com"));
    expect(second.role).toBe("user");
  });

  it("expires, idles, and revokes sessions", async () => {
    let now = new Date("2026-10-25T00:00:00.000Z");
    const store = new MemoryAuthStore(() => now);
    const created = await store.register({
      displayName: "Ada",
      email: "ada@example.com",
      emailNormalized: "ada@example.com",
      passwordHash: "stored-hash-not-plaintext",
    });
    const tokenHash = "a".repeat(64);
    await store.startSession(created.id, tokenHash, 100, 10);
    expect(await store.readSession(tokenHash)).toMatchObject({ email: "ada@example.com" });
    await store.revokeSession(tokenHash);
    expect(await store.readSession(tokenHash)).toBeNull();
    const idleHash = "b".repeat(64);
    await store.startSession(created.id, idleHash, 1000, 10);
    now = new Date(now.getTime() + 11_000);
    expect(await store.readSession(idleHash)).toBeNull();
    const absoluteHash = "c".repeat(64);
    await store.startSession(created.id, absoluteHash, 10, 1000);
    now = new Date(now.getTime() + 11_000);
    expect(await store.readSession(absoluteHash)).toBeNull();
  });

  it("refuses to remove the last active administrator", async () => {
    const store = new MemoryAuthStore();
    await store.register({
      displayName: "Ada",
      email: "ada@example.com",
      emailNormalized: "ada@example.com",
      passwordHash: "stored-hash-not-plaintext",
    });
    await expect(store.updateUser("ada@example.com", { status: "disabled" })).rejects.toMatchObject({ code: "last_administrator" });
    await expect(store.updateUser("ada@example.com", { role: "user" })).rejects.toMatchObject({ code: "last_administrator" });
    expect((await store.listUsers())[0]).toMatchObject({ role: "administrator", status: "active" });
  });
});

describe("authentication HTTP", () => {
  it("signs in, rejects invalid and disabled accounts, and rotates sessions", async () => {
    const store = new MemoryAuthStore();
    const app = await authApp(store);
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { displayName: "Ada Lovelace", email: "Ada@Example.com", password: passphrase, confirmPassword: passphrase, role: "user" },
    });
    expect(created.statusCode).toBe(200);
    const first = cookie(created);
    expect(created.json().user).toMatchObject({ email: "Ada@Example.com", role: "administrator" });
    expect(created.json().user).not.toHaveProperty("id");
    expect(created.json().user).not.toHaveProperty("passwordHash");
    expect(created.body).not.toContain(passphrase);
    expect(created.body).not.toContain(first.token);
    expect(first.header).toContain("HttpOnly");
    expect(first.header).toContain("SameSite=Lax");
    expect(first.header).toContain("Path=/");
    expect(first.header).not.toContain("Secure");
    expect(await store.readSession(first.token)).toBeNull();
    expect(await store.readSession(hashSessionToken(first.token))).toMatchObject({ role: "administrator" });
    const stored = await store.findLogin("ada@example.com");
    expect(stored?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(stored?.passwordHash).not.toContain(passphrase);

    const nodes = await app.inject({ method: "GET", url: "/api/nodes" });
    expect(nodes.statusCode).toBe(401);
    expect(nodes.headers["content-type"]).toContain("application/json");
    const events = await app.inject({ method: "GET", url: "/api/events" });
    expect(events.statusCode).toBe(401);
    expect(String(events.headers["content-type"])).not.toContain("text/event-stream");

    const account = await app.inject({ method: "GET", url: "/api/account", headers: { cookie: `iotedu_session=${first.token}` } });
    expect(account.statusCode).toBe(200);
    const stream = await app.inject({ method: "GET", url: "/api/events", headers: { cookie: `iotedu_session=${first.token}` } });
    expect(stream.statusCode).toBe(200);
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");

    const unknown = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "missing@example.com", password: passphrase } });
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "not-the-password" } });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe("Invalid email or password.");
    expect(wrong.json().error.message).toBe("Invalid email or password.");
    expect(unknown.body).not.toContain("missing@example.com");

    const padded = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: ` ${passphrase}` } });
    expect(padded.statusCode).toBe(401);
    const storedHash = (await store.findLogin("ada@example.com"))?.passwordHash ?? "";
    await store.createUser({
      displayName: "Grace",
      email: "grace@example.com",
      emailNormalized: "grace@example.com",
      passwordHash: storedHash,
      role: "user",
    });
    await store.updateUser("grace@example.com", { status: "disabled" });
    const disabled = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "grace@example.com", password: passphrase } });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json().error.message).toBe("Invalid email or password.");
    expect(disabled.body.toLowerCase()).not.toContain("disabled");

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: `iotedu_session=${first.token}` },
      payload: { currentPassword: passphrase, newPassword: "another passphrase", confirmPassword: "another passphrase" },
    });
    expect(changed.statusCode).toBe(200);
    const rotated = cookie(changed);
    expect(rotated.token).not.toBe(first.token);
    const oldSession = await app.inject({ method: "GET", url: "/api/account", headers: { cookie: `iotedu_session=${first.token}` } });
    expect(oldSession.statusCode).toBe(401);
    const newSession = await app.inject({ method: "GET", url: "/api/account", headers: { cookie: `iotedu_session=${rotated.token}` } });
    expect(newSession.statusCode).toBe(200);
    const oldPassword = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: passphrase } });
    expect(oldPassword.statusCode).toBe(401);

    const loggedOut = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: `iotedu_session=${rotated.token}` } });
    expect(loggedOut.statusCode).toBe(200);
    expect(cookie(loggedOut).header).toContain("Max-Age=0");
    const afterLogout = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie: `iotedu_session=${rotated.token}` } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("limits guesses, rejects cross-site posts, and denies a standard user", async () => {
    let now = Date.now();
    const limiter = new LoginLimiter(() => now, { ip: 30, account: 2, register: 10, windowMs: 60_000 });
    const store = new MemoryAuthStore();
    const app = await authApp(store, limiter);
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { displayName: "Ada", email: "ada@example.com", password: passphrase, confirmPassword: passphrase },
    });
    const first = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "wrong-password" } });
    const second = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "wrong-password" } });
    const third = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: passphrase } });
    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(429);
    now += 60_001;
    const empty = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toBe("Enter your email address.");
    const crossSite = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: "ada@example.com", password: passphrase },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.body).not.toContain(passphrase);

    const admin = cookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: passphrase } }));
    const opened = await app.inject({
      method: "PATCH",
      url: "/api/auth/policy",
      headers: { cookie: `iotedu_session=${admin.token}` },
      payload: { selfRegistration: true },
    });
    expect(opened.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { displayName: "Ada", email: "ADA@example.com", password: passphrase, confirmPassword: passphrase },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toBe("An account with that email already exists.");
    const user = cookie(await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { displayName: "Grace", email: "grace@example.com", password: "another passphrase", confirmPassword: "another passphrase", role: "administrator" },
    }));
    expect(user.token).not.toBe("");
    const userNodes = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie: `iotedu_session=${user.token}` } });
    expect(userNodes.statusCode).toBe(403);
    const userAccount = await app.inject({ method: "GET", url: "/api/account", headers: { cookie: `iotedu_session=${user.token}` } });
    expect(userAccount.statusCode).toBe(200);
    expect(userAccount.json().user.role).toBe("user");
    const userAdmin = await app.inject({
      method: "PATCH",
      url: "/api/users",
      headers: { cookie: `iotedu_session=${user.token}` },
      payload: { email: "ada@example.com", role: "user" },
    });
    expect(userAdmin.statusCode).toBe(403);
    const lastAdmin = await app.inject({
      method: "PATCH",
      url: "/api/users",
      headers: { cookie: `iotedu_session=${admin.token}` },
      payload: { email: "ada@example.com", status: "disabled" },
    });
    expect(lastAdmin.statusCode).toBe(409);
  });

  it("does not grant access when authentication storage is unavailable", async () => {
    const app = await authApp(unavailableAuthStore());
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: passphrase } });
    const anonymous = await app.inject({ method: "GET", url: "/api/nodes" });
    const presented = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie: "iotedu_session=presented-token" } });
    expect(login.statusCode).toBe(503);
    expect(anonymous.statusCode).toBe(401);
    expect(presented.statusCode).toBe(503);
    expect(login.json().error.message).toBe("Unable to connect. Please try again.");
    expect(login.body).not.toContain("DATABASE_URL");
    expect(presented.body).not.toContain("password");
    expect(anonymous.body).not.toContain("nodes");
  });

  it("protects the running API without stopping it on logout", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "iotedu-auth-"));
    const store = new MemoryAuthStore();
    const app = await buildApp({
      dataDir,
      repoRoot,
      catalogDir: componentManifestDir(repoRoot),
      profile: await readBoardProfile(repoRoot),
      nativeAvailable: false,
      reachabilityIntervalMs: 0,
      auth: store,
    });
    closers.push(app);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/nodes" })).statusCode).toBe(401);
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { displayName: "Ada", email: "ada@example.com", password: passphrase, confirmPassword: passphrase },
    });
    const session = cookie(created);
    expect((await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie: `iotedu_session=${session.token}` } })).statusCode).toBe(200);
    const events = await app.inject({ method: "GET", url: "/api/events", headers: { cookie: `iotedu_session=${session.token}` } });
    expect(events.statusCode).toBe(200);
    expect(String(events.headers["content-type"])).toContain("text/event-stream");
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: `iotedu_session=${session.token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/capabilities", headers: { cookie: `iotedu_session=${session.token}` } })).statusCode).toBe(401);
    const again = cookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: passphrase } }));
    expect((await app.inject({ method: "GET", url: "/api/capabilities", headers: { cookie: `iotedu_session=${again.token}` } })).statusCode).toBe(200);
  });
});
