import { join } from "node:path";

import { createPool, findTablesWithoutRls, migrate } from "@wise-biz/db";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type pg from "pg";

const dir = join(import.meta.dirname, "..", "migrations");
let migrator: pg.Pool;
let worker: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [{ module: "infra", dir }]);
  migrator = createPool(db.url("migrator"));
  worker = createPool(db.url("worker"));
  drop = async () => {
    await migrator.end();
    await worker.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

describe("infra schema", () => {
  it("passes the RLS lint", async () => {
    expect(await findTablesWithoutRls(migrator, ["infra"])).toEqual([]);
  });

  it("wb_worker is not a superuser and does not bypass RLS", async () => {
    const r = await migrator.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = 'wb_worker'",
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("claim query uses outbox_unpublished_idx with 10k published + 600 unpublished rows", async () => {
    const T = "0190a000-0000-7000-8000-000000000001";
    await migrator.query("select set_config('app.tenant_id', $1, false)", [T]);
    await migrator.query(
      `insert into infra.outbox (tenant_id,id,topic,key,type,version,payload,created_at,published_at)
       select $1, uuidv7(), 't','k','t',1,'{}', now() - make_interval(secs => 20000 - g),
              case when g <= 10000 then now() end
         from generate_series(1, 10600) g`,
      [T],
    );
    await migrator.query("analyze infra.outbox");
    const c = await worker.connect();
    try {
      await c.query("begin");
      const r = await c.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
        `explain (analyze, buffers, format json)
         select tenant_id, id, topic, key, type, version, payload, headers, created_at, attempts
           from infra.outbox where published_at is null order by created_at, id limit 500
           for update skip locked`,
      );
      const plan = r.rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (!plan) throw new Error("no plan");
      const nodes = flatten(plan);
      expect(nodes.some((n) => n["Index Name"] === "outbox_unpublished_idx")).toBe(true);
      expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
