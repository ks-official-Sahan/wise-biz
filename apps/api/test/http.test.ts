import { describe, expect, it } from "vitest";

import { baseEnv, build, devHeaders, probeModule, TENANT, USER } from "./helpers.ts";

const PROBLEM = "application/problem+json";
interface Problem {
  code: string;
  status: number;
  detail: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

describe("health", () => {
  it("/health is 200 without deps", async () => {
    const res = await build().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("/ready is 200 when db and redis answer", async () => {
    const res = await build().app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", checks: { db: "ok", redis: "ok" } });
  });

  it("/ready is 503 without leaking details when a dependency fails or hangs", async () => {
    const failing = build({
      redis: { ping: () => Promise.reject(new Error("ECONNREFUSED 10.0.0.9")) },
    });
    const res = await failing.app.request("/ready");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      status: "unavailable",
      checks: { db: "ok", redis: "fail" },
    });
    expect(text).not.toContain("10.0.0.9");
  });
});

describe("errors", () => {
  it("unknown route -> 404 problem", async () => {
    const res = await build().app.request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
    expect(((await res.json()) as Problem).code).toBe("NOT_FOUND");
  });

  it("validation error -> 422 problem with errors[]", async () => {
    const res = await build().app.request("/v1/probe/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", lines: [{ qty: "x" }] }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.errors?.map((e) => e.path).sort()).toEqual(["lines[0].qty", "name"]);
  });

  it("malformed JSON -> 422 problem", async () => {
    const res = await build().app.request("/v1/probe/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
  });

  it("DomainError -> its status and code", async () => {
    const res = await build().app.request("/v1/probe/domain");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("CONFLICT");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("unexpected error -> 500 INTERNAL, no leak, stack logged", async () => {
    const { app, logs } = build();
    const res = await app.request("/v1/probe/crash");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect((JSON.parse(text) as Problem).code).toBe("INTERNAL");
    expect(text).not.toContain("secret internal detail");
    expect(logs.raw()).toContain("secret internal detail");
    expect(logs.raw()).toContain("stack");
  });

  it("anonymous request to a tenant route -> 401 problem", async () => {
    const res = await build().app.request("/v1/probe/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
    expect(((await res.json()) as Problem).code).toBe("UNAUTHENTICATED");
  });
});

describe("request id", () => {
  it("echoes a safe inbound id", async () => {
    const res = await build().app.request("/health", {
      headers: { "x-request-id": "abc-12345678" },
    });
    expect(res.headers.get("x-request-id")).toBe("abc-12345678");
  });

  it.each(["short", "a".repeat(129), "has space in it!!", "<script>alert(1)</script>"])(
    "replaces unsafe inbound id %#",
    async (bad) => {
      const res = await build().app.request("/health", { headers: { "x-request-id": bad } });
      const id = res.headers.get("x-request-id") ?? "";
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    },
  );

  it("problem bodies carry the same id", async () => {
    const res = await build().app.request("/nope", { headers: { "x-request-id": "abc-12345678" } });
    expect(((await res.json()) as Problem).requestId).toBe("abc-12345678");
  });
});

describe("body limit", () => {
  it("413 problem above the limit, default 1 MiB", async () => {
    const res = await build().app.request("/v1/probe/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
    expect(((await res.json()) as Problem).code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("honours a custom limit and lets small bodies through", async () => {
    const { app } = build({ bodyLimitBytes: 64 });
    const post = (body: string) =>
      app.request("/v1/probe/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await post(JSON.stringify({ name: "a", lines: [] }))).status).toBe(200);
    expect((await post(JSON.stringify({ name: "a".repeat(100), lines: [] }))).status).toBe(413);
  });
});

describe("cors", () => {
  it("allows an allowlisted origin with credentials", async () => {
    const res = await build().app.request("/health", { headers: { origin: "https://app.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("handles preflight for an allowed origin", async () => {
    const res = await build().app.request("/v1/probe/validate", {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
  });

  it("omits CORS headers for other origins and never answers *", async () => {
    const { app } = build({ env: { ...baseEnv, CORS_ORIGINS: ["*", "https://app.test"] } });
    for (const origin of ["https://evil.test", "https://app.test.evil.test"]) {
      const res = await app.request("/health", { headers: { origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("secure headers", () => {
  it("sets strict API defaults", async () => {
    const res = await build().app.request("/health");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("also applies to problem responses", async () => {
    const res = await build().app.request("/nope");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("auth resolver (test header resolver)", () => {
  const on = baseEnv;

  it("resolved identity reaches the handler", async () => {
    const res = await build({ env: on }).app.request("/v1/probe/me", { headers: devHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId: TENANT, userId: USER });
  });

  it("defaults to owner and a role without the permission gets 404 (not 403)", async () => {
    const { app } = build({ env: on });
    expect((await app.request("/v1/probe/guarded", { headers: devHeaders() })).status).toBe(200);
    const res = await app.request("/v1/probe/guarded", {
      headers: devHeaders({ "x-wb-dev-roles": "cashier" }),
    });
    expect(res.status).toBe(404);
  });

  it("branch scope header restricts to listed branches", async () => {
    const { app } = build({ env: on });
    const res = await app.request("/v1/probe/guarded", {
      headers: devHeaders({ "x-wb-dev-branches": "01900000-0000-7000-8000-0000000000b1" }),
    });
    // no branchId on the resource + restricted scope fails closed
    expect(res.status).toBe(404);
  });

  it("anonymous without credentials: 401", async () => {
    const res = await build().app.request("/v1/probe/me");
    expect(res.status).toBe(401);
  });

  it("signed in without an active tenant: requireTenant is 404 (fail closed)", async () => {
    const res = await build().app.request("/v1/probe/me", {
      headers: devHeaders({ "x-wb-dev-tenant": "none" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects malformed dev ids as anonymous", async () => {
    const res = await build({ env: on }).app.request("/v1/probe/me", {
      headers: devHeaders({ "x-wb-dev-tenant": "not-a-uuid" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("production gating", () => {
  it("serves /openapi.json outside production only", async () => {
    const dev = await build().app.request("/openapi.json");
    expect(dev.status).toBe(200);
    expect(((await dev.json()) as { paths: object }).paths).toHaveProperty("/health");
    const prod = await build({ env: { ...baseEnv, NODE_ENV: "production" } }).app.request(
      "/openapi.json",
    );
    expect(prod.status).toBe(404);
  });

  it("skips devOnly modules in production", async () => {
    const modules = [probeModule({ devOnly: true })];
    expect((await build({ modules }).app.request("/v1/probe/domain")).status).toBe(409);
    const prod = build({ modules, env: { ...baseEnv, NODE_ENV: "production" } });
    expect((await prod.app.request("/v1/probe/domain")).status).toBe(404);
  });
});

describe("logging", () => {
  it("redacts the authorization header", async () => {
    const { app, logs } = build();
    await app.request("/v1/probe/log", { headers: { authorization: "Bearer SUPERSECRET-token" } });
    expect(logs.raw()).not.toContain("SUPERSECRET-token");
    expect(logs.raw()).toContain("[Redacted]");
  });

  it("writes one access line with route template, status, ms, requestId and tenantId", async () => {
    const { app, logs } = build();
    await app.request("/v1/probe/me?secret=1", {
      headers: devHeaders({ "x-request-id": "abc-12345678" }),
    });
    const line = logs.lines().find((l) => l.msg === "request");
    expect(line).toMatchObject({
      method: "GET",
      route: "/v1/probe/me",
      status: 200,
      requestId: "abc-12345678",
      tenantId: TENANT,
    });
    expect(typeof line?.ms).toBe("number");
    expect(logs.raw()).not.toContain("secret=1");
  });
});
