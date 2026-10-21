import { trace } from "@opentelemetry/api";
import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.ts";

import { baseEnv, build, capture, devHeaders, okRedis, probeModule } from "./helpers.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const PROBLEM = "application/problem+json";
interface Problem {
  code: string;
  status: number;
  details?: unknown;
  [k: string]: unknown;
}

const unknownEnv = { ...baseEnv, API_DEV_AUTH: true, NODE_ENV: "staging" as never };

describe("NODE_ENV is never inferred from absence", () => {
  it("dev auth is ignored unless NODE_ENV is exactly development or test", async () => {
    const res = await build({ env: unknownEnv }).app.request("/v1/probe/me", {
      headers: devHeaders(),
    });
    expect(res.status).toBe(401);
    for (const NODE_ENV of ["development", "test"] as const) {
      const ok = await build({ env: { ...baseEnv, API_DEV_AUTH: true, NODE_ENV } }).app.request(
        "/v1/probe/me",
        { headers: devHeaders() },
      );
      expect(ok.status).toBe(200);
    }
  });

  it("/openapi.json is 404 for an unknown or missing NODE_ENV", async () => {
    expect((await build({ env: unknownEnv }).app.request("/openapi.json")).status).toBe(404);
    const missing = { ...baseEnv, NODE_ENV: undefined as never };
    expect((await build({ env: missing }).app.request("/openapi.json")).status).toBe(404);
  });

  it("devOnly modules are not mounted for an unknown NODE_ENV", async () => {
    const { app } = build({ modules: [probeModule({ devOnly: true })], env: unknownEnv });
    expect((await app.request("/v1/probe/domain")).status).toBe(404);
  });
});

describe("HTTPException mapping", () => {
  const mod = defineModule({
    name: "httpx",
    migrationsDir: "/tmp/httpx/migrations",
    permissions: definePermissions("httpx", ["read"]),
    events: [],
    routes(app: OpenAPIHono<AppEnv>) {
      app.get("/v1/httpx/:status", (c) => {
        throw new HTTPException(Number(c.req.param("status")) as 400, { message: "inner secret" });
      });
    },
  });
  const cases: [number, number, string][] = [
    [401, 401, "UNAUTHENTICATED"],
    [404, 404, "NOT_FOUND"],
    [405, 404, "NOT_FOUND"],
    [413, 413, "PAYLOAD_TOO_LARGE"],
    [415, 422, "VALIDATION_FAILED"],
    [400, 422, "VALIDATION_FAILED"],
    [409, 422, "VALIDATION_FAILED"],
    [500, 500, "INTERNAL"],
    [503, 500, "INTERNAL"],
  ];
  it.each(cases)("HTTPException %i -> %i %s", async (thrown, status, code) => {
    const { app } = build({ modules: [mod] });
    const res = await app.request(`/v1/httpx/${String(thrown)}`);
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain(PROBLEM);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("inner secret");
  });
});

describe("logger redaction", () => {
  const log = (obj: object): string => {
    const { stream, logs } = capture();
    createLogger("info", stream).info(obj, "x");
    return logs.raw();
  };
  const secret = "S3CR3T-VALUE";

  it.each([
    ["req.headers x-api-key", { req: { headers: { "x-api-key": secret } } }],
    ["headers set-cookie", { headers: { "set-cookie": secret } }],
    ["res.headers set-cookie", { res: { headers: { "set-cookie": secret } } }],
    ["deep set-cookie", { a: { "set-cookie": secret } }],
    ["req.headers authorization", { req: { headers: { authorization: secret } } }],
    ["token", { token: secret }],
    ["accessToken", { accessToken: secret }],
    ["refreshToken", { refreshToken: secret }],
    ["apiKey", { apiKey: secret }],
    ["session", { session: secret }],
    ["otp", { otp: secret }],
    ["nested token", { body: { token: secret } }],
    ["nested two levels", { a: { b: { refreshToken: secret } } }],
    ["password", { user: { password: secret } }],
  ])("redacts %s", (_n, obj) => {
    const out = log(obj);
    expect(out).not.toContain(secret);
    expect(out).toContain("[Redacted]");
  });

  it("err serializer keeps type/message/stack/code and drops pg detail/where/parameters", () => {
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      detail: "Key (email)=(a@b.c) exists",
      where: "WHERE-LEAK",
      parameters: ["PARAM-LEAK"],
    });
    const out = log({ err });
    const line = JSON.parse(out) as { err: Record<string, unknown> };
    expect(line.err).toMatchObject({ type: "Error", message: "duplicate key", code: "23505" });
    expect(typeof line.err.stack).toBe("string");
    for (const leak of ["a@b.c", "WHERE-LEAK", "PARAM-LEAK"]) expect(out).not.toContain(leak);
  });
});

describe("/ready probes", () => {
  it("100 concurrent /ready share at most one db probe; result cached for 1 s", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const ping = vi.fn(() => Promise.resolve("PONG"));
    const { app } = build({ pool: { query } as unknown as pg.Pool, redis: { ping } });
    const res = await Promise.all(Array.from({ length: 100 }, async () => app.request("/ready")));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
    await app.request("/ready");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("db probe carries a pg query_timeout", async () => {
    const query = vi.fn<(q: unknown) => Promise<{ rows: never[] }>>(() =>
      Promise.resolve({ rows: [] }),
    );
    const { app } = build({ pool: { query } as unknown as pg.Pool, redis: okRedis });
    await app.request("/ready");
    expect(query.mock.calls[0]?.[0]).toEqual({ text: "select 1", query_timeout: 1000 });
  });

  it("re-probes after the cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const query = vi.fn(() => Promise.resolve({ rows: [] }));
      const { app } = build({ pool: { query } as unknown as pg.Pool, redis: okRedis });
      await app.request("/ready");
      vi.setSystemTime(Date.now() + 1500);
      await app.request("/ready");
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cors vs body limit", () => {
  it("413 carries CORS headers for an allowed origin", async () => {
    const res = await build({ bodyLimitBytes: 8 }).app.request("/v1/probe/validate", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.test" },
      body: "x".repeat(100),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("tracing", () => {
  interface Rec {
    exceptions: unknown[];
    status?: { code: number };
  }
  const recs: Rec[] = [];
  const fakeSpan = (rec: Rec) => ({
    recordException: (e: unknown) => rec.exceptions.push(e),
    setStatus: (s: { code: number }) => (rec.status = s),
    updateName: () => undefined,
    setAttributes: () => undefined,
    setAttribute: () => undefined,
    end: () => undefined,
  });
  const provider = {
    getTracer: () => ({
      startSpan: () => fakeSpan({ exceptions: [] }),
      startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => {
        const rec: Rec = { exceptions: [] };
        recs.push(rec);
        return fn(fakeSpan(rec));
      },
    }),
  };
  afterEach(() => {
    recs.length = 0;
    trace.disable();
  });

  it("records handled errors and sets ERROR status for 5xx", async () => {
    trace.setGlobalTracerProvider(provider as never);
    const res = await build().app.request("/v1/probe/crash");
    expect(res.status).toBe(500);
    expect(recs[0]?.exceptions).toHaveLength(1);
    expect(recs[0]?.status?.code).toBe(2);
  });

  it("does not set ERROR for 4xx", async () => {
    trace.setGlobalTracerProvider(provider as never);
    await build().app.request("/nope");
    expect(recs[0]?.status).toBeUndefined();
  });
});

describe("authorize details never reach the response", () => {
  it("404 body has no details/permission/reason", async () => {
    const { app } = build({ env: { ...baseEnv, API_DEV_AUTH: true } });
    const res = await app.request("/v1/probe/guarded", {
      headers: devHeaders({ "x-wb-dev-roles": "cashier" }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text) as object)).not.toContain("details");
    for (const leak of ["probe:write", "not_granted", "reason", "override", "approver"]) {
      expect(text).not.toContain(leak);
    }
  });
});
