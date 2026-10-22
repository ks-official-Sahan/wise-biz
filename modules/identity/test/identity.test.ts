import { join } from "node:path";

import { createPool, migrate } from "@wise-biz/db";
import { isUuidv7, uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLIENT_IP_HEADER, createIdentity, SESSION_COOKIE_NAME } from "../src/index.ts";

import type { IdentityPort } from "../src/index.ts";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const ORIGIN = "http://localhost:3000";
const PASSWORD = "Correct-Horse-Battery-9";
const root = join(import.meta.dirname, "..");

let db: TestDatabase;
let identityPool: pg.Pool;
let appPool: pg.Pool;
let adminPool: pg.Pool;
let identity: IdentityPort;

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${ORIGIN}/v1/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** `__Host-wb_session=<value>` pair from a response, or throws. */
function sessionCookiePair(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!header) throw new Error("no session cookie");
  return header.split(";")[0] ?? "";
}

async function signUp(email: string): Promise<Response> {
  return identity.handler(post("/sign-up/email", { email, password: PASSWORD, name: "Test User" }));
}

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(root, "../infra/migrations") },
    { module: "identity", dir: join(root, "migrations") },
  ]);
  identityPool = createPool(db.url("identity"), { max: 4 });
  appPool = createPool(db.url("app"), { max: 2 });
  adminPool = createPool(db.url("admin"), { max: 2 });
  identity = createIdentity({
    pool: identityPool,
    secret: "test-secret-test-secret-test-secret-0123456789",
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
  });
});

afterAll(async () => {
  await Promise.all([identityPool.end(), appPool.end(), adminPool.end()]);
  await db.drop();
});

describe("sign-up and sign-in", () => {
  it("signs up then in, with an exact session cookie", async () => {
    const up = await signUp("Alice@Example.com");
    expect(up.status).toBe(200);

    const inRes = await identity.handler(
      post("/sign-in/email", { email: "alice@example.com", password: PASSWORD }),
    );
    expect(inRes.status).toBe(200);
    const cookies = inRes.headers.getSetCookie();
    const session = cookies.filter((c) => c.includes("session"));
    expect(session).toHaveLength(1);
    const [pair, ...attrs] = (session[0] ?? "").split(";").map((s) => s.trim());
    expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[^=\\s]+$`));
    const names = attrs.map((a) => a.split("=")[0]?.toLowerCase());
    expect(names).toEqual(
      expect.arrayContaining(["path", "httponly", "secure", "samesite", "max-age"]),
    );
    expect(names).not.toContain("domain");
    expect(attrs).toContain("Path=/");
    expect(attrs).toContain("HttpOnly");
    expect(attrs).toContain("Secure");
    expect(attrs).toContain("SameSite=Strict");
    expect(attrs).toContain("Max-Age=43200");
    // No other prefix glued on.
    expect((session[0] ?? "").startsWith("__Host-wb_session=")).toBe(true);
  });

  it("stores the email lower-cased", async () => {
    const { rows } = await adminPool.query<{ email: string }>(
      "SELECT email FROM identity.users WHERE email ILIKE 'alice@example.com'",
    );
    expect(rows.map((r) => r.email)).toEqual(["alice@example.com"]);
  });

  it("rejects a weak password", async () => {
    const res = await identity.handler(
      post("/sign-up/email", { email: "weak@example.com", password: "Password123", name: "W" }),
    );
    expect(res.status).toBe(400);
    const { rows } = await adminPool.query(
      "SELECT 1 FROM identity.users WHERE email = 'weak@example.com'",
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects a duplicate email without echoing the existing account", async () => {
    const res = await signUp("alice@example.com");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const text = await res.text();
    expect(text).not.toMatch(/Correct-Horse/);
    expect(text).not.toMatch(/\balice\b/i);
    expect(
      res.headers.getSetCookie().filter((c) => c.startsWith(SESSION_COOKIE_NAME)),
    ).toHaveLength(0);
  });

  it("rejects a wrong password", async () => {
    const res = await identity.handler(
      post("/sign-in/email", { email: "alice@example.com", password: "Wrong-Password-77" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("ids", () => {
  it("every identity row has a UUIDv7 id", async () => {
    for (const table of ["users", "sessions", "accounts", "verifications"]) {
      const { rows } = await adminPool.query<{ id: string }>(`SELECT id FROM identity.${table}`);
      for (const r of rows) expect(isUuidv7(r.id), `${table}.${r.id}`).toBe(true);
    }
    const { rows } = await adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM identity.sessions",
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("getSession / setActiveTenant / sign-out", () => {
  it("resolves a session, persists the active tenant, and invalidates on sign-out", async () => {
    await signUp("bob@example.com");
    const inRes = await identity.handler(
      post("/sign-in/email", { email: "bob@example.com", password: PASSWORD }),
    );
    const cookie = sessionCookiePair(inRes);
    const headers = new Headers({ cookie });

    const s = await identity.getSession(headers);
    if (!s) throw new Error("expected a session");
    expect(isUuidv7(s.sessionId)).toBe(true);
    expect(isUuidv7(s.userId)).toBe(true);
    expect(s.activeTenantId).toBeNull();
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const tenantId = uuidv7();
    await identity.setActiveTenant(s.sessionId, s.userId, tenantId);
    expect((await identity.getSession(headers))?.activeTenantId).toBe(tenantId);

    await identity.setActiveTenant(s.sessionId, s.userId, null);
    expect((await identity.getSession(headers))?.activeTenantId).toBeNull();

    const out = await identity.handler(post("/sign-out", {}, cookie));
    expect(out.status).toBe(200);
    expect(await identity.getSession(headers)).toBeNull();
  });

  it("returns null for missing, malformed, tampered and expired sessions", async () => {
    expect(await identity.getSession(new Headers())).toBeNull();
    expect(
      await identity.getSession(new Headers({ cookie: `${SESSION_COOKIE_NAME}=%%%garbage.@@` })),
    ).toBeNull();
    expect(
      await identity.getSession(new Headers({ cookie: `${SESSION_COOKIE_NAME}=abc.def` })),
    ).toBeNull();

    await signUp("carol@example.com");
    const inRes = await identity.handler(
      post("/sign-in/email", { email: "carol@example.com", password: PASSWORD }),
    );
    const pair = sessionCookiePair(inRes);
    const headers = new Headers({ cookie: pair });
    expect(await identity.getSession(headers)).not.toBeNull();
    // Tamper with the signature part.
    expect(await identity.getSession(new Headers({ cookie: `${pair}x` }))).toBeNull();
    // Expire the row.
    await adminPool.query(
      "UPDATE identity.sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM identity.users WHERE email = 'carol@example.com')",
    );
    expect(await identity.getSession(headers)).toBeNull();
  });
});

describe("privilege separation", () => {
  it("wb_app cannot read identity.users", async () => {
    await expect(appPool.query("SELECT id FROM identity.users")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("review hardening", () => {
  async function signedIn(email: string): Promise<{ pair: string; headers: Headers }> {
    await signUp(email);
    const res = await identity.handler(post("/sign-in/email", { email, password: PASSWORD }));
    const pair = sessionCookiePair(res);
    return { pair, headers: new Headers({ cookie: pair }) };
  }

  it("getSession rethrows infrastructure errors (ended pool) and never answers anonymous", async () => {
    const { headers } = await signedIn("infra@example.com");
    const pool = createPool(db.url("identity"), { max: 1 });
    const broken = createIdentity({
      pool,
      secret: "test-secret-test-secret-test-secret-0123456789",
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
    });
    expect(await broken.getSession(headers)).not.toBeNull();
    await pool.end();
    await expect(broken.getSession(headers)).rejects.toThrow();
  });

  it("setActiveTenant only moves the caller's own session", async () => {
    const { headers } = await signedIn("owner-of-session@example.com");
    const s = await identity.getSession(headers);
    if (!s) throw new Error("expected a session");
    const tenantId = uuidv7();
    await identity.setActiveTenant(s.sessionId, uuidv7(), tenantId); // wrong user
    expect((await identity.getSession(headers))?.activeTenantId).toBeNull();
    await identity.setActiveTenant(s.sessionId, s.userId, tenantId);
    expect((await identity.getSession(headers))?.activeTenantId).toBe(tenantId);
  });

  it("stores the kernel-provided IP header, ignoring a client x-forwarded-for", async () => {
    const email = "ip@example.com";
    await signUp(email);
    const req = new Request(`${ORIGIN}/v1/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-forwarded-for": "6.6.6.6",
        [CLIENT_IP_HEADER]: "8.8.4.4",
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect((await identity.handler(req)).status).toBe(200);
    const r = await adminPool.query<{ ip_address: string | null }>(
      "SELECT s.ip_address FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id WHERE u.email = $1 ORDER BY s.created_at DESC",
      [email],
    );
    expect(r.rows[0]?.ip_address).toBe("8.8.4.4");
  });
});
