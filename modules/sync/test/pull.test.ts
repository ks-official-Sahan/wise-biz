import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { OpenAPIHono } from "@hono/zod-openapi";
import { countQueries, createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { createMemoryStore } from "@wise-biz/storage";
import { parseSnapshot } from "@wise-biz/sync";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyChanges,
  bootstrap,
  changesOf,
  createSyncChangesConsumer,
  createSyncModule,
  pullChanges,
  verifyTicket,
} from "../src/index.ts";

import type { PullPorts } from "../src/index.ts";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const OTHER = uuidv7();
const BRANCH = uuidv7();
const OTHER_BRANCH = uuidv7();
const LOC = uuidv7();
const OTHER_LOC = uuidv7();
const store = createMemoryStore();
let branchLocations: string[] = [LOC];
const ports: PullPorts = {
  store,
  branchLocations: () => Promise.resolve(branchLocations),
};

let pool: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "devices", dir: dir("devices") },
    { module: "sync", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 10 });
  instrumentPool(pool);
  worker = createPool(db.url("worker"), { max: 10 });
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await worker.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});

const event = (type: string, data: Record<string, unknown>, tenantId = T) => ({
  id: uuidv7(),
  type,
  version: 1,
  tenantId,
  data,
});

/** What the workers do: a connection with the tenant set, the consumer's handle, one event at a time. */
async function consume(payload: unknown, tenantId = T, client?: pg.PoolClient) {
  const own = client ?? (await worker.connect());
  try {
    await own.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
    await createSyncChangesConsumer().handle({ payload }, { client: own });
  } finally {
    if (client === undefined) own.release();
  }
}

/**
 * The feed shows a row only below the cluster-wide oldest running transaction (ADR 0015), and test files run in
 * parallel against one Postgres: wait until this tenant's rows are visible so assertions do not depend on timing.
 */
async function settled(tenantId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await admin.query<{ n: string }>(
      "select count(*) n from sync.sync_changes where tenant_id = $1 and txid >= pg_snapshot_xmin(pg_current_snapshot())",
      [tenantId],
    );
    if (r.rows[0]?.n === "0") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("feed rows did not become visible");
}
const read = <R>(fn: Parameters<typeof withTenantTx<R>>[2], tenantId = T) =>
  withTenantTx(pool, { tenantId, requestId: "req-12345678" }, fn);
const pull = (
  dataset: "catalog" | "prices" | "tax" | "promotions" | "stock_branch",
  cursor?: string,
  limit = 500,
  branch = BRANCH,
  tenant = T,
) => read((tx) => pullChanges(tx, tenant, branch, ports, { dataset, cursor, limit }), tenant);

const variant = (id: string, name = "Tea", archived = false) =>
  event("catalog.variant.upserted", {
    productId: uuidv7(),
    variantId: id,
    name,
    sku: "S",
    archived,
  });

describe("changesOf", () => {
  it("maps each producer event to its change rows", () => {
    const v = uuidv7();
    expect(
      changesOf(
        event("catalog.barcode.changed", {
          productId: uuidv7(),
          variantId: v,
          codes: ["123"],
          added: ["123"],
          removed: [],
        }),
      ).rows,
    ).toMatchObject([
      { dataset: "catalog", entity: "barcodes", entityId: v, op: "upsert", scopeKey: "all" },
    ]);
    expect(changesOf(variant(v)).rows).toMatchObject([
      { dataset: "catalog", entity: "variant", entityId: v, op: "upsert", scopeKey: "all" },
    ]);
    expect(
      changesOf(event("catalog.variant.archived", { variantId: v, productId: uuidv7() })).rows,
    ).toMatchObject([
      { dataset: "catalog", entity: "variant", entityId: v, op: "delete", payload: null },
    ]);
    const list = uuidv7();
    expect(
      changesOf(
        event("pricing.price.changed", {
          priceListId: list,
          version: 4,
          changes: [
            { variantId: v, priceMinor: 500 },
            { variantId: "gone", priceMinor: null },
          ],
        }),
      ).rows,
    ).toMatchObject([
      { dataset: "prices", entity: "price", entityId: `${list}:${v}`, op: "upsert", version: 4 },
      { dataset: "prices", entity: "price", entityId: `${list}:gone`, op: "delete", version: 4 },
    ]);
    expect(
      changesOf(event("pricing.tax_region.upserted", { taxRegionId: "r", version: 2 })).rows[0],
    ).toMatchObject({
      dataset: "tax",
      entity: "tax_region",
      version: 2,
    });
    expect(
      changesOf(event("pricing.promotion.archived", { promotionId: "p", version: 3 })).rows[0],
    ).toMatchObject({
      dataset: "promotions",
      op: "delete",
    });
    expect(
      changesOf(
        event("inventory.movement.recorded", {
          variantId: v,
          balances: [{ locationId: LOC, batchId: null, qty: "3", reserved: "0" }],
        }),
      ).rows,
    ).toMatchObject([
      { dataset: "stock_branch", entity: "stock", entityId: `${LOC}:${v}:-`, scopeKey: LOC },
    ]);
    expect(changesOf(event("identity.user.created", {})).rows).toEqual([]);
    expect(() => changesOf(event("catalog.variant.upserted", {}))).toThrow("lacks");
    expect(() => changesOf({ nope: true })).toThrow();
  });
});

describe("pull", () => {
  it("pages 2,500 changes with no gaps or repeats, one query per page", async () => {
    const list = uuidv7();
    const variants = Array.from({ length: 2500 }, () => uuidv7());
    for (let i = 0; i < variants.length; i += 500) {
      await consume(
        event("pricing.price.changed", {
          priceListId: list,
          version: i / 500 + 1,
          changes: variants.slice(i, i + 500).map((variantId) => ({ variantId, priceMinor: 100 })),
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { result, count } = await countQueries(() => pull("prices", cursor, 300));
      expect(count).toBe(1);
      seen.push(...result.changes.map((c) => c.entityId));
      pages += 1;
      if (!result.hasMore) {
        cursor = result.nextCursor ?? undefined;
        break;
      }
      cursor = result.nextCursor ?? undefined;
    }
    expect(pages).toBe(9);
    expect(seen).toHaveLength(2500);
    expect(new Set(seen).size).toBe(2500);
    expect(new Set(seen)).toEqual(new Set(variants.map((v) => `${list}:${v}`)));
    // Up to date: nothing more, the cursor stays.
    const again = await pull("prices", cursor, 300);
    expect(again).toMatchObject({ changes: [], hasMore: false, nextCursor: cursor });
  });

  it("a late-committing writer never lands behind a cursor a device already holds", async () => {
    const slow = await worker.connect();
    await slow.query("begin");
    const early = uuidv7();
    await consume(variant(early, "slow"), T, slow); // takes the lower transaction id, stays open
    const fast = uuidv7();
    await consume(variant(fast, "fast")); // higher id, commits first
    const blocked = await pull("catalog");
    expect(blocked.changes).toEqual([]); // hidden until the older transaction finishes
    await slow.query("commit");
    slow.release();
    const after = await pull("catalog");
    expect(after.changes.map((c) => c.entityId)).toEqual([early, fast]);
    // A device that stopped after the first still gets the second.
    const first = await pull("catalog", undefined, 1);
    expect(first.changes.map((c) => c.entityId)).toEqual([early]);
    const rest = await pull("catalog", first.nextCursor ?? undefined, 10);
    expect(rest.changes.map((c) => c.entityId)).toEqual([fast]);
  });

  it("stock is scoped to the locations of the terminal's branch; other tenants see nothing", async () => {
    const v = uuidv7();
    await consume(
      event("inventory.movement.recorded", {
        variantId: v,
        balances: [
          { locationId: LOC, batchId: null, qty: "5", reserved: "0" },
          { locationId: OTHER_LOC, batchId: null, qty: "9", reserved: "0" },
        ],
      }),
    );
    const mine = await pull("stock_branch");
    expect(mine.changes.map((c) => c.entityId)).toEqual([`${LOC}:${v}:-`]);
    branchLocations = [];
    expect((await pull("stock_branch", undefined, 500, OTHER_BRANCH)).changes).toEqual([]);
    branchLocations = [LOC];
    expect((await pull("catalog", undefined, 500, BRANCH, OTHER)).changes).toEqual([]);
  });

  it("the consumer writes under the worker role with the tenant's policy (no row for another tenant)", async () => {
    const client = await worker.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [OTHER]);
      await expect(
        applyChanges(client, event("catalog.variant.archived", { variantId: uuidv7() }, T)),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});

describe("bootstrap", () => {
  it("builds a gzip NDJSON snapshot consistent with its cursor, reuses it, and continues with pull", async () => {
    const a = uuidv7();
    const b = uuidv7();
    const gone = uuidv7();
    await consume(
      event("pricing.promotion.published", { promotionId: a, version: 1, name: "old" }),
    );
    await consume(
      event("pricing.promotion.published", { promotionId: a, version: 2, name: "new" }),
    );
    await consume(event("pricing.promotion.published", { promotionId: b, version: 1, name: "b" }));
    await consume(
      event("pricing.promotion.published", { promotionId: gone, version: 1, name: "x" }),
    );
    await consume(event("pricing.promotion.archived", { promotionId: gone, version: 2 }));
    await settled(T);
    const now = new Date();
    const boot = await read((tx) => bootstrap(tx, T, BRANCH, ports, "promotions", now));
    expect(boot.entityCount).toBe(2);
    expect(boot.url).not.toBeNull();
    expect(boot.cursor).not.toBeNull();
    const key = (
      await admin.query<{ object_key: string }>(
        "select object_key from sync.snapshots where tenant_id = $1 and dataset = 'promotions'",
        [T],
      )
    ).rows[0]?.object_key;
    const stream = await store.get(key ?? "");
    const lines = gunzipSync(Buffer.from(await new Response(stream).arrayBuffer()))
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ dataset: "promotions", scope: "all", cursor: boot.cursor });
    // The device client reads exactly this format.
    const parsed = parseSnapshot(
      gunzipSync(
        Buffer.from(await new Response(await store.get(key ?? "")).arrayBuffer()),
      ).toString(),
    );
    expect(parsed.cursor).toBe(boot.cursor);
    expect(parsed.rows).toHaveLength(lines.length - 1);
    const states = Object.fromEntries(
      lines.slice(1).map((l) => [l.id as string, (l.payload as { name: string }).name]),
    );
    expect(states).toEqual({ [a]: "new", [b]: "b" });
    // Reused while fresh: the same snapshot, no rebuild.
    const again = await read((tx) =>
      bootstrap(tx, T, BRANCH, ports, "promotions", new Date(now.getTime() + 60_000)),
    );
    expect(again.builtAt).toBe(boot.builtAt);
    // A change after the snapshot arrives through pull from the snapshot's cursor, and only that one.
    const c = uuidv7();
    await consume(event("pricing.promotion.published", { promotionId: c, version: 1, name: "c" }));
    await settled(T);
    const next = await pull("promotions", boot.cursor ?? undefined);
    expect(next.changes.map((x) => x.entityId)).toEqual([c]);
    // Stale: rebuilt, now including c.
    const rebuilt = await read((tx) =>
      bootstrap(tx, T, BRANCH, ports, "promotions", new Date(now.getTime() + 7 * 3_600_000)),
    );
    expect(rebuilt.entityCount).toBe(3);
    expect(rebuilt.cursor).not.toBe(boot.cursor);
  });

  it("an empty dataset bootstraps to a header-only snapshot", async () => {
    const boot = await read((tx) => bootstrap(tx, T, BRANCH, ports, "tax", new Date()));
    expect(boot).toMatchObject({ entityCount: 0, cursor: null });
  });
});

describe("GET /v1/sync/changes and /bootstrap", () => {
  let app: OpenAPIHono<AppEnv>;
  beforeAll(() => {
    app = new OpenAPIHono<AppEnv>({
      defaultHook: (r) => {
        if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
      },
    });
    app.use("*", async (c, next) => {
      c.set("requestId", "req-12345678");
      c.set("device", { deviceId: uuidv7(), tenantId: T, branchId: BRANCH, status: "active" });
      await next();
    });
    app.onError((err, c) => {
      const p = toProblem(err, "r");
      return c.json(p, p.status as 409);
    });
    createSyncModule(
      {
        handlers: {} as never,
        deviceKey: () => Promise.resolve(undefined),
        quarantine: () => Promise.resolve(),
        ...ports,
      },
      { snapshotMaxAgeMs: 3_600_000 },
    ).routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
  });

  it("serves a page with an ETag and 304s a repeat that finds nothing new", async () => {
    const res = await app.request("/v1/sync/changes?dataset=catalog&limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: unknown[]; nextCursor: string; hasMore: boolean };
    expect(body.changes).toHaveLength(1);
    expect(body.hasMore).toBe(true);
    expect(res.headers.get("etag")).toMatch(/^W\/"catalog:/);
    // Drain to the end, then ask again with the tail's ETag.
    let cursor = body.nextCursor;
    let last: Response | undefined;
    for (let i = 0; i < 10; i++) {
      last = await app.request(`/v1/sync/changes?dataset=catalog&cursor=${cursor}&limit=500`);
      const j = (await last.json()) as { nextCursor: string; hasMore: boolean };
      cursor = j.nextCursor;
      if (!j.hasMore) break;
    }
    const etag = last?.headers.get("etag") ?? "";
    const idle = await app.request(`/v1/sync/changes?dataset=catalog&cursor=${cursor}`, {
      headers: { "if-none-match": etag },
    });
    expect(idle.status).toBe(304);
  });

  it("rejects an unknown dataset and a forged cursor", async () => {
    expect((await app.request("/v1/sync/changes?dataset=secrets")).status).toBe(422);
    expect((await app.request("/v1/sync/changes?dataset=catalog&cursor=AAAA")).status).toBe(422);
    expect((await app.request("/v1/sync/changes?dataset=catalog&limit=5000")).status).toBe(422);
  });

  it("bootstrap answers with a URL and the cursor", async () => {
    const res = await app.request("/v1/sync/bootstrap?dataset=catalog");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataset: "catalog", entityCount: 2 });
  });
});

describe("realtime hints", () => {
  const SECRET = "s".repeat(32);

  it("the consumer announces each touched channel once, and a failing notify never fails the handler", async () => {
    const notices: { channel: string; dataset: string }[] = [];
    const client = await worker.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [T]);
      const consumer = createSyncChangesConsumer((n) => notices.push(n));
      await consumer.handle({ payload: variant(uuidv7()) }, { client });
      await consumer.handle({ payload: variant(uuidv7()) }, { client });
      const boom = createSyncChangesConsumer(() => {
        throw new Error("redis down");
      });
      await expect(
        boom.handle({ payload: variant(uuidv7()) }, { client }),
      ).resolves.toBeUndefined();
      // An event with no rows announces nothing.
      await consumer.handle({ payload: event("inventory.unrelated", {}) }, { client });
    } finally {
      client.release();
    }
    expect(notices.map((n) => n.channel)).toEqual(["all:catalog", "all:catalog"]);
  });

  it("POST /v1/sync/stream-ticket lists the branch's channels and verifies with the shared secret", async () => {
    const app = new OpenAPIHono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "req-12345678");
      c.set("device", { deviceId: uuidv7(), tenantId: T, branchId: BRANCH, status: "active" });
      await next();
    });
    createSyncModule(
      {
        handlers: {} as never,
        deviceKey: () => Promise.resolve(undefined),
        quarantine: () => Promise.resolve(),
        ...ports,
      },
      {},
      { secret: SECRET, url: "https://rt.example.test", ttlSeconds: 60 },
    ).routes(app, { pool, clock: { now: () => 1_000_000 }, ids: { uuidv7 } });
    const res = await app.request("/v1/sync/stream-ticket", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      url: string;
      expiresInSeconds: number;
      channels: string[];
    };
    expect(body).toMatchObject({ url: "https://rt.example.test", expiresInSeconds: 60 });
    expect(body.channels).toEqual([
      "all:catalog",
      "all:prices",
      "all:tax",
      "all:promotions",
      `l:${LOC}:stock_branch`,
    ]);
    expect(verifyTicket(SECRET, body.token, 1_000_000)).toMatchObject({
      tid: T,
      ch: body.channels,
      exp: 1060,
    });
    expect(verifyTicket(SECRET, body.token, 1_060_000)).toBeUndefined();
  });
});
