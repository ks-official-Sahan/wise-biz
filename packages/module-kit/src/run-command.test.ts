import { OpenAPIHono } from "@hono/zod-openapi";
import { DomainError, toProblem } from "@wise-biz/errors";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { policyMiddleware, requestHash, runCommand } from "./index.ts";

import type { AppEnv, IdempotencyCache, ModuleDeps } from "./index.ts";

type Lock =
  | { state: "new" }
  | {
      state: "replay";
      response: { status: number; bodyText: string; headers: Record<string, string> };
    }
  | { state: "mismatch" };

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  save: vi.fn(),
  audit: vi.fn(),
  outbox: vi.fn(),
  tx: vi.fn(),
}));

vi.mock("@wise-biz/db", () => ({
  withTenantTx: (
    _pool: unknown,
    _ctx: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => m.tx(fn) as Promise<unknown>,
  lockIdempotencyKey: m.lock,
  saveIdempotencyResponse: m.save,
  appendAudit: m.audit,
  appendOutbox: m.outbox,
}));

const T = "01900000-0000-7000-8000-000000000001";
const U = "01900000-0000-7000-8000-000000000002";
const IDEM = "idem-12345678";
const matrix = matrixFromRows(createCatalog(["t:write"]), [{ role: "w", permission: "t:write" }]);
const Body = z.object({ name: z.string().min(1) });

let cache: Map<string, string>;
let cacheImpl: IdempotencyCache;
let deps: ModuleDeps;
let handler: ReturnType<typeof vi.fn>;

function build(
  roles: string[],
  over: { idempotency?: "required" | "optional" | "off"; resource?: boolean } = {},
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: U,
      tenantId: T,
      roles,
      branchScope: over.resource ? ["other"] : "all",
    });
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  app.post("/x", (c) =>
    runCommand(c, deps, {
      permission: "t:write",
      input: Body,
      ...(over.idempotency ? { idempotency: over.idempotency } : {}),
      ...(over.resource ? { resource: () => ({ branchId: "nope" }) } : {}),
      handler: handler as never,
    }),
  );
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  return app;
}

const call = (app: OpenAPIHono<AppEnv>, body: string, key: string | null = IDEM) =>
  app.request("/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key !== null ? { "idempotency-key": key } : {}),
    },
    body,
  });

beforeEach(() => {
  vi.clearAllMocks();
  cache = new Map();
  cacheImpl = {
    get: (k) => Promise.resolve(cache.get(k) ?? null),
    set: (k, v) => {
      cache.set(k, v);
      return Promise.resolve();
    },
  };
  deps = {
    pool: {} as never,
    clock: { now: () => 0 },
    ids: { uuidv7: () => "x" },
    idempotencyCache: cacheImpl,
  };
  m.tx.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({}));
  m.lock.mockResolvedValue({ state: "new" } satisfies Lock);
  handler = vi
    .fn()
    .mockResolvedValue({ body: { ok: 1 }, audit: [{ action: "a", entity: "e" }], noEvents: true });
});

describe("runCommand", () => {
  it("authorizes before reading the body (404 not 422)", async () => {
    const res = await call(build([]), "{bad");
    expect(res.status).toBe(404);
    expect(m.tx).not.toHaveBeenCalled();
  });

  it("422 on invalid JSON, invalid body, missing or malformed key", async () => {
    const app = build(["w"]);
    expect((await call(app, "{bad")).status).toBe(422);
    expect((await call(app, "{}")).status).toBe(422);
    expect((await call(app, '{"name":"a"}', null)).status).toBe(422);
    expect((await call(app, '{"name":"a"}', "short")).status).toBe(422);
    expect(m.tx).not.toHaveBeenCalled();
  });

  it("resource check runs after validation", async () => {
    expect((await call(build(["w"], { resource: true }), '{"name":"a"}')).status).toBe(404);
  });

  it("commits handler, audit (actor filled), outbox, key and caches", async () => {
    const res = await call(build(["w"]), '{"name":"a"}');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(m.audit.mock.calls[0]?.[1]).toEqual([
      { action: "a", entity: "e", actorType: "user", actorId: U, requestId: "req-12345678" },
    ]);
    expect(m.save).toHaveBeenCalledTimes(1);
    expect(cache.has(`idem:${T}:${U}:${IDEM}`)).toBe(true);
  });

  it("empty audit is INTERNAL", async () => {
    handler.mockResolvedValue({ body: {}, audit: [], noEvents: true });
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(500);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("events must be non-empty unless noEvents is explicit", async () => {
    handler.mockResolvedValue({ body: {}, audit: [{ action: "a", entity: "e" }], events: [] });
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(500);
    handler.mockResolvedValue({ body: {}, audit: [{ action: "a", entity: "e" }] });
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(500);
    handler.mockResolvedValue({
      body: {},
      audit: [{ action: "a", entity: "e" }],
      events: [{ topic: "t" }],
      noEvents: true,
    });
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(500);
    expect(m.save).not.toHaveBeenCalled();
    handler.mockResolvedValue({
      body: {},
      audit: [{ action: "a", entity: "e" }],
      events: [{ topic: "t" }],
    });
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(201);
  });

  it("scopes the idempotency key to the actor", async () => {
    await call(build(["w"]), '{"name":"a"}');
    expect(m.lock.mock.calls[0]?.[1]).toMatchObject({ key: `${U}:${IDEM}` });
    expect([...cache.keys()]).toEqual([`idem:${T}:${U}:${IDEM}`]);
  });

  it("rejects a key whose actor-scoped form exceeds 255 chars", async () => {
    const res = await call(build(["w"]), '{"name":"a"}', "k".repeat(240));
    expect(res.status).toBe(422);
    expect(m.tx).not.toHaveBeenCalled();
  });

  it("request hash covers the query string", async () => {
    const app = build(["w"]);
    await app.request("/x?a=1", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": IDEM },
      body: '{"name":"a"}',
    });
    const res = await app.request("/x?a=2", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": IDEM },
      body: '{"name":"a"}',
    });
    expect(res.status).toBe(422);
    expect(requestHash("POST", "/x", { a: 1 }, "?a=1")).not.toBe(
      requestHash("POST", "/x", { a: 1 }, "?a=2"),
    );
  });

  it("ignores cached headers and rejects malformed cached shapes", async () => {
    const app = build(["w"]);
    const k = `idem:${T}:${U}:${IDEM}`;
    const hash = requestHash("POST", "/x", { name: "a" }, "");
    const entry = (response: unknown): string => JSON.stringify({ requestHash: hash, response });
    cache.set(
      k,
      entry({ status: 201, bodyText: '{"c":1}', headers: { "set-cookie": "evil=1", "x-a": "b" } }),
    );
    const hit = await call(app, '{"name":"a"}');
    expect(await hit.json()).toEqual({ c: 1 });
    expect(hit.headers.get("set-cookie")).toBeNull();
    expect(hit.headers.get("x-a")).toBeNull();
    expect(hit.headers.get("idempotency-replayed")).toBe("true");
    for (const bad of [
      { status: 302, bodyText: "{}" },
      { status: 201, bodyText: 5 },
      { status: 201, bodyText: "x".repeat(256 * 1024 + 1) },
    ]) {
      cache.set(k, entry(bad));
      handler.mockClear();
      const res = await call(app, '{"name":"a"}');
      expect(res.headers.get("idempotency-replayed")).toBeNull();
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it("replays from Redis (same hash) and rejects a different hash", async () => {
    const app = build(["w"]);
    await call(app, '{"name":"a"}');
    m.tx.mockClear();
    const again = await call(app, '{ "name" : "a" }');
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(m.tx).not.toHaveBeenCalled();
    const bad = await call(app, '{"name":"b"}');
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("replays and mismatches from Postgres when Redis misses", async () => {
    const app = build(["w"]);
    m.lock.mockResolvedValueOnce({
      state: "replay",
      response: { status: 201, bodyText: '{"ok":9}', headers: {} },
    } satisfies Lock);
    const r = await call(app, '{"name":"a"}');
    expect(await r.json()).toEqual({ ok: 9 });
    expect(r.headers.get("idempotency-replayed")).toBe("true");
    expect(handler).not.toHaveBeenCalled();
    m.lock.mockResolvedValueOnce({ state: "mismatch" } satisfies Lock);
    expect((await call(app, '{"name":"a"}')).status).toBe(422);
  });

  it("survives a broken or throwing cache", async () => {
    cache.set(`idem:${T}:${U}:${IDEM}`, "not json");
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(201);
    deps.idempotencyCache = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
    };
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(201);
  });

  it("optional / off modes skip the key", async () => {
    expect(
      (await call(build(["w"], { idempotency: "optional" }), '{"name":"a"}', null)).status,
    ).toBe(201);
    expect((await call(build(["w"], { idempotency: "off" }), '{"name":"a"}')).status).toBe(201);
    expect(m.lock).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it("handler error propagates", async () => {
    handler.mockRejectedValue(new DomainError("CONFLICT", "dup"));
    expect((await call(build(["w"]), '{"name":"a"}')).status).toBe(409);
  });
});

describe("requestHash", () => {
  it("ignores key order, not content", () => {
    expect(requestHash("POST", "/x", { a: 1, b: [{ c: 1, d: 2 }] })).toBe(
      requestHash("POST", "/x", { b: [{ d: 2, c: 1 }], a: 1 }),
    );
    expect(requestHash("POST", "/x", { a: 1 })).not.toBe(requestHash("POST", "/y", { a: 1 }));
    expect(requestHash("POST", "/x", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
