import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findTablesWithoutRls,
  lockIdempotencyKey,
  pruneIdempotencyKeys,
  saveIdempotencyResponse,
  withTenantTx,
} from "../src/index.ts";

import { uuid7 } from "./helpers.ts";
import { ctx, infraSetup } from "./infra-helpers.ts";

import type { StoredResponse } from "../src/index.ts";
import type pg from "pg";

let app: pg.Pool;
let worker: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;
const A = uuid7();
const B = uuid7();

beforeAll(async () => {
  ({ app, worker, migrator, drop } = await infraSetup());
});
afterAll(async () => {
  await drop();
});

const response: StoredResponse = {
  status: 201,
  // Deliberately non-canonical key order + spacing: the replay must return these exact bytes.
  bodyText: '{"n":[1, 2],"id":"x"}',
  headers: { etag: "v1" },
};
const stored = async (): Promise<number> =>
  Number(
    (await worker.query<{ n: string }>("select count(*) n from infra.idempotency_keys")).rows[0]?.n,
  );
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("idempotency keys", () => {
  it("new -> save -> replay returns the stored response; different hash -> mismatch", async () => {
    const key = "key-replay-0001";
    const first = await withTenantTx(app, ctx(A), async (tx) => {
      const lock = await lockIdempotencyKey(tx, { key, requestHash: "h1" });
      await saveIdempotencyResponse(tx, { key, requestHash: "h1", response, ttlMs: 60_000 });
      return lock;
    });
    expect(first).toEqual({ state: "new" });
    expect(
      await withTenantTx(app, ctx(A), (tx) => lockIdempotencyKey(tx, { key, requestHash: "h1" })),
    ).toEqual({ state: "replay", response });
    expect(
      await withTenantTx(app, ctx(A), (tx) => lockIdempotencyKey(tx, { key, requestHash: "h2" })),
    ).toEqual({ state: "mismatch" });
    // tenants are isolated: same key, other tenant, is new
    expect(
      await withTenantTx(app, ctx(B), (tx) => lockIdempotencyKey(tx, { key, requestHash: "h1" })),
    ).toEqual({ state: "new" });
  });

  it("rollback leaves no key", async () => {
    const before = await stored();
    await expect(
      withTenantTx(app, ctx(A), async (tx) => {
        await lockIdempotencyKey(tx, { key: "key-rollback-01", requestHash: "h" });
        await saveIdempotencyResponse(tx, {
          key: "key-rollback-01",
          requestHash: "h",
          response,
          ttlMs: 60_000,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await stored()).toBe(before);
    expect(
      await withTenantTx(app, ctx(A), (tx) =>
        lockIdempotencyKey(tx, { key: "key-rollback-01", requestHash: "h" }),
      ),
    ).toEqual({ state: "new" });
  });

  it("concurrent duplicate waits for the first tx and then sees a replay", async () => {
    const key = "key-concurrent-1";
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => {
      locked = r;
    });
    const first = withTenantTx(app, ctx(A), async (tx) => {
      const l = await lockIdempotencyKey(tx, { key, requestHash: "h" });
      locked();
      await gate;
      await saveIdempotencyResponse(tx, { key, requestHash: "h", response, ttlMs: 60_000 });
      return l;
    });
    await hasLock;
    let secondDone = false;
    const second = withTenantTx(app, ctx(A), (tx) =>
      lockIdempotencyKey(tx, { key, requestHash: "h" }),
    ).then((r) => {
      secondDone = true;
      return r;
    });
    await sleep(300);
    expect(secondDone).toBe(false); // blocked on the advisory lock
    release();
    expect(await first).toEqual({ state: "new" });
    expect(await second).toEqual({ state: "replay", response });
  });

  it("concurrent duplicate after a rolled-back first runs as new", async () => {
    const key = "key-concurrent-2";
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => {
      locked = r;
    });
    const first = withTenantTx(app, ctx(A), async (tx) => {
      await lockIdempotencyKey(tx, { key, requestHash: "h" });
      locked();
      await gate;
      throw new Error("fail");
    });
    const firstSettled = first.catch(() => undefined);
    await hasLock;
    const second = withTenantTx(app, ctx(A), (tx) =>
      lockIdempotencyKey(tx, { key, requestHash: "h" }),
    );
    await sleep(100);
    release();
    await firstSettled;
    expect(await second).toEqual({ state: "new" });
  });

  it("expired keys count as absent and can be re-saved; the worker prunes them", async () => {
    const key = "key-expired-001";
    await withTenantTx(app, ctx(A), async (tx) => {
      await lockIdempotencyKey(tx, { key, requestHash: "old" });
      await saveIdempotencyResponse(tx, { key, requestHash: "old", response, ttlMs: 1 });
    });
    await sleep(30);
    const fresh: StoredResponse = { status: 200, bodyText: "null", headers: {} };
    await withTenantTx(app, ctx(A), async (tx) => {
      expect(await lockIdempotencyKey(tx, { key, requestHash: "new" })).toEqual({ state: "new" });
      await saveIdempotencyResponse(tx, {
        key,
        requestHash: "new",
        response: fresh,
        ttlMs: 60_000,
      });
    });
    expect(
      await withTenantTx(app, ctx(A), (tx) => lockIdempotencyKey(tx, { key, requestHash: "new" })),
    ).toEqual({ state: "replay", response: fresh });

    // a second expired key, pruned in a batch by the worker role
    await withTenantTx(app, ctx(B), (tx) =>
      saveIdempotencyResponse(tx, { key: "key-expired-002", requestHash: "h", response, ttlMs: 1 }),
    );
    await sleep(30);
    const before = await stored();
    expect(await pruneIdempotencyKeys(worker, { batch: 1 })).toBe(1);
    expect(await pruneIdempotencyKeys(worker, { batch: 100 })).toBe(0);
    expect(await stored()).toBe(before - 1);
  });

  it("a live key cannot be overwritten, and bad input is rejected before the db", async () => {
    const key = "key-live-000001";
    await withTenantTx(app, ctx(A), (tx) =>
      saveIdempotencyResponse(tx, { key, requestHash: "h", response, ttlMs: 60_000 }),
    );
    await expect(
      withTenantTx(app, ctx(A), (tx) =>
        saveIdempotencyResponse(tx, { key, requestHash: "h2", response, ttlMs: 60_000 }),
      ),
    ).rejects.toThrow(/already stored/);
    await withTenantTx(app, ctx(A), async (tx) => {
      await expect(lockIdempotencyKey(tx, { key: "short", requestHash: "h" })).rejects.toThrow(
        /8-255/,
      );
      await expect(
        saveIdempotencyResponse(tx, { key, requestHash: "h", response, ttlMs: 0 }),
      ).rejects.toThrow(/ttlMs/);
      await expect(
        saveIdempotencyResponse(tx, {
          key,
          requestHash: "h",
          response: { ...response, status: 99 },
          ttlMs: 5,
        }),
      ).rejects.toThrow(/status/);
    });
  });

  it("wb_app cannot delete; the worker cannot insert; RLS lint passes", async () => {
    await expect(
      withTenantTx(app, ctx(A), (tx) => tx.query("delete from infra.idempotency_keys")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      worker.query(
        "insert into infra.idempotency_keys (tenant_id, key, request_hash, status, response_status, response_body, expires_at) values (gen_random_uuid(), 'workerkey-1', 'h', 'completed', 200, '{}', now())",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await findTablesWithoutRls(migrator, ["infra"])).toEqual([]);
  });
});

describe("query plans", () => {
  interface PlanNode {
    "Node Type": string;
    "Index Name"?: string;
    Plans?: PlanNode[];
  }
  const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

  it("lookup uses the primary key; prune uses the expires_at index (seeded 50k rows)", async () => {
    const seedTenant = uuid7();
    const seed = await app.connect();
    await seed.query("begin");
    await seed.query("select set_config('app.tenant_id', $1, true)", [seedTenant]);
    await seed.query(
      `insert into infra.idempotency_keys (tenant_id, key, request_hash, status, response_status, response_body, expires_at)
       select $1, 'seed-key-' || g, 'h', 'completed', 200, '{}', now() + (g - 25000 || ' seconds')::interval
       from generate_series(1, 50000) g`,
      [seedTenant],
    );
    await seed.query("commit");
    seed.release();
    await migrator.query("analyze infra.idempotency_keys");
    const run = async (sql: string, params: unknown[]): Promise<PlanNode[]> => {
      const c = await worker.connect();
      try {
        await c.query("begin");
        const text = await c.query<{ "QUERY PLAN": string }>(
          `explain (analyze, buffers) ${sql}`,
          params,
        );
        console.log(
          `\n${sql.split("\n")[0]?.slice(0, 90) ?? ""}\n${text.rows.map((r) => r["QUERY PLAN"]).join("\n")}`,
        );
        const json = await c.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
          `explain (format json) ${sql}`,
          params,
        );
        await c.query("rollback");
        const root = json.rows[0]?.["QUERY PLAN"][0]?.Plan;
        if (root === undefined) throw new Error("no plan");
        return flatten(root);
      } finally {
        c.release();
      }
    };
    const lookup = await run(
      `select request_hash, response_status, response_body, response_headers from infra.idempotency_keys
       where tenant_id = $1 and key = $2 and expires_at > now()`,
      [A, "key-replay-0001"],
    );
    expect(lookup.some((n) => n["Index Name"] === "idempotency_keys_pkey")).toBe(true);
    const prune = await run(
      `delete from infra.idempotency_keys where ctid = any(array(
         select ctid from infra.idempotency_keys where expires_at <= now() order by expires_at limit $1))`,
      [1000],
    );
    expect(prune.some((n) => n["Index Name"] === "idempotency_keys_expires_idx")).toBe(true);
    expect(prune.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });
});
