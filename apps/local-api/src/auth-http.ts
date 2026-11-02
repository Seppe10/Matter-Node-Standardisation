import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { catalogueEnabled, cataloguePool } from "./catalogue-store.js";
import { ensureAuthSchema } from "./auth-schema.js";
import {
  confirmationError,
  displayNameError,
  dummyPasswordHash,
  emailError,
  hashPassword,
  hashSessionToken,
  loginInputError,
  newSessionToken,
  normalizeEmail,
  passwordError,
  SESSION_LIMITS,
  verifyPassword,
} from "./auth-passwords.js";
import { PostgresAuthStore, unavailableAuthStore, type AuthStore } from "./auth-store.js";
import {
  AuthError,
  publicAccount,
  type AccountRole,
  type AccountStatus,
  type PublicAccount,
  type SessionAccount,
} from "./auth-types.js";

export const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

export const LOGIN_LIMITS = { ip: 30, account: 8, register: 10, windowMs: 15 * 60 * 1000 } as const;
const COOKIE = "iotedu_session";

const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "POST /api/auth/login",
  "POST /api/auth/register",
  "GET /api/auth/registration",
]);

const SELF_ROUTES = new Set([
  "GET /api/auth/me",
  "POST /api/auth/logout",
  "POST /api/auth/change-password",
  "GET /api/account",
  "PATCH /api/account",
]);

export type Access = "public" | "ok" | "unauthenticated" | "forbidden";

/**
 * Local mode: no database is configured, so there are no accounts.
 * IoT.Edu is then a single-user desktop app. The person at this computer is the administrator.
 * The API still binds to 127.0.0.1 only and keeps its Host-header and cross-origin guards.
 */
export const LOCAL_USER = Object.freeze({
  displayName: "Local user",
  email: "local@this-computer",
  role: "administrator" as const,
  createdAt: new Date().toISOString(),
  lastLoginAt: null,
  local: true,
});

export function attachLocalMode(app: FastifyInstance): void {
  app.get("/api/auth/me", async (_request, reply) => reply.header("cache-control", "no-store").send({ user: LOCAL_USER, mode: "local" }));
  app.get("/api/auth/registration", async (_request, reply) => reply.header("cache-control", "no-store").send({ open: false, bootstrap: false, mode: "local" }));
}

export function authorise(method: string, path: string, role: AccountRole | null): Access {
  const key = `${method.toUpperCase()} ${path}`;
  if (PUBLIC_ROUTES.has(key)) return "public";
  if (!role) return "unauthenticated";
  if (SELF_ROUTES.has(key) || role === "administrator") return "ok";
  return "forbidden";
}

declare module "fastify" {
  interface FastifyRequest {
    authAccount?: SessionAccount | null;
  }
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly limits: { ip: number; account: number; register: number; windowMs: number } = LOGIN_LIMITS,
  ) {}

  status(ip: string, email: string): "ok" | "limited" {
    this.prune();
    if (this.count(`ip:${ip}`) >= this.limits.ip) return "limited";
    if (email && this.count(`acct:${ip}:${email}`) >= this.limits.account) return "limited";
    return "ok";
  }

  registrationStatus(ip: string): "ok" | "limited" {
    this.prune();
    return this.count(`reg:${ip}`) >= this.limits.register ? "limited" : "ok";
  }

  fail(ip: string, email: string): void {
    this.add(`ip:${ip}`);
    if (email) this.add(`acct:${ip}:${email}`);
  }

  failRegistration(ip: string): void {
    this.add(`reg:${ip}`);
  }

  succeed(ip: string, email: string): void {
    this.buckets.delete(`acct:${ip}:${email}`);
  }

  private count(key: string): number {
    return this.buckets.get(key)?.count ?? 0;
  }

  private add(key: string): void {
    const current = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      this.buckets.set(key, { count: 1, resetAt: current + this.limits.windowMs });
      return;
    }
    bucket.count += 1;
  }

  private prune(): void {
    const current = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= current) this.buckets.delete(key);
    }
  }
}

function bodyOf(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).header("cache-control", "no-store").send({ error: { code, message } });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return fail(reply, error.statusCode, error.code, error.message);
  return fail(reply, 503, "unavailable", "Unable to connect. Please try again.");
}

function cookieSecure(request: FastifyRequest): boolean {
  return process.env.AUTH_COOKIE_SECURE === "1" || request.protocol === "https";
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

function readCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

function clientIp(request: FastifyRequest): string {
  return request.ip || "local";
}

function limitsFor(remember: unknown): { absoluteSeconds: number; idleSeconds: number } {
  if (remember === true) {
    return { absoluteSeconds: SESSION_LIMITS.rememberAbsoluteSeconds, idleSeconds: SESSION_LIMITS.rememberIdleSeconds };
  }
  return { absoluteSeconds: SESSION_LIMITS.absoluteSeconds, idleSeconds: SESSION_LIMITS.idleSeconds };
}

function roleOf(value: unknown): AccountRole | null {
  return value === "administrator" || value === "user" ? value : null;
}

function statusOf(value: unknown): AccountStatus | null {
  return value === "active" || value === "disabled" ? value : null;
}

function rejectCrossSite(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && !ALLOWED_ORIGINS.has(origin)) {
    void fail(reply, 403, "cross_origin", "This request was rejected.");
    return true;
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    void fail(reply, 403, "cross_origin", "This request was rejected.");
    return true;
  }
  return false;
}

async function accountFields(body: Record<string, unknown>, confirm: boolean): Promise<{
  displayName: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
} | { error: string }> {
  const nameMessage = displayNameError(body.displayName);
  if (nameMessage) return { error: nameMessage };
  const emailMessage = emailError(body.email);
  if (emailMessage) return { error: emailMessage };
  const passwordMessage = passwordError(body.password, typeof body.email === "string" ? body.email : "");
  if (passwordMessage) return { error: passwordMessage };
  if (confirm) {
    const confirmMessage = confirmationError(body.password, body.confirmPassword);
    if (confirmMessage) return { error: confirmMessage };
  }
  const email = (body.email as string).trim();
  return {
    displayName: (body.displayName as string).trim(),
    email,
    emailNormalized: normalizeEmail(email),
    passwordHash: await hashPassword(body.password as string),
  };
}

export async function resolveAuthStore(paths: { auth?: AuthStore | "off" }): Promise<AuthStore | null> {
  if (paths.auth === "off") return null;
  if (paths.auth) return paths.auth;
  if (!catalogueEnabled()) return null;
  try {
    const pool = cataloguePool();
    await ensureAuthSchema(pool);
    console.log(JSON.stringify({ source: "iotedu-api", event: "authentication", state: "ready" }));
    return new PostgresAuthStore(pool);
  } catch {
    console.error(JSON.stringify({ source: "iotedu-auth", message: "Authentication storage is unavailable." }));
    return unavailableAuthStore();
  }
}

export function attachAuth(app: FastifyInstance, store: AuthStore, options: { limiter?: LoginLimiter } = {}): void {
  const limiter = options.limiter ?? new LoginLimiter();

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (rejectCrossSite(request, reply)) return reply;
    const path = request.url.split("?")[0] ?? request.url;
    if (authorise(request.method, path, null) === "public") return;
    reply.header("cache-control", "no-store");
    const token = readCookie(request.headers.cookie);
    let account: SessionAccount | null = null;
    if (token) {
      try {
        account = await store.readSession(hashSessionToken(token));
      } catch (error) {
        return sendError(reply, error);
      }
    }
    const decision = authorise(request.method, path, account?.role ?? null);
    if (decision === "unauthenticated") {
      if (token) reply.header("set-cookie", clearSessionCookie(cookieSecure(request)));
      return fail(reply, 401, "unauthenticated", "Sign in to continue.");
    }
    if (decision === "forbidden") return fail(reply, 403, "forbidden", "You do not have permission to do that.");
    request.authAccount = account;
  });

  app.get("/api/auth/registration", async (_request, reply) => {
    try {
      const policy = await store.registration();
      return reply.header("cache-control", "no-store").send({ open: policy.open, bootstrap: policy.bootstrap });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/auth/register", async (request, reply) => {
    const ip = clientIp(request);
    if (limiter.registrationStatus(ip) === "limited") return fail(reply, 429, "rate_limited", "Too many attempts. Please try again later.");
    const fields = await accountFields(bodyOf(request.body), true);
    if ("error" in fields) {
      limiter.failRegistration(ip);
      return fail(reply, 400, "invalid_input", fields.error);
    }
    try {
      const created = await store.register(fields);
      const session = newSessionToken();
      const user = await store.startSession(created.id, session.hash, SESSION_LIMITS.absoluteSeconds, SESSION_LIMITS.idleSeconds);
      return reply.header("cache-control", "no-store").header("set-cookie", sessionCookie(session.token, SESSION_LIMITS.absoluteSeconds, cookieSecure(request))).send({ user });
    } catch (error) {
      limiter.failRegistration(ip);
      return sendError(reply, error);
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = bodyOf(request.body);
    const ip = clientIp(request);
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    if (limiter.status(ip, email) === "limited") return fail(reply, 429, "rate_limited", "Too many attempts. Please try again later.");
    const inputError = loginInputError(body.email, body.password);
    if (inputError) {
      limiter.fail(ip, email);
      return fail(reply, 400, "invalid_input", inputError);
    }
    try {
      const record = await store.findLogin(email);
      const password = body.password as string;
      const valid = await verifyPassword(password, record?.passwordHash ?? await dummyPasswordHash());
      if (!record || !valid || record.status !== "active") {
        limiter.fail(ip, email);
        return fail(reply, 401, "invalid_login", "Invalid email or password.");
      }
      limiter.succeed(ip, email);
      const span = limitsFor(body.remember);
      const session = newSessionToken();
      const user = await store.startSession(record.id, session.hash, span.absoluteSeconds, span.idleSeconds);
      return reply
        .header("cache-control", "no-store")
        .header("set-cookie", sessionCookie(session.token, span.absoluteSeconds, cookieSecure(request)))
        .send({ user });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readCookie(request.headers.cookie);
    try {
      if (token) await store.revokeSession(hashSessionToken(token));
    } catch (error) {
      return sendError(reply, error);
    }
    return reply.header("cache-control", "no-store").header("set-cookie", clearSessionCookie(cookieSecure(request))).send({ ok: true });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const account = request.authAccount;
    if (!account) return fail(reply, 401, "unauthenticated", "Sign in to continue.");
    return { user: publicAccount(account) };
  });

  app.get("/api/account", async (request, reply) => {
    const account = request.authAccount;
    if (!account) return fail(reply, 401, "unauthenticated", "Sign in to continue.");
    return { user: publicAccount(account) };
  });

  app.patch("/api/account", async (request, reply) => {
    const account = request.authAccount;
    if (!account) return fail(reply, 401, "unauthenticated", "Sign in to continue.");
    const body = bodyOf(request.body);
    const message = displayNameError(body.displayName);
    if (message) return fail(reply, 400, "invalid_input", message);
    try {
      const user = await store.updateDisplayName(account.id, (body.displayName as string).trim());
      return { user };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const account = request.authAccount;
    if (!account) return fail(reply, 401, "unauthenticated", "Sign in to continue.");
    const ip = clientIp(request);
    const email = normalizeEmail(account.email);
    if (limiter.status(ip, email) === "limited") return fail(reply, 429, "rate_limited", "Too many attempts. Please try again later.");
    const body = bodyOf(request.body);
    if (typeof body.currentPassword !== "string" || body.currentPassword.length === 0) {
      return fail(reply, 400, "invalid_input", "Enter your current password.");
    }
    const nextError = passwordError(body.newPassword, account.email);
    if (nextError) return fail(reply, 400, "invalid_input", nextError === "Enter your password." ? "Enter a new password." : nextError);
    const confirmError = confirmationError(body.newPassword, body.confirmPassword);
    if (confirmError) return fail(reply, 400, "invalid_input", confirmError);
    try {
      const record = await store.findLogin(normalizeEmail(account.email));
      if (!record || record.status !== "active") return fail(reply, 401, "unauthenticated", "Sign in to continue.");
      const currentMatches = await verifyPassword(body.currentPassword, record.passwordHash);
      if (!currentMatches) {
        limiter.fail(ip, email);
        return fail(reply, 400, "invalid_password", "Current password is incorrect.");
      }
      if (await verifyPassword(body.newPassword as string, record.passwordHash)) {
        return fail(reply, 400, "invalid_password", "Choose a different password.");
      }
      const span = limitsFor(false);
      const session = newSessionToken();
      const user = await store.rotatePassword(record.id, await hashPassword(body.newPassword as string), session.hash, span.absoluteSeconds, span.idleSeconds);
      limiter.succeed(ip, email);
      return reply
        .header("cache-control", "no-store")
        .header("set-cookie", sessionCookie(session.token, span.absoluteSeconds, cookieSecure(request)))
        .send({ user });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/users", async (_request, reply) => {
    try {
      return { users: await store.listUsers() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/users", async (request, reply) => {
    const fields = await accountFields(bodyOf(request.body), true);
    if ("error" in fields) return fail(reply, 400, "invalid_input", fields.error);
    const role = roleOf(bodyOf(request.body).role) ?? "user";
    try {
      const user = await store.createUser({ ...fields, role });
      return reply.code(201).send({ user });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/api/users", async (request, reply) => {
    const body = bodyOf(request.body);
    const emailMessage = emailError(body.email);
    if (emailMessage) return fail(reply, 400, "invalid_input", emailMessage);
    const role = body.role == null ? undefined : roleOf(body.role);
    const status = body.status == null ? undefined : statusOf(body.status);
    if (body.role != null && !role) return fail(reply, 400, "invalid_input", "Choose a valid role.");
    if (body.status != null && !status) return fail(reply, 400, "invalid_input", "Choose a valid status.");
    if (!role && !status) return fail(reply, 400, "invalid_input", "Choose a role or status.");
    try {
      const user = await store.updateUser(normalizeEmail(body.email as string), { role: role ?? undefined, status: status ?? undefined });
      return { user };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/users/revoke-sessions", async (request, reply) => {
    const body = bodyOf(request.body);
    const emailMessage = emailError(body.email);
    if (emailMessage) return fail(reply, 400, "invalid_input", emailMessage);
    try {
      await store.revokeUserSessions(normalizeEmail(body.email as string));
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/auth/policy", async (_request, reply) => {
    try {
      const policy = await store.registration();
      return { selfRegistration: policy.selfRegistration };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/api/auth/policy", async (request, reply) => {
    const enabled = bodyOf(request.body).selfRegistration;
    if (typeof enabled !== "boolean") return fail(reply, 400, "invalid_input", "Choose whether self-registration is allowed.");
    try {
      return await store.setSelfRegistration(enabled);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

