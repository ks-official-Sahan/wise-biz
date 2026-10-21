import { OpenAPIHono } from "@hono/zod-openapi";
import { countQueries, createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware, runCommand } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzleItemRepository } from "../src/adapters/db/item-repository.ts";
import { createItem } from "../src/application/items.ts";
import { templateModule } from "../src/index.ts";
import { CreateItemSchema } from "../src/schemas.ts";

import { auditDir, infraDir, clock, ids, migrationsDir } from "./helpers.ts";

import type { AppEnv, IdempotencyCache, ModuleDeps } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const catalog = createCatalog(templateModule.permissions);
const matrix = matrixFromRows(catalog, [{ role: "writer", permission: "template:write" }]);

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
/** In-memory stand-in for the Redis cache (real Redis is exercised in apps/api tests). */
const store = new Map<string, string>();
const redisCache: IdempotencyCache = {
  get: (k) => Promise.resolve(store.get(k) ?? null),
  set: (k, v) => {
    store.set(k, v);
    return Promise.resolve();
  },
};

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "audit", dir: auditDir },
    { module: "_template", dir: migrationsDir },
  ]);
  pool = createPool(db.url("app"), { max: 20 });
  instrumentPool(pool);
  admin = createPool(db.url("migrator"));
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await db.drop();
});

const depsWith = (cache?: IdempotencyCache): ModuleDeps => ({
  pool,
  clock,
  ids,
  ...(cache && { idempotencyCache: cache }),
});

const ACTOR = uuidv7();

function appFor(tenantId: string, role: string, deps: ModuleDeps, failAfterInsert = false) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: ACTOR, // keys are actor-scoped: one user per app
      tenantId,
      roles: [role],
      branchScope: "all",
    });
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  templateModule.routes(app, deps);
  if (failAfterInsert) {
    app.post("/boom", (c) =>
      runCommand(c, deps, {
        permission: "template:write",
        input: CreateItemSchema,
        handler: async (tx, body, ctx) => {
          await createItem(
            { repo: drizzleItemRepository, clock, ids },
            tx,
            ctx.tenant.tenantId,
            body,
          );
          throw new DomainError("CONFLICT", "after insert");
        },
      }),
    );
  }
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  return app;
}

const post = (
  app: OpenAPIHono<AppEnv>,
  body: unknown,
  key?: string,
  path = "/v1/template/items",
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    }),
  );

/** Counts run as the owner role inside a tenant tx: FORCE RLS still applies to owners. */
async function counts(tenantId: string) {
  return withTenantTx(admin, { tenantId, requestId: "test" }, async (tx) => {
    const one = async (table: string): Promise<number> =>
      Number((await tx.query<{ n: string }>(`select count(*) n from ${table}`)).rows[0]?.n);
    return {
      items: await one("template.items"),
      audit: await one("audit.audit_log"),
      outbox: await one("infra.outbox"),
      keys: await one("infra.idempotency_keys"),
    };
  });
}

describe.each([
  ["with cache", () => redisCache],
  ["without cache", () => undefined],
])("create via runCommand (%s)", (_n, cache) => {
  it("duplicate key + same body replays; one item/audit/outbox row", async () => {
    const t = uuidv7();
    const app = appFor(t, "writer", depsWith(cache()));
    const key = `k-${uuidv7()}`;
    const a = await post(app, { name: "Mug", children: ["x"] }, key);
    const b = await post(app, { children: ["x"], name: "Mug" }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    expect(a.headers.get("idempotency-replayed")).toBeNull();
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(await counts(t)).toEqual({ items: 1, audit: 1, outbox: 1, keys: 1 });
    const ev = await withTenantTx(admin, { tenantId: t, requestId: "test" }, (tx) =>
      tx.query<{ type: string; version: number }>("select type, version from infra.outbox"),
    );
    expect(ev.rows[0]).toEqual({ type: "template.item.created", version: 1 });
  });

  it("same key + different body -> 422 IDEMPOTENCY_MISMATCH", async () => {
    const t = uuidv7();
    const app = appFor(t, "writer", depsWith(cache()));
    const key = `k-${uuidv7()}`;
    await post(app, { name: "A" }, key);
    const res = await post(app, { name: "B" }, key);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("IDEMPOTENCY_MISMATCH");
    expect((await counts(t)).items).toBe(1);
  });

  it("10 parallel identical requests -> one row, identical responses", async () => {
    const t = uuidv7();
    const app = appFor(t, "writer", depsWith(cache()));
    const key = `k-${uuidv7()}`;
    const res = await Promise.all(Array.from({ length: 10 }, () => post(app, { name: "P" }, key)));
    const bodies = await Promise.all(res.map((r) => r.json()));
    expect(res.every((r) => r.status === 201)).toBe(true);
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(await counts(t)).toEqual({ items: 1, audit: 1, outbox: 1, keys: 1 });
  });
});

describe("create via runCommand", () => {
  it("missing or malformed key -> 422, nothing written", async () => {
    const t = uuidv7();
    const app = appFor(t, "writer", depsWith());
    expect((await post(app, { name: "A" })).status).toBe(422);
    expect((await post(app, { name: "A" }, "short")).status).toBe(422);
    expect((await counts(t)).items).toBe(0);
  });

  it("handler throwing after the insert leaves zero item, audit, outbox, key rows", async () => {
    const t = uuidv7();
    const app = appFor(t, "writer", depsWith(redisCache), true);
    const key = `k-${uuidv7()}`;
    const res = await post(app, { name: "Z" }, key, "/boom");
    expect(res.status).toBe(409);
    expect(await counts(t)).toEqual({ items: 0, audit: 0, outbox: 0, keys: 0 });
    expect(store.has(`idem:${t}:${key}`)).toBe(false);
  });

  it("Redis down: cache errors are skipped, result still correct and idempotent", async () => {
    const t = uuidv7();
    const broken: IdempotencyCache = {
      get: () => Promise.reject(new Error("redis down")),
      set: () => Promise.reject(new Error("redis down")),
    };
    const app = appFor(t, "writer", depsWith(broken));
    const key = `k-${uuidv7()}`;
    const a = await post(app, { name: "R" }, key);
    const b = await post(app, { name: "R" }, key);
    expect(a.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect((await counts(t)).items).toBe(1);
  });

  it("authorize runs before validation: no permission + invalid body -> 404", async () => {
    const t = uuidv7();
    const app = appFor(t, "cashier", depsWith(redisCache));
    const res = await post(app, { name: 42 }, `k-${uuidv7()}`);
    expect(res.status).toBe(404);
    expect((await counts(t)).items).toBe(0);
  });

  it("statement count for one create (housekeeping excluded)", async () => {
    const t = uuidv7();
    const app = appFor(t, "writer", depsWith());
    const { result, count, statements } = await countQueries(() =>
      post(app, { name: "Q", children: ["a", "b"] }, `k-${uuidv7()}`),
    );
    expect(result.status).toBe(201);
    // lock key, item insert, children insert, audit insert, outbox insert, save response
    expect(count).toBe(7);
    console.info(
      `create statements: ${String(count)}`,
      statements.map((s) => s.slice(0, 40)),
    );
  });
});
