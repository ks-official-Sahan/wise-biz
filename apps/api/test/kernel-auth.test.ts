import { createCatalog } from "@wise-biz/policy";
import { describe, expect, it, vi } from "vitest";

import {
  createPolicyMatrixCache,
  nodeRedisKernel,
  policyKey,
  sessionResolver,
} from "../src/kernel/auth/index.ts";

import { build, devHeaders, TENANT, USER } from "./helpers.ts";

import type { KernelRedis, NodeRedisLike } from "../src/kernel/auth/index.ts";
import type { AppEnv } from "@wise-biz/module-kit";
import type { Context } from "hono";

const SESSION = "01900000-0000-7000-8000-0000000000aa";
const COOKIE = "__Host-wb_session";
const catalog = createCatalog(["probe:read", "probe:write"]);

interface Problem {
  code: string;
  status: number;
}

/** In-memory KernelRedis with real fixed-window semantics (INCR, PEXPIRE NX, PTTL). */
function fakeRedis(): KernelRedis & {
  store: Map<string, string>;
  counts: Map<string, number>;
  gets: string[];
} {
  const store = new Map<string, string>();
  const counts = new Map<string, number>();
  const gets: string[] = [];
  return {
    store,
    counts,
    gets,
    get: (k) => {
      gets.push(k);
      return Promise.resolve(store.get(k) ?? null);
    },
    set: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
    hit: (k, windowMs) => {
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return Promise.resolve({ count: n, ttlMs: windowMs });
    },
    claim: (k) => {
      if (store.has(k)) return Promise.resolve(false);
      store.set(k, "1");
      return Promise.resolve(true);
    },
  };
}

const downRedis: KernelRedis = {
  get: () => Promise.reject(new Error("redis down")),
  set: () => Promise.reject(new Error("redis down")),
  hit: () => Promise.reject(new Error("redis down")),
  claim: () => Promise.reject(new Error("redis down")),
};
const hungRedis: KernelRedis = {
  get: () => new Promise(() => undefined),
  set: () => new Promise(() => undefined),
  hit: () => new Promise(() => undefined),
  claim: () => new Promise(() => undefined),
};

describe("sessionResolver (fail closed)", () => {
  const fakeCtx = (cookie?: string): Context<AppEnv> =>
    ({
      req: {
        header: (n: string) => (n === "cookie" ? cookie : undefined),
        raw: { headers: new Headers(cookie === undefined ? {} : { cookie }) },
      },
      get: () => "req-1",
    }) as never;
  const session = (activeTenantId: string | null, emailVerified = true) => ({
    sessionId: SESSION,
    userId: USER,
    email: "ana@example.com",
    emailVerified,
    activeTenantId,
  });
  const mk = (
    s: ReturnType<typeof session> | null,
    m: Awaited<
      ReturnType<
        NonNullable<Parameters<typeof sessionResolver>[0]["memberships"]["loadMembership"]>
      >
    >,
  ) => {
    const getSession = vi.fn(() => Promise.resolve(s));
    const loadMembership = vi.fn(() => Promise.resolve(m));
    return {
      getSession,
      loadMembership,
      resolve: sessionResolver({
        sessions: { getSession },
        memberships: { loadMembership },
        cookieName: COOKIE,
      }),
    };
  };

  it("no cookie: anonymous without touching the session store", async () => {
    const r = mk(session(TENANT), null);
    expect(await r.resolve(fakeCtx())).toEqual({ kind: "anonymous" });
    expect(await r.resolve(fakeCtx("other=1"))).toEqual({ kind: "anonymous" });
    expect(r.getSession).not.toHaveBeenCalled();
  });

  it("unknown or expired session: anonymous", async () => {
    const r = mk(null, null);
    expect(await r.resolve(fakeCtx(`${COOKIE}=x`))).toEqual({ kind: "anonymous" });
    expect(r.loadMembership).not.toHaveBeenCalled();
  });

  it("session without an active tenant, or a malformed one: signed in, tenantId null", async () => {
    for (const t of [null, "not-a-uuid"]) {
      const r = mk(session(t), null);
      expect(await r.resolve(fakeCtx(`${COOKIE}=x`))).toMatchObject({
        kind: "user",
        userId: USER,
        tenantId: null,
        roles: [],
      });
      expect(r.loadMembership).not.toHaveBeenCalled();
    }
  });

  it("missing or suspended membership: tenantId null (fail closed)", async () => {
    const r = mk(session(TENANT), null);
    expect(await r.resolve(fakeCtx(`${COOKIE}=x`))).toMatchObject({ tenantId: null, roles: [] });
    expect(r.loadMembership).toHaveBeenCalledWith(USER, TENANT, "req-1");
  });

  it("active membership: full context with roles, branch scope and version", async () => {
    const r = mk(session(TENANT), {
      membershipId: SESSION,
      roles: ["manager"],
      branchScope: "all",
      permissionsVersion: 7,
    });
    expect(await r.resolve(fakeCtx(`a=1; ${COOKIE}=x`))).toEqual({
      kind: "user",
      userId: USER,
      sessionId: SESSION,
      tenantId: TENANT,
      roles: ["manager"],
      branchScope: "all",
      permissionsVersion: 7,
      email: "ana@example.com",
      emailVerified: true,
    });
  });

  it("infrastructure errors propagate and never grant access", async () => {
    const resolve = sessionResolver({
      sessions: { getSession: () => Promise.resolve(session(TENANT)) },
      memberships: { loadMembership: () => Promise.reject(new Error("db down")) },
      cookieName: COOKIE,
    });
    await expect(resolve(fakeCtx(`${COOKIE}=x`))).rejects.toThrow("db down");
  });
});

describe("policy matrix cache (LRU -> Redis -> DB)", () => {
  const rows = [{ role: "cashier", permission: "probe:write" }];
  const mk = (over: Partial<Parameters<typeof createPolicyMatrixCache>[0]> = {}) => {
    const loadRows = vi.fn(() => Promise.resolve(rows));
    const cache = createPolicyMatrixCache({ catalog, loadRows, ...over });
    return { cache, loadRows };
  };

  it("DB miss fills Redis under t:{tenant}:perm:v{n} with a 1 h TTL and builds the matrix", async () => {
    const redis = fakeRedis();
    const setSpy = vi.spyOn(redis, "set");
    const { cache, loadRows } = mk({ redis });
    const m = await cache.matrixFor(TENANT, 3, "r");
    expect(m.cashier?.map((g) => g.permission)).toEqual(["probe:write"]);
    expect(loadRows).toHaveBeenCalledTimes(1);
    expect(policyKey(TENANT, 3)).toBe(`t:${TENANT}:perm:v3`);
    expect(setSpy).toHaveBeenCalledWith(policyKey(TENANT, 3), JSON.stringify(rows), 3600);
  });

  it("in-process LRU answers repeat calls without Redis or DB", async () => {
    const redis = fakeRedis();
    const { cache, loadRows } = mk({ redis });
    await cache.matrixFor(TENANT, 1, "r");
    redis.gets.length = 0;
    await cache.matrixFor(TENANT, 1, "r");
    expect(redis.gets).toEqual([]);
    expect(loadRows).toHaveBeenCalledTimes(1);
  });

  it("a Redis hit (another instance filled it) skips the DB", async () => {
    const redis = fakeRedis();
    redis.store.set(policyKey(TENANT, 2), JSON.stringify(rows));
    const { cache, loadRows } = mk({ redis });
    expect((await cache.matrixFor(TENANT, 2, "r")).cashier).toBeDefined();
    expect(loadRows).not.toHaveBeenCalled();
  });

  it("a new permissions version bypasses the old entries", async () => {
    const redis = fakeRedis();
    const { cache, loadRows } = mk({ redis });
    await cache.matrixFor(TENANT, 1, "r");
    await cache.matrixFor(TENANT, 2, "r");
    expect(loadRows).toHaveBeenCalledTimes(2);
  });

  it("Redis down: reads fall through to the DB and still work", async () => {
    const { cache, loadRows } = mk({ redis: downRedis });
    expect((await cache.matrixFor(TENANT, 1, "r")).cashier).toBeDefined();
    expect(loadRows).toHaveBeenCalledTimes(1);
  });

  it("Redis hung: the 200 ms timeout falls through to the DB", async () => {
    const { cache } = mk({ redis: hungRedis, redisTimeoutMs: 20 });
    const started = Date.now();
    expect((await cache.matrixFor(TENANT, 1, "r")).cashier).toBeDefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("corrupt Redis entries are a miss, never trusted", async () => {
    for (const bad of ["not json", '{"role":1}', '[{"role":5}]']) {
      const redis = fakeRedis();
      redis.store.set(policyKey(TENANT, 1), bad);
      const { cache, loadRows } = mk({ redis });
      expect((await cache.matrixFor(TENANT, 1, "r")).cashier).toBeDefined();
      expect(loadRows).toHaveBeenCalledTimes(1);
    }
  });

  it("evicts the least recently used entry beyond lruMax", async () => {
    const { cache, loadRows } = mk({ lruMax: 2 });
    await cache.matrixFor(TENANT, 1, "r");
    await cache.matrixFor(TENANT, 2, "r");
    await cache.matrixFor(TENANT, 1, "r"); // refresh v1; v2 is now the oldest
    await cache.matrixFor(TENANT, 3, "r"); // evicts v2
    expect(loadRows).toHaveBeenCalledTimes(3);
    await cache.matrixFor(TENANT, 1, "r");
    expect(loadRows).toHaveBeenCalledTimes(3);
    await cache.matrixFor(TENANT, 2, "r");
    expect(loadRows).toHaveBeenCalledTimes(4);
  });

  it("concurrent misses share one load (single flight)", async () => {
    const { cache, loadRows } = mk();
    await Promise.all(Array.from({ length: 20 }, () => cache.matrixFor(TENANT, 1, "r")));
    expect(loadRows).toHaveBeenCalledTimes(1);
  });

  it("a failing DB load is not cached", async () => {
    const loadRows = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(rows);
    const cache = createPolicyMatrixCache({ catalog, loadRows });
    await expect(cache.matrixFor(TENANT, 1, "r")).rejects.toThrow("db down");
    expect((await cache.matrixFor(TENANT, 1, "r")).cashier).toBeDefined();
  });
});

describe("policy in createApp", () => {
  it("uses stored grants per tenant: a role with a stored row is allowed, others 404", async () => {
    const policyRows = vi.fn(() =>
      Promise.resolve([{ role: "cashier", permission: "probe:write" }]),
    );
    const { app } = build({ policyRows });
    const ok = await app.request("/v1/probe/guarded", {
      headers: devHeaders({ "x-wb-dev-roles": "cashier" }),
    });
    expect(ok.status).toBe(200);
    const no = await app.request("/v1/probe/guarded", {
      headers: devHeaders({ "x-wb-dev-roles": "manager" }),
    });
    expect(no.status).toBe(404);
    expect(policyRows).toHaveBeenCalledTimes(1); // cached per tenant + version
  });
});

describe("rate limiter (fail closed, writes only)", () => {
  const identity = { handler: vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))) };
  const signIn = (app: ReturnType<typeof build>["app"], email = "a@b.test", ip = "1.1.1.1") =>
    app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: "irrelevant-password" }),
    });
  const trusting = {
    NODE_ENV: "test",
    CORS_ORIGINS: ["https://app.test"],
    TRUST_PROXY_HOPS: 1,
  } as const;

  it("mounts identity at /v1/auth/* and skips the resolver there", async () => {
    const auth = vi.fn(() => Promise.resolve({ kind: "anonymous" as const }));
    const { app } = build({ identity, kernelRedis: fakeRedis(), auth });
    expect((await signIn(app)).status).toBe(200);
    expect(identity.handler).toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("11th sign-in per IP in a minute is 429 with Retry-After", async () => {
    const { app } = build({ identity, kernelRedis: fakeRedis(), env: trusting });
    for (let i = 0; i < 10; i++) {
      expect((await signIn(app, `u${String(i)}@b.test`)).status).toBe(200);
    }
    const res = await signIn(app, "u11@b.test");
    expect(res.status).toBe(429);
    expect(((await res.json()) as Problem).code).toBe("RATE_LIMITED");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // another IP is a different bucket
    expect((await signIn(app, "other@b.test", "2.2.2.2")).status).toBe(200);
  });

  it("6th sign-in for the same email (any IP) is 429; the email is hashed and case-insensitive", async () => {
    const redis = fakeRedis();
    const { app } = build({ identity, kernelRedis: redis, env: trusting });
    for (let i = 0; i < 5; i++) {
      expect((await signIn(app, "Victim@B.test", `9.9.9.${String(i)}`)).status).toBe(200);
    }
    expect((await signIn(app, "victim@b.test", "9.9.9.9")).status).toBe(429);
    const keys = [...redis.counts.keys()].join(" ");
    expect(keys).not.toContain("victim");
    expect(keys).toMatch(/rl:signin:email:[0-9a-f]{64}/);
  });

  it("sign-up: 6th per IP is 429", async () => {
    const { app } = build({ identity, kernelRedis: fakeRedis(), env: trusting });
    const up = () =>
      app.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers: { "x-forwarded-for": "3.3.3.3", "content-type": "application/json" },
        body: "{}",
      });
    for (let i = 0; i < 5; i++) expect((await up()).status).toBe(200);
    expect((await up()).status).toBe(429);
  });

  it("without TRUST_PROXY_HOPS the x-forwarded-for header cannot choose the bucket", async () => {
    const { app } = build({ identity, kernelRedis: fakeRedis() });
    for (let i = 0; i < 10; i++) await signIn(app, `u${String(i)}@b.test`, `7.7.7.${String(i)}`);
    expect((await signIn(app, "z@b.test", "8.8.8.8")).status).toBe(429);
  });

  it("TRUST_PROXY_HOPS=2 takes the 2nd entry from the right; a spoofed left entry is ignored", async () => {
    const env = { NODE_ENV: "test", CORS_ORIGINS: [], TRUST_PROXY_HOPS: 2 } as const;
    const { app } = build({ identity, kernelRedis: fakeRedis(), env });
    const go = (xff: string, email: string) =>
      app.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff },
        body: JSON.stringify({ email, password: "irrelevant-password" }),
      });
    // attacker rotates the leftmost entry; the trusted client entry (2nd from right) stays 5.5.5.5
    for (let i = 0; i < 10; i++)
      expect(
        (await go(`9.9.9.${String(i)}, 5.5.5.5, 10.0.0.1`, `e${String(i)}@b.test`)).status,
      ).toBe(200);
    expect((await go("1.2.3.4, 5.5.5.5, 10.0.0.1", "last@b.test")).status).toBe(429);
    // fewer entries than hops: header ignored, falls back to the peer ("unknown" bucket here)
    expect((await go("7.7.7.7", "short@b.test")).status).toBe(200);
  });

  it("passes the trusted IP to the identity handler and strips a client-sent one", async () => {
    const seen: string[] = [];
    const spy = {
      handler: vi.fn((req: Request) => {
        seen.push(req.headers.get("x-wb-client-ip") ?? "none");
        return Promise.resolve(new Response("{}"));
      }),
    };
    const env = { NODE_ENV: "test", CORS_ORIGINS: [], TRUST_PROXY_HOPS: 1 } as const;
    const { app } = build({ identity: spy, kernelRedis: fakeRedis(), env });
    await app.request("/v1/auth/get-session", {
      headers: { "x-forwarded-for": "6.6.6.6, 4.4.4.4", "x-wb-client-ip": "1.1.1.1" },
    });
    const noProxy = build({ identity: spy, kernelRedis: fakeRedis() });
    await noProxy.app.request("/v1/auth/get-session", {
      headers: { "x-forwarded-for": "6.6.6.6", "x-wb-client-ip": "1.1.1.1" },
    });
    expect(seen).toEqual(["4.4.4.4", "none"]);
  });

  it("every other unsafe auth route is limited per session (10/min), per IP without a cookie; sign-in is not double counted", async () => {
    const redis = fakeRedis();
    const { app } = build({ identity, kernelRedis: redis });
    const call = (path: string, cookie?: string) =>
      app.request(path, {
        method: "POST",
        headers: { ...(cookie ? { cookie, origin: "https://app.test" } : {}) },
        body: "{}",
      });
    for (let i = 0; i < 10; i++)
      expect((await call("/v1/auth/change-password", `${COOKIE}=a`)).status).toBe(200);
    const res = await call("/v1/auth/change-password", `${COOKIE}=a`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect((await call("/v1/auth/revoke-sessions", `${COOKIE}=b`)).status).toBe(200); // other session
    for (let i = 0; i < 10; i++) expect((await call("/v1/auth/sign-out")).status).toBe(200);
    expect((await call("/v1/auth/sign-out")).status).toBe(429); // per-IP fallback
    expect([...redis.counts.keys()].some((k) => k.startsWith("rl:auth-write:session:"))).toBe(true);
    // GET and sign-in never hit the generic bucket
    await app.request("/v1/auth/get-session");
    await signIn(app);
    expect([...redis.counts.keys()].filter((k) => k.startsWith("rl:auth-write:"))).toHaveLength(3);
    expect([...redis.counts.keys()].filter((k) => k.startsWith("rl:auth-write-ip:"))).toHaveLength(
      1,
    );
  });

  it("varying the cookie does not escape the per-IP auth-write bucket (30/min)", async () => {
    const redis = fakeRedis();
    const { app } = build({ identity, kernelRedis: redis });
    const call = (n: number) =>
      app.request("/v1/auth/send-verification-email", {
        method: "POST",
        headers: { cookie: `${COOKIE}=junk${String(n)}`, origin: "https://app.test" },
        body: "{}",
      });
    for (let i = 0; i < 30; i++) expect((await call(i)).status).toBe(200);
    expect((await call(30)).status).toBe(429);
  });

  it("Redis down: other unsafe auth routes are 503 too", async () => {
    const { app } = build({ identity, kernelRedis: downRedis });
    const res = await app.request("/v1/auth/change-password", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  it("create-business: 6th POST per user is 429; anonymous callers are not bucketed", async () => {
    const { app } = build({ kernelRedis: fakeRedis() });
    const post = (headers: Record<string, string>) =>
      app.request("/v1/tenancy/tenants", { method: "POST", headers, body: "{}" });
    for (let i = 0; i < 5; i++) expect((await post(devHeaders())).status).toBe(404);
    const res = await post(devHeaders());
    expect(res.status).toBe(429);
    expect((await post({})).status).toBe(404);
  });

  it("Redis down: sign-in/sign-up/create-business are 503 RATE_LIMIT_UNAVAILABLE, reads stay 200", async () => {
    const fresh = { handler: vi.fn(() => Promise.resolve(new Response("{}"))) };
    const { app } = build({ identity: fresh, kernelRedis: downRedis });
    const res = await signIn(app);
    expect(res.status).toBe(503);
    expect(((await res.json()) as Problem).code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(fresh.handler).not.toHaveBeenCalled();
    const biz = await app.request("/v1/tenancy/tenants", {
      method: "POST",
      headers: devHeaders(),
      body: "{}",
    });
    expect(biz.status).toBe(503);
    const read = await app.request("/v1/probe/me", { headers: devHeaders() });
    expect(read.status).toBe(200);
  });

  it("Redis hung: 503 within the 200 ms budget", async () => {
    const { app } = build({ identity, kernelRedis: hungRedis });
    const started = Date.now();
    const res = await signIn(app);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("no Redis configured at all: 503, never an unlimited sign-in", async () => {
    const { app } = build({ identity });
    expect((await signIn(app)).status).toBe(503);
  });

  it("other auth routes and GETs never touch the limiter", async () => {
    const redis = fakeRedis();
    const { app } = build({ identity, kernelRedis: redis });
    await app.request("/v1/auth/get-session");
    await app.request("/v1/probe/me", { headers: devHeaders() });
    expect(redis.counts.size).toBe(0);
  });
});

describe("origin / CSRF guard", () => {
  const post = (
    app: ReturnType<typeof build>["app"],
    headers: Record<string, string>,
    path = "/v1/probe/validate",
  ) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "x", lines: [] }),
    });

  it("cookie POST from a foreign origin: 403 ORIGIN_REJECTED", async () => {
    const { app } = build();
    const res = await post(app, { cookie: `${COOKIE}=x`, origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ORIGIN_REJECTED");
  });

  it("cookie POST without Origin or Sec-Fetch-Site: rejected", async () => {
    expect((await post(build().app, { cookie: `${COOKIE}=x` })).status).toBe(403);
  });

  it("allowed origin, or same-origin per Sec-Fetch-Site: passes", async () => {
    const { app } = build();
    expect((await post(app, { cookie: `${COOKIE}=x`, origin: "https://app.test" })).status).toBe(
      200,
    );
    expect(
      (await post(app, { cookie: `${COOKIE}=x`, "sec-fetch-site": "same-origin" })).status,
    ).toBe(200);
    expect(
      (await post(app, { cookie: `${COOKIE}=x`, "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
  });

  it("requests without a cookie, and safe methods, are not checked", async () => {
    const { app } = build();
    expect((await post(app, { origin: "https://evil.test" })).status).toBe(200);
    const get = await app.request("/health", {
      headers: { cookie: `${COOKIE}=x`, origin: "https://evil.test" },
    });
    expect(get.status).toBe(200);
  });

  it("applies to PUT/PATCH/DELETE too", async () => {
    const { app } = build();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/v1/probe/validate", {
        method,
        headers: { cookie: `${COOKIE}=x`, origin: "https://evil.test" },
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("nodeRedisKernel", () => {
  const multiOf = (reply: unknown[]) => {
    const chain = {
      incr: vi.fn(() => chain),
      pExpire: vi.fn(() => chain),
      pTTL: vi.fn(() => chain),
      exec: vi.fn(() => Promise.resolve(reply)),
    };
    return chain;
  };
  const clientWith = (chain: ReturnType<typeof multiOf>): NodeRedisLike => ({
    get: () => Promise.resolve("v"),
    set: vi.fn(() => Promise.resolve("OK")),
    multi: () => chain,
  });

  it("hit: INCR + PEXPIRE NX + PTTL in one MULTI", async () => {
    const chain = multiOf([3, 0, 42_000]);
    const k = nodeRedisKernel(clientWith(chain));
    expect(await k.hit("rl:x", 60_000)).toEqual({ count: 3, ttlMs: 42_000 });
    expect(chain.pExpire).toHaveBeenCalledWith("rl:x", 60_000, "NX");
  });

  it("hit: a missing TTL falls back to the window; a malformed reply throws", async () => {
    expect(await nodeRedisKernel(clientWith(multiOf([1, 1, -1]))).hit("k", 5000)).toEqual({
      count: 1,
      ttlMs: 5000,
    });
    await expect(
      nodeRedisKernel(clientWith(multiOf(["x", 1, 1]))).hit("k", 5000),
    ).rejects.toThrow();
  });

  it("get/set pass through with EX", async () => {
    const set = vi.fn(() => Promise.resolve("OK"));
    const k = nodeRedisKernel({ ...clientWith(multiOf([])), set });
    expect(await k.get("a")).toBe("v");
    await k.set("a", "b", 60);
    expect(set).toHaveBeenCalledWith("a", "b", { expiration: { type: "EX", value: 60 } });
  });
});

describe("AuthContext carries the account email (invite acceptance reads it)", () => {
  const ctxWithCookie = (): Context<AppEnv> =>
    ({
      req: {
        header: (n: string) => (n === "cookie" ? `${COOKIE}=x` : undefined),
        raw: { headers: new Headers({ cookie: `${COOKIE}=x` }) },
      },
      get: () => "req-1",
    }) as never;
  const resolverFor = (emailVerified: boolean, activeTenantId: string | null) =>
    sessionResolver({
      sessions: {
        getSession: () =>
          Promise.resolve({
            sessionId: SESSION,
            userId: USER,
            email: "ana@example.com",
            emailVerified,
            activeTenantId,
          }),
      },
      memberships: { loadMembership: () => Promise.resolve(null) },
      cookieName: COOKIE,
    });

  it("a user context with a tenant copies email and emailVerified from the session", async () => {
    const auth = await resolverFor(true, TENANT)(ctxWithCookie());
    expect(auth).toMatchObject({ kind: "user", email: "ana@example.com", emailVerified: true });
  });

  it("a signed-in user without a tenant (membership missing) still carries the account fields", async () => {
    const auth = await resolverFor(false, TENANT)(ctxWithCookie());
    expect(auth).toMatchObject({
      kind: "user",
      tenantId: null,
      email: "ana@example.com",
      emailVerified: false,
    });
  });
});
