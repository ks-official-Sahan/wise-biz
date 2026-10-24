import { createPool } from "@wise-biz/db";
import { isUuidv7, uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLIENT_IP_HEADER, createIdentity, SESSION_COOKIE_NAME } from "../src/index.ts";

import {
  call,
  ORIGIN,
  PASSWORD,
  signIn,
  signedInJar,
  signUpVerified,
  startIdentity,
} from "./support/harness.ts";

import type { IdentityHarness } from "./support/harness.ts";

let h: IdentityHarness;

/** `__Host-wb_session=<value>` pair from a response, or throws. */
function sessionCookiePair(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!header) throw new Error("no session cookie");
  return header.split(";")[0] ?? "";
}

beforeAll(async () => {
  h = await startIdentity();
});

afterAll(async () => {
  await h.close();
});

describe("sign-up and sign-in", () => {
  it("signs up, verifies by link, then signs in with an exact session cookie", async () => {
    await signUpVerified(h, "alice@example.com");

    const { res: inRes } = await signIn(h, "alice@example.com");
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
    expect((session[0] ?? "").startsWith("__Host-wb_session=")).toBe(true);
  });

  it("stores the email lower-cased", async () => {
    const { rows } = await h.adminPool.query<{ email: string }>(
      "SELECT email FROM identity.users WHERE email ILIKE 'alice@example.com'",
    );
    expect(rows.map((r) => r.email)).toEqual(["alice@example.com"]);
  });

  it("rejects a weak password", async () => {
    const res = await call(h.identity, "POST", "/sign-up/email", {
      body: { email: "weak@example.com", password: "Password123", name: "W" },
    });
    expect(res.status).toBe(400);
    const { rows } = await h.adminPool.query(
      "SELECT 1 FROM identity.users WHERE email = 'weak@example.com'",
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects a wrong password", async () => {
    const res = await call(h.identity, "POST", "/sign-in/email", {
      body: { email: "alice@example.com", password: "Wrong-Password-77" },
    });
    expect(res.status).toBe(401);
  });
});

describe("ids", () => {
  it("every identity row has a UUIDv7 id", async () => {
    for (const table of ["users", "sessions", "accounts", "verifications"]) {
      const { rows } = await h.adminPool.query<{ id: string }>(`SELECT id FROM identity.${table}`);
      for (const r of rows) expect(isUuidv7(r.id), `${table}.${r.id}`).toBe(true);
    }
    const { rows } = await h.adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM identity.sessions",
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("getSession / setActiveTenant / sign-out", () => {
  it("resolves a session with email and verification state, persists the active tenant, and invalidates on sign-out", async () => {
    await signUpVerified(h, "bob@example.com");
    const { res: inRes, jar } = await signIn(h, "bob@example.com");
    expect(inRes.status).toBe(200);
    const headers = jar.sessionHeaders();

    const s = await h.identity.getSession(headers);
    if (!s) throw new Error("expected a session");
    expect(isUuidv7(s.sessionId)).toBe(true);
    expect(isUuidv7(s.userId)).toBe(true);
    expect(s.email).toBe("bob@example.com");
    expect(s.emailVerified).toBe(true);
    expect(s.activeTenantId).toBeNull();
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const tenantId = uuidv7();
    await h.identity.setActiveTenant(s.sessionId, s.userId, tenantId);
    expect((await h.identity.getSession(headers))?.activeTenantId).toBe(tenantId);

    await h.identity.setActiveTenant(s.sessionId, s.userId, null);
    expect((await h.identity.getSession(headers))?.activeTenantId).toBeNull();

    const out = await call(h.identity, "POST", "/sign-out", { body: {}, jar });
    expect(out.status).toBe(200);
    expect(await h.identity.getSession(headers)).toBeNull();
  });

  it("returns null for missing, malformed, tampered and expired sessions", async () => {
    expect(await h.identity.getSession(new Headers())).toBeNull();
    expect(
      await h.identity.getSession(new Headers({ cookie: `${SESSION_COOKIE_NAME}=%%%garbage.@@` })),
    ).toBeNull();
    expect(
      await h.identity.getSession(new Headers({ cookie: `${SESSION_COOKIE_NAME}=abc.def` })),
    ).toBeNull();

    await signUpVerified(h, "carol@example.com");
    const { res: inRes } = await signIn(h, "carol@example.com");
    const pair = sessionCookiePair(inRes);
    const headers = new Headers({ cookie: pair });
    expect(await h.identity.getSession(headers)).not.toBeNull();
    // Tamper with the signature part.
    expect(await h.identity.getSession(new Headers({ cookie: `${pair}x` }))).toBeNull();
    // Expire the row.
    await h.adminPool.query(
      "UPDATE identity.sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM identity.users WHERE email = 'carol@example.com')",
    );
    expect(await h.identity.getSession(headers)).toBeNull();
  });
});

describe("privilege separation", () => {
  it("wb_app cannot read identity.users", async () => {
    await expect(h.appPool.query("SELECT id FROM identity.users")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("review hardening", () => {
  it("getSession rethrows infrastructure errors (ended pool) and never answers anonymous", async () => {
    await signUpVerified(h, "infra@example.com");
    const { jar } = await signIn(h, "infra@example.com");
    const headers = jar.sessionHeaders();
    const pool = createPool(h.db.url("identity"), { max: 1 });
    const broken = createIdentity({
      pool,
      secret: "test-secret-test-secret-test-secret-0123456789",
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      mailer: h.mailer,
      consoleUrl: "http://localhost:3001",
      rpId: "localhost",
      rpOrigins: [ORIGIN],
    });
    expect(await broken.getSession(headers)).not.toBeNull();
    await pool.end();
    await expect(broken.getSession(headers)).rejects.toThrow();
  });

  it("setActiveTenant only moves the caller's own session", async () => {
    await signUpVerified(h, "owner-of-session@example.com");
    const jar = await signedInJar(h, "owner-of-session@example.com");
    const headers = jar.sessionHeaders();
    const s = await h.identity.getSession(headers);
    if (!s) throw new Error("expected a session");
    const tenantId = uuidv7();
    await h.identity.setActiveTenant(s.sessionId, uuidv7(), tenantId); // wrong user
    expect((await h.identity.getSession(headers))?.activeTenantId).toBeNull();
    await h.identity.setActiveTenant(s.sessionId, s.userId, tenantId);
    expect((await h.identity.getSession(headers))?.activeTenantId).toBe(tenantId);
  });

  it("stores the kernel-provided IP header, ignoring a client x-forwarded-for", async () => {
    const email = "ip@example.com";
    await signUpVerified(h, email);
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
    expect((await h.identity.handler(req)).status).toBe(200);
    const r = await h.adminPool.query<{ ip_address: string | null }>(
      "SELECT s.ip_address FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id WHERE u.email = $1 ORDER BY s.created_at DESC",
      [email],
    );
    expect(r.rows[0]?.ip_address).toBe("8.8.4.4");
  });
});
