import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendOutbox, withTenantTx } from "../src/index.ts";

import { uuid7 } from "./helpers.ts";
import { ctx, event, infraSetup } from "./infra-helpers.ts";

import type pg from "pg";

let app: pg.Pool;
let worker: pg.Pool;
let drop: () => Promise<void>;
const A = uuid7();
const B = uuid7();

beforeAll(async () => {
  ({ app, worker, drop } = await infraSetup());
});
afterAll(async () => {
  await drop();
});

const count = async (): Promise<number> =>
  Number((await worker.query<{ n: string }>("select count(*) n from infra.outbox")).rows[0]?.n);

describe("appendOutbox", () => {
  it("is a no-op for an empty array", async () => {
    await withTenantTx(app, ctx(A), (tx) => appendOutbox(tx, []));
    expect(await count()).toBe(0);
  });

  it("rolls back with the transaction", async () => {
    await expect(
      withTenantTx(app, ctx(A), async (tx) => {
        await appendOutbox(tx, [event(), event()]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count()).toBe(0);
  });

  it("commits rows with the tenant from the tx context; chunks past 500", async () => {
    const evs = Array.from({ length: 1201 }, () => event({ headers: { h: "v" } }));
    await withTenantTx(app, ctx(A), (tx) => appendOutbox(tx, evs));
    const r = await worker.query<{ tenant_id: string; n: string }>(
      "select tenant_id, count(*) n from infra.outbox group by 1",
    );
    expect(r.rows).toEqual([{ tenant_id: A, n: "1201" }]);
    const row = await worker.query<{ headers: unknown; payload: unknown }>(
      "select headers, payload from infra.outbox where id = $1",
      [evs[0]?.id],
    );
    expect(row.rows[0]).toEqual({ headers: { h: "v" }, payload: { a: 1 } });
  });

  it("validates ids, version and JSON-serializability before touching the db", async () => {
    await withTenantTx(app, ctx(B), async (tx) => {
      await expect(appendOutbox(tx, [event({ id: "nope" })])).rejects.toThrow(/UUIDv7/);
      await expect(appendOutbox(tx, [event({ version: 0 })])).rejects.toThrow(/version/);
      await expect(appendOutbox(tx, [event({ payload: 1n })])).rejects.toThrow(/serializable/);
      await expect(appendOutbox(tx, [event({ payload: undefined })])).rejects.toThrow(/not JSON/);
    });
  });

  it("fails closed without a tenant context", async () => {
    const c = await app.connect();
    try {
      await c.query("begin");
      await expect(
        c.query(
          "insert into infra.outbox (tenant_id,id,topic,key,type,version,payload) values (nullif(current_setting('app.tenant_id', true), '')::uuid,$1,'t','k','t',1,'{}')",
          [uuid7()],
        ),
      ).rejects.toThrow();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("cannot insert a row for another tenant", async () => {
    await expect(
      withTenantTx(app, ctx(B), (tx) =>
        tx.query(
          "insert into infra.outbox (tenant_id,id,topic,key,type,version,payload) values ($1,$2,'t','k','t',1,'{}')",
          [A, uuid7()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("wb_app can only INSERT", async () => {
    for (const sql of [
      "select * from infra.outbox",
      "update infra.outbox set attempts = 1",
      "delete from infra.outbox",
      "truncate infra.outbox",
      "select * from infra.processed_events",
      "select * from infra.dead_letters",
    ]) {
      await expect(withTenantTx(app, ctx(A), (tx) => tx.query(sql))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("rejects oversize payload/headers, bad header names and long fields client-side", async () => {
    await withTenantTx(app, ctx(B), async (tx) => {
      const big = { s: "x".repeat(262_144) };
      await expect(appendOutbox(tx, [event({ payload: big })])).rejects.toThrow(TypeError);
      await expect(appendOutbox(tx, [event({ headers: { h: "x".repeat(9000) } })])).rejects.toThrow(
        TypeError,
      );
      for (const h of ["Upper", "tenant-id", "event-id", "a_b", "x".repeat(65)])
        await expect(appendOutbox(tx, [event({ headers: { [h]: "v" } })])).rejects.toThrow(
          TypeError,
        );
      await expect(appendOutbox(tx, [event({ topic: "t".repeat(201) })])).rejects.toThrow(
        TypeError,
      );
      await expect(appendOutbox(tx, [event({ key: "k".repeat(501) })])).rejects.toThrow(TypeError);
    });
  });

  it("DB CHECKs reject oversize rows that bypass the client", async () => {
    const ins = (col: string, v: string) =>
      withTenantTx(app, ctx(B), (tx) =>
        tx.query(
          `insert into infra.outbox (tenant_id,id,topic,key,type,version,payload,headers)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid,$1,'t','k','t',1,
                   ${col === "payload" ? "$2::jsonb" : "'{}'"}, ${col === "headers" ? "$2::jsonb" : "'{}'"})`,
          [uuid7(), v],
        ),
      );
    // random-ish content so TOAST compression cannot shrink it below the limit
    const noise = Array.from({ length: 40_000 }, (_, i) => (i * 2654435761).toString(36)).join("");
    await expect(ins("payload", JSON.stringify({ s: noise }))).rejects.toThrow(/check constraint/);
    await expect(ins("headers", JSON.stringify({ s: noise.slice(0, 20_000) }))).rejects.toThrow(
      /check constraint/,
    );
  });

  it("wb_worker may only update relay columns, may delete, never insert", async () => {
    await expect(worker.query("update infra.outbox set topic = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(worker.query("delete from infra.outbox where false")).resolves.toBeDefined();
    await expect(
      worker.query(
        "insert into infra.outbox (tenant_id,id,topic,key,type,version,payload) values ($1,$2,'t','k','t',1,'{}')",
        [A, uuid7()],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
