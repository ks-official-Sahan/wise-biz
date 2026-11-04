import { join } from "node:path";

import { createPool, migrate } from "@wise-biz/db";
import { createCaptureMailer } from "@wise-biz/mailer";
import { testDatabase } from "@wise-biz/testing/containers";

import { createIdentity, SESSION_COOKIE_NAME } from "../../src/index.ts";

import type { CreateIdentityOptions } from "../../src/identity.ts";
import type { IdentityPort } from "../../src/index.ts";
import type { Mailer, SentMail } from "@wise-biz/mailer";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

export const ORIGIN = "http://localhost:3000";
export const CONSOLE_URL = "http://localhost:3001";
export const RP_ID = "localhost";
export const PASSWORD = "Correct-Horse-Battery-9";
const SECRET = "test-secret-test-secret-test-secret-0123456789";
const moduleRoot = join(import.meta.dirname, "..", "..");

export type CaptureMailer = Mailer & { sent: SentMail[]; clear(): void };

export interface IdentityHarness {
  readonly identity: IdentityPort;
  readonly mailer: CaptureMailer;
  readonly adminPool: pg.Pool;
  readonly identityPool: pg.Pool;
  readonly appPool: pg.Pool;
  readonly db: TestDatabase;
  /** Same database, a different identity instance (e.g. with another mailer). Closed by close(). */
  build(overrides?: Partial<CreateIdentityOptions>): IdentityPort;
  close(): Promise<void>;
}

/** Fresh database, all migrations (infra + identity), one identity instance wired to a capture mailer. */
export async function startIdentity(): Promise<IdentityHarness> {
  const db: TestDatabase = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(moduleRoot, "../infra/migrations") },
    { module: "identity", dir: join(moduleRoot, "migrations") },
  ]);
  const identityPool = createPool(db.url("identity"), { max: 6 });
  const appPool = createPool(db.url("app"), { max: 2 });
  const adminPool = createPool(db.url("admin"), { max: 2 });
  const mailer = createCaptureMailer();
  const base: CreateIdentityOptions = {
    pool: identityPool,
    secret: SECRET,
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    mailer,
    consoleUrl: CONSOLE_URL,
    rpId: RP_ID,
    rpOrigins: [ORIGIN],
  };
  const identity = createIdentity(base);
  const extraPools: pg.Pool[] = [];
  return {
    identity,
    mailer,
    adminPool,
    identityPool,
    appPool,
    db,
    build(overrides = {}) {
      const pool = createPool(db.url("identity"), { max: 2 });
      extraPools.push(pool);
      return createIdentity({ ...base, pool, ...overrides });
    },
    async close() {
      await Promise.all([
        identityPool.end(),
        appPool.end(),
        adminPool.end(),
        ...extraPools.map((p) => p.end().catch(() => undefined)),
      ]);
      await db.drop();
    },
  };
}

/** Cookie jar: keeps every name=value the server sets, drops cleared ones. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0\b/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  sessionHeaders(): Headers {
    return new Headers({ cookie: this.header() });
  }
}

export function authRequest(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; jar?: CookieJar; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}/v1/auth${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** Sends one request through the identity handler and feeds any Set-Cookie into the jar. */
export async function call(
  identity: IdentityPort,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; jar?: CookieJar; origin?: string | null } = {},
): Promise<Response> {
  const res = await identity.handler(authRequest(method, path, opts));
  opts.jar?.absorb(res);
  return res;
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Polls the capture mailer until a message to `to` arrives (mail is sent off the request path). */
export async function waitForMail(
  mailer: CaptureMailer,
  to: string,
  subject: string,
  timeoutMs = 2000,
): Promise<SentMail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matches = mailer.sent.filter((m) => m.to === to && m.subject === subject);
    const last = matches[matches.length - 1];
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`no mail "${subject}" captured`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The Better Auth verification link from a verification mail. */
export function verifyLinkOf(mail: SentMail): string {
  const link = mail.text
    .split(/\s+/)
    .find((w) => w.startsWith("http") && w.includes("/verify-email"));
  if (link === undefined) throw new Error("no verification link in mail");
  return link;
}

/** The six-digit code from a second-factor mail. */
export function otpOf(mail: SentMail): string {
  const match = /\b(\d{6})\b/.exec(mail.text);
  if (!match?.[1]) throw new Error("no OTP in mail");
  return match[1];
}

export const SUBJECT_VERIFY = "Confirm your wise-biz email";
export const SUBJECT_OTP = "Your wise-biz sign-in code";

/** Signs up, follows the emailed verification link. Returns the verified address. */
export async function signUpVerified(
  h: IdentityHarness,
  email: string,
  name = "Test User",
): Promise<void> {
  const up = await call(h.identity, "POST", "/sign-up/email", {
    body: { email, password: PASSWORD, name },
  });
  if (up.status !== 200) throw new Error(`sign-up failed: ${String(up.status)}`);
  const mail = await waitForMail(h.mailer, email.toLowerCase(), SUBJECT_VERIFY);
  const verify = await h.identity.handler(new Request(verifyLinkOf(mail)));
  if (verify.status >= 400) throw new Error(`verify failed: ${String(verify.status)}`);
}

/** Password sign-in with a fresh jar. Caller decides what to assert on the response. */
export async function signIn(
  h: IdentityHarness,
  email: string,
  password = PASSWORD,
): Promise<{ res: Response; jar: CookieJar }> {
  const jar = new CookieJar();
  const res = await call(h.identity, "POST", "/sign-in/email", {
    body: { email, password },
    jar,
  });
  return { res, jar };
}

/** Signed-in jar for a verified user, or throws. */
export async function signedInJar(h: IdentityHarness, email: string): Promise<CookieJar> {
  const { res, jar } = await signIn(h, email);
  if (res.status !== 200 || !jar.has(SESSION_COOKIE_NAME))
    throw new Error(`sign-in failed: ${String(res.status)}`);
  return jar;
}
