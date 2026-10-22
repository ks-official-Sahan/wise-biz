import { createServer } from "node:net";
import { join } from "node:path";

import { createPool, migrate } from "@wise-biz/db";
import { isUuidv7, uuidv7 } from "@wise-biz/ids";
import { startRedis, testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer } from "../src/server.ts";

import type { RunningServer } from "../src/server.ts";
import type { RedisHarness } from "@wise-biz/testing/containers";
import type pg from "pg";

/**
 * P0-08a acceptance: identity + tenancy + kernel over real HTTP (fetch, cookies carried by hand) against the production
 * wiring from startServer, with Postgres and Redis containers. Each describe boots its own stack so Redis rate-limit
 * counters and Redis outages never leak between suites.
 */
const modulesDir = join(import.meta.dirname, "..", "..", "..", "modules");
const ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "https://evil.example";
const PASSWORD = "correct-horse-battery-staple-91";
const SESSION_COOKIE = "__Host-wb_session";
const BOOT_TIMEOUT_MS = 180_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIGRATIONS = ["infra", "audit", "identity", "tenancy", "_template"].map((module) => ({
  module,
  dir: join(modulesDir, module, "migrations"),
}));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });

const stopQuietly = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch {
    // already stopped or dropped
  }
};

interface Stack {
  base: string;
  redis: RedisHarness;
  admin: pg.Pool;
  close(): Promise<void>;
}

async function bootStack(): Promise<Stack> {
  const [redis, db] = await Promise.all([startRedis(), testDatabase()]);
  const admin = createPool(db.url("admin"), { max: 2 });
  const cleanup = async (): Promise<void> => {
    await stopQuietly(() => admin.end());
    await stopQuietly(() => redis.stop());
    await stopQuietly(() => db.drop());
  };
  try {
    await migrate(db.url("migrator"), MIGRATIONS);
    const server: RunningServer = await startServer({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: db.url("app"),
      DATABASE_IDENTITY_URL: db.url("identity"),
      AUTH_SECRET: "e2e-identity-tenancy-secret".padEnd(40, "x"),
      AUTH_URL: "http://localhost:3001",
      CORS_ORIGINS: ORIGIN,
      REDIS_URL: redis.url,
      PORT: String(await freePort()),
    });
    return {
      base: `http://127.0.0.1:${String(server.port)}`,
      redis,
      admin,
      close: async () => {
        await stopQuietly(() => server.close());
        await cleanup();
      },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

interface Reply {
  status: number;
  headers: Headers;
  json: unknown;
}

interface SendOpts {
  body?: unknown;
  cookie?: string;
  origin?: string;
}

const parseJson = (text: string): unknown => {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

async function send(
  stack: Stack,
  method: "GET" | "POST",
  path: string,
  opts: SendOpts = {},
): Promise<Reply> {
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST") headers["idempotency-key"] = uuidv7();
  const res = await fetch(`${stack.base}${path}`, {
    method,
    headers,
    redirect: "manual",
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, headers: res.headers, json: parseJson(await res.text()) };
}

interface ProblemBody {
  code: string;
  status: number;
  requestId: string;
}

const problemOf = (reply: Reply): ProblemBody => reply.json as ProblemBody;

function sessionSetCookie(reply: Reply): string {
  const raw = reply.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (raw === undefined) throw new Error(`no ${SESSION_COOKIE} Set-Cookie in reply`);
  return raw;
}

const cookieOf = (reply: Reply): string => sessionSetCookie(reply).split(";")[0] ?? "";

/** Cookie-only sign-up: returns the reply (Set-Cookie + session) and the email used. */
async function signUp(stack: Stack, name: string): Promise<{ email: string; reply: Reply }> {
  const email = `e2e-${uuidv7()}@example.com`;
  const reply = await send(stack, "POST", "/v1/auth/sign-up/email", {
    body: { name, email, password: PASSWORD },
  });
  expect(reply.status).toBe(200);
  return { email, reply };
}

const signIn = (stack: Stack, email: string, password = PASSWORD): Promise<Reply> =>
  send(stack, "POST", "/v1/auth/sign-in/email", { body: { email, password } });

interface Member {
  email: string;
  cookie: string;
  userId: string;
}

/** Sign up and return a cookie for the sign-up session (no tenant yet). */
async function enroll(stack: Stack, name: string): Promise<Member> {
  const { email, reply } = await signUp(stack, name);
  const cookie = cookieOf(reply);
  const session = await sessionOf(stack, cookie);
  return { email, cookie, userId: session.userId };
}

async function sessionOf(
  stack: Stack,
  cookie: string,
): Promise<{ userId: string; activeTenantId: string | null }> {
  const reply = await send(stack, "GET", "/v1/auth/get-session", { cookie });
  expect(reply.status).toBe(200);
  const body = reply.json as {
    session: { activeTenantId: string | null };
    user: { id: string };
  };
  return { userId: body.user.id, activeTenantId: body.session.activeTenantId };
}

interface Business {
  tenantId: string;
  name: string;
}

async function createBusiness(stack: Stack, cookie: string, name: string): Promise<Business> {
  const tenantId = uuidv7();
  const reply = await send(stack, "POST", "/v1/tenancy/tenants", {
    cookie,
    body: {
      tenantId,
      name,
      branch: {
        name: "Main",
        kind: "store",
        timezone: "Asia/Colombo",
        currency: "LKR",
        taxRegion: "LK",
      },
    },
  });
  expect(reply.status).toBe(201);
  return { tenantId, name };
}

async function createItem(stack: Stack, cookie: string, name: string): Promise<string> {
  const reply = await send(stack, "POST", "/v1/template/items", { cookie, body: { name } });
  expect(reply.status).toBe(201);
  return (reply.json as { id: string }).id;
}

interface ItemRow {
  id: string;
  name: string;
}

async function listItems(stack: Stack, cookie: string): Promise<Reply & { items: ItemRow[] }> {
  const reply = await send(stack, "GET", "/v1/template/items?limit=50", { cookie });
  const items = reply.status === 200 ? (reply.json as { items: ItemRow[] }).items : [];
  return { ...reply, items };
}

async function scalar(pool: pg.Pool, sql: string, params: unknown[]): Promise<string> {
  const res = await pool.query<Record<string, string>>(sql, params);
  const row = res.rows[0];
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (value === undefined) throw new Error(`no row for: ${sql}`);
  return value;
}

describe("identity + tenancy e2e (P0-08a)", () => {
  let main: Stack;
  let owner: { email: string; signUpReply: Reply; signInReply: Reply; cookie: string };
  let ownerBiz: Business;
  let ownerItemIds: string[];
  let other: Member;
  let otherBiz: Business;
  let otherItemId: string;

  beforeAll(async () => {
    main = await bootStack();

    const signedUp = await signUp(main, "Owner Olu");
    const signedIn = await signIn(main, signedUp.email);
    expect(signedIn.status).toBe(200);
    owner = {
      email: signedUp.email,
      signUpReply: signedUp.reply,
      signInReply: signedIn,
      cookie: cookieOf(signedIn),
    };
    ownerBiz = await createBusiness(main, owner.cookie, "Wise Co");
    ownerItemIds = [
      await createItem(main, owner.cookie, "rice"),
      await createItem(main, owner.cookie, "dal"),
    ];

    other = await enroll(main, "Other Ann");
    otherBiz = await createBusiness(main, other.cookie, "Other Co");
    otherItemId = await createItem(main, other.cookie, "tea");
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await main.close();
  });

  describe("owner journey", () => {
    it("the session created by sign-in is active on the business created with it", async () => {
      const session = await sessionOf(main, owner.cookie);
      expect(session.activeTenantId).toBe(ownerBiz.tenantId);
    });

    it("GET /v1/tenancy/me/tenants lists the business the owner created", async () => {
      const reply = await send(main, "GET", "/v1/tenancy/me/tenants", { cookie: owner.cookie });
      expect(reply.status).toBe(200);
      const tenants = (reply.json as { tenants: { tenantId: string; name: string }[] }).tenants;
      expect(tenants).toContainEqual(
        expect.objectContaining({ tenantId: ownerBiz.tenantId, name: ownerBiz.name }),
      );
    });

    it("the owner lists the items it created in its business", async () => {
      const page = await listItems(main, owner.cookie);
      expect(page.status).toBe(200);
      expect(page.items.map((i) => i.id)).toEqual(expect.arrayContaining(ownerItemIds));
    });

    it("the owner creates an item and it shows up in the next list", async () => {
      const id = await createItem(main, owner.cookie, "sugar");
      const page = await listItems(main, owner.cookie);
      expect(page.items.map((i) => i.id)).toContain(id);
    });
  });

  describe("second user isolation", () => {
    it("switching to another user's business returns 404 NOT_FOUND", async () => {
      const reply = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: other.cookie,
        body: { tenantId: ownerBiz.tenantId },
      });
      expect(reply.status).toBe(404);
      expect(reply.headers.get("content-type")).toContain("application/problem+json");
      expect(problemOf(reply).code).toBe("NOT_FOUND");
    });

    it("the refused switch leaves the second user's session on its own business", async () => {
      const session = await sessionOf(main, other.cookie);
      expect(session.activeTenantId).toBe(otherBiz.tenantId);
    });

    it("reading items as the second user returns only its own rows, never the owner's", async () => {
      const page = await listItems(main, other.cookie);
      expect(page.status).toBe(200);
      expect(page.items.map((i) => i.id)).toEqual([otherItemId]);
    });
  });

  describe("session cookie", () => {
    it("sign-up Set-Cookie is __Host-wb_session with Path=/, HttpOnly, Secure, SameSite=Strict and no Domain", () => {
      const raw = sessionSetCookie(owner.signUpReply);
      expect(raw.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      expect(raw.slice(SESSION_COOKIE.length + 1).split(";")[0]?.length).toBeGreaterThan(0);
      const attrs = raw
        .split(";")
        .slice(1)
        .map((a) => a.trim())
        .filter((a) => !/^(expires|max-age)=/i.test(a));
      expect([...attrs].sort()).toEqual(["HttpOnly", "Path=/", "SameSite=Strict", "Secure"]);
      expect(raw).not.toMatch(/;\s*domain=/i);
    });

    it("sign-in Set-Cookie carries the same attributes", () => {
      const raw = sessionSetCookie(owner.signInReply);
      const attrs = raw
        .split(";")
        .slice(1)
        .map((a) => a.trim())
        .filter((a) => !/^(expires|max-age)=/i.test(a));
      expect([...attrs].sort()).toEqual(["HttpOnly", "Path=/", "SameSite=Strict", "Secure"]);
      expect(raw).not.toMatch(/;\s*domain=/i);
    });
  });

  describe("origin guard", () => {
    it("a cookie-bearing POST with a foreign Origin is 403 ORIGIN_REJECTED", async () => {
      const reply = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: owner.cookie,
        origin: FOREIGN_ORIGIN,
        body: { tenantId: ownerBiz.tenantId },
      });
      expect(reply.status).toBe(403);
      expect(reply.headers.get("content-type")).toContain("application/problem+json");
      expect(problemOf(reply).code).toBe("ORIGIN_REJECTED");
    });

    it("the same cookie-bearing POST from an allowed origin is accepted (204)", async () => {
      const reply = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: owner.cookie,
        body: { tenantId: ownerBiz.tenantId },
      });
      expect(reply.status).toBe(204);
    });
  });

  describe("permission removal", () => {
    it("deleting a template:read grant returns 404 on the very next request, with no cache lag", async () => {
      const member = await enroll(main, "Cashier Cy");
      const pool = main.admin;
      const tenantId = ownerBiz.tenantId;
      const cashierRoleId = await scalar(
        pool,
        "select id from tenancy.roles where tenant_id = $1 and name = 'cashier'",
        [tenantId],
      );

      // Membership for the new user, holding the cashier system role (no template grants by default).
      const membershipId = uuidv7();
      await pool.query(
        "insert into tenancy.memberships (tenant_id, id, user_id, created_at) values ($1, $2, $3, now())",
        [tenantId, membershipId, member.userId],
      );
      await pool.query(
        "insert into tenancy.membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)",
        [tenantId, membershipId, cashierRoleId],
      );
      const switched = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: member.cookie,
        body: { tenantId },
      });
      expect(switched.status).toBe(204);

      const withoutGrant = await listItems(main, member.cookie);
      expect(withoutGrant.status).toBe(404);

      // Grant changes run in the tenant's context, as the app does: the version-bump trigger only sees that tenant.
      const inTenant = async (sql: string, params: unknown[]): Promise<number> => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
          const res = await client.query(sql, params);
          await client.query("commit");
          return res.rowCount ?? 0;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      };
      const grantId = uuidv7();
      await inTenant(
        "insert into tenancy.role_permissions (tenant_id, id, role_id, permission, created_at) values ($1, $2, $3, 'template:read', now())",
        [tenantId, grantId, cashierRoleId],
      );
      const withGrant = await listItems(main, member.cookie);
      expect(withGrant.status).toBe(200);
      expect(withGrant.items.map((i) => i.id)).toEqual(expect.arrayContaining(ownerItemIds));

      const deleted = await inTenant(
        "delete from tenancy.role_permissions where tenant_id = $1 and id = $2",
        [tenantId, grantId],
      );
      expect(deleted).toBe(1);

      const afterRevoke = await listItems(main, member.cookie);
      expect(afterRevoke.status).toBe(404);
      expect(problemOf(afterRevoke).code).toBe("NOT_FOUND");
    });
  });

  describe("identifiers", () => {
    it("every identity.users, identity.sessions and identity.accounts id is UUIDv7", async () => {
      for (const table of ["users", "sessions", "accounts"]) {
        const res = await main.admin.query<{ id: string }>(`select id from identity.${table}`);
        expect(res.rows.length, `identity.${table} has rows`).toBeGreaterThan(0);
        for (const row of res.rows) {
          expect(row.id, `identity.${table}.id`).toMatch(UUID_V7);
          expect(isUuidv7(row.id), `identity.${table}.id`).toBe(true);
        }
      }
    });
  });
});

describe("sign-in rate limit (Redis, per IP and per email)", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await bootStack();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  });

  it("the 11th sign-in within a minute is refused with 429 RATE_LIMITED and a Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      const attempt = await signIn(stack, `nobody-${uuidv7()}@example.com`);
      expect(attempt.status).not.toBe(429);
    }
    const eleventh = await signIn(stack, `nobody-${uuidv7()}@example.com`);
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("content-type")).toContain("application/problem+json");
    expect(problemOf(eleventh).code).toBe("RATE_LIMITED");
    const retryAfter = Number(eleventh.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("Redis outage fails closed for sign-in only", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await bootStack();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  });

  it("with Redis stopped, sign-in is 503 RATE_LIMIT_UNAVAILABLE and a GET with a valid session stays 200", async () => {
    const member = await enroll(stack, "Redis Ray");
    const biz = await createBusiness(stack, member.cookie, "Ray Co");
    const itemId = await createItem(stack, member.cookie, "bread");

    await stack.redis.stop();

    const refused = await signIn(stack, member.email);
    expect(refused.status).toBe(503);
    expect(problemOf(refused).code).toBe("RATE_LIMIT_UNAVAILABLE");

    const read = await listItems(stack, member.cookie);
    expect(read.status).toBe(200);
    expect(read.items.map((i) => i.id)).toEqual([itemId]);
    expect(biz.tenantId).toBeTruthy();
  });
});
