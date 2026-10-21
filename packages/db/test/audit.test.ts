import { merkleRoot } from "@wise-biz/audit-chain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendAudit,
  buildDailyAnchor,
  chainTenant,
  ensureAuditPartitions,
  findTablesWithoutRls,
  listTenantsWithUnchained,
  loadChain,
  verifyTenantChain,
  withTenantTx,
} from "../src/index.ts";

import { auditSetup, entry } from "./audit-helpers.ts";
import { uuid7 } from "./helpers.ts";
import { ctx } from "./infra-helpers.ts";

import type pg from "pg";

let app: pg.Pool;
let chainer: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ app, chainer, admin, drop } = await auditSetup());
});
afterAll(async () => {
  await drop();
});

const put = (tenant: string, n: number): Promise<void> =>
  withTenantTx(app, ctx(tenant), (tx) =>
    appendAudit(
      tx,
      Array.from({ length: n }, () => entry()),
    ),
  );
const count = async (tenant: string, where = "true"): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>(
        `select count(*) n from audit.audit_log where tenant_id = $1 and ${where}`,
        [tenant],
      )
    ).rows[0]?.n,
  );
const sqlState = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const INSUFFICIENT = "42501";

describe("appendAudit", () => {
  const T = uuid7();

  it("is a no-op for none and rolls back with the transaction", async () => {
    await withTenantTx(app, ctx(T), (tx) => appendAudit(tx, []));
    await expect(
      withTenantTx(app, ctx(T), async (tx) => {
        await appendAudit(tx, [entry(), entry()]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count(T)).toBe(0);
  });

  it("inserts unchained rows for the tx tenant (chunks past 500)", async () => {
    await put(T, 1201);
    expect(await count(T, "hash is null and chain_seq is null and prev_hash is null")).toBe(1201);
  });

  it("validates client-side", async () => {
    await withTenantTx(app, ctx(T), async (tx) => {
      await expect(appendAudit(tx, [entry({ actorType: "bot" as never })])).rejects.toThrow(
        /actorType/,
      );
      await expect(appendAudit(tx, [entry({ action: " " })])).rejects.toThrow(/action/);
      await expect(appendAudit(tx, [entry({ reason: "x".repeat(1001) })])).rejects.toThrow(
        /reason/,
      );
      await expect(appendAudit(tx, [entry({ before: { a: "x".repeat(70_000) } })])).rejects.toThrow(
        /64 KiB/,
      );
      await expect(appendAudit(tx, [entry({ after: 1n })])).rejects.toThrow(/serializable/);
    });
  });

  it("fails closed without a tenant", async () => {
    const c = await app.connect();
    try {
      await expect(
        appendAudit({ db: undefined as never, query: (s, p) => c.query(s, p) }, [entry()]),
      ).rejects.toThrow();
    } finally {
      c.release();
    }
  });
});

describe("privileges and trigger", () => {
  const T = uuid7();
  beforeAll(async () => {
    await put(T, 2);
    await chainTenant(chainer, T, { batch: 1 }); // one chained, one unchained
    await put(T, 1);
  });

  it("wb_app cannot SELECT / UPDATE / DELETE / TRUNCATE", async () => {
    for (const sql of [
      "select * from audit.audit_log",
      "update audit.audit_log set action = 'x'",
      "delete from audit.audit_log",
      "truncate audit.audit_log",
      "select * from audit.chain_heads",
      "insert into audit.anchors (tenant_id, day, chain_seq_from, chain_seq_to, row_count, merkle_root, head_hash) values (gen_random_uuid(), now(), 1, 1, 1, repeat('a',64), repeat('a',64))",
    ]) {
      expect(await sqlState(withTenantTx(app, ctx(T), (tx) => tx.query(sql)))).toBe(INSUFFICIENT);
    }
  });

  it("wb_app cannot insert for another tenant (RLS) or call ensure_partitions", async () => {
    const other = uuid7();
    const code = await sqlState(
      withTenantTx(app, ctx(T), (tx) =>
        tx.query(
          `insert into audit.audit_log (tenant_id, actor_type, actor_id, action, entity, request_id) values ($1, 'user', 'u', 'a', 'e', 'r')`,
          [other],
        ),
      ),
    );
    expect(code).toBe("42501");
    expect(await sqlState(app.query("select audit.ensure_partitions(1)"))).toBe(INSUFFICIENT);
  });

  it("chainer cannot change non-hash columns, rehash a chained row, or delete", async () => {
    expect(await sqlState(chainer.query("update audit.audit_log set action = 'x'"))).toBe(
      INSUFFICIENT,
    );
    expect(await sqlState(chainer.query("delete from audit.audit_log"))).toBe(INSUFFICIENT);
    expect(await sqlState(chainer.query("truncate audit.audit_log"))).toBe(INSUFFICIENT);
    // Column grant allows hash columns; the trigger rejects re-chaining and half-chaining.
    const rehash = chainer.query(
      "update audit.audit_log set hash = repeat('f', 64) where tenant_id = $1 and hash is not null",
      [T],
    );
    await expect(rehash).rejects.toThrow(/chained row is immutable/);
    await expect(
      chainer.query(
        "update audit.audit_log set hash = repeat('f', 64) where tenant_id = $1 and hash is null",
        [T],
      ),
    ).rejects.toThrow(/may only set chain_seq, prev_hash and hash/);
  });

  it("even the owner path is guarded: DELETE and non-hash UPDATE rejected by trigger", async () => {
    await expect(
      admin.query("delete from audit.audit_log where tenant_id = $1", [T]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query("update audit.audit_log set action = 'x' where tenant_id = $1", [T]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query(
        "update audit.audit_log set action = 'x', chain_seq = 99, prev_hash = repeat('a',64), hash = repeat('b',64) where tenant_id = $1 and hash is null",
        [T],
      ),
    ).rejects.toThrow(/only chain_seq, prev_hash and hash may change/);
  });

  it("rejects half-chained rows and bad hashes by constraint", async () => {
    expect(
      await sqlState(
        admin.query(
          "update audit.audit_log set chain_seq = 5 where tenant_id = $1 and hash is null",
          [T],
        ),
      ),
    ).toBeDefined();
  });

  it("chain_heads / anchors are append-only for chainer", async () => {
    expect(await sqlState(chainer.query("delete from audit.chain_heads"))).toBe(INSUFFICIENT);
    expect(await sqlState(chainer.query("update audit.anchors set row_count = 9"))).toBe(
      INSUFFICIENT,
    );
    await expect(admin.query("update audit.anchors set row_count = 9")).resolves.toBeDefined(); // no rows yet
  });
});

describe("chainTenant / verifyTenantChain", () => {
  it("fills hashes, links from genesis, verifies, and is a no-op when empty", async () => {
    const T = uuid7();
    expect(await chainTenant(chainer, T)).toEqual({ chained: 0, head: "0".repeat(64) });
    await put(T, 5);
    expect(await listTenantsWithUnchained(chainer, 100)).toContain(T);
    const r = await chainTenant(chainer, T);
    expect(r.chained).toBe(5);
    expect(await count(T, "hash is null")).toBe(0);
    const v = await verifyTenantChain(chainer, T, { expectedHead: r.head, expectedLength: 5 });
    expect(v).toMatchObject({ ok: true, length: 5, anchored: true, head: r.head });
    expect((await loadChain(chainer, T)).map((x) => x.chainSeq)).toEqual([1, 2, 3, 4, 5]);
    expect((await loadChain(chainer, T, { fromSeq: 2, toSeq: 3 })).map((x) => x.chainSeq)).toEqual([
      2, 3,
    ]);
    expect(await listTenantsWithUnchained(chainer, 100)).not.toContain(T);
    await put(T, 2); // second pass continues from the head
    const r2 = await chainTenant(chainer, T);
    expect(r2.chained).toBe(2);
    expect(await verifyTenantChain(chainer, T)).toMatchObject({ ok: true, length: 7 });
  });

  it("respects batch size and keeps tenants independent", async () => {
    const A = uuid7();
    const B = uuid7();
    await put(A, 5);
    await put(B, 3);
    expect((await chainTenant(chainer, A, { batch: 2 })).chained).toBe(2);
    expect((await chainTenant(chainer, A, { batch: 10 })).chained).toBe(3);
    expect((await chainTenant(chainer, B)).chained).toBe(3);
    expect(await verifyTenantChain(chainer, A)).toMatchObject({ ok: true, length: 5 });
    expect(await verifyTenantChain(chainer, B)).toMatchObject({ ok: true, length: 3 });
  });

  it("superuser edit of a chained row is detected at that seq", async () => {
    const T = uuid7();
    await put(T, 6);
    const { head } = await chainTenant(chainer, T);
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica"); // bypass the guard trigger, as a DBA could
      await c.query(
        `update audit.audit_log set after = '{"total": 999}' where tenant_id = $1 and chain_seq = 4`,
        [T],
      );
      await c.query("commit");
    } finally {
      c.release();
    }
    expect(await verifyTenantChain(chainer, T, { expectedHead: head })).toEqual({
      ok: false,
      index: 3,
      reason: "hash_mismatch",
      chainSeq: 4,
    });
  });

  it("superuser delete of a middle row is detected (seq gap)", async () => {
    const T = uuid7();
    await put(T, 4);
    await chainTenant(chainer, T);
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from audit.audit_log where tenant_id = $1 and chain_seq = 2", [T]);
      await c.query("commit");
    } finally {
      c.release();
    }
    expect(await verifyTenantChain(chainer, T)).toMatchObject({
      ok: false,
      reason: "seq_gap",
      chainSeq: 3,
    });
  });

  it("two concurrent chainers on one tenant give contiguous chain_seq without duplicates", async () => {
    const T = uuid7();
    await put(T, 50);
    const results = await Promise.all([
      chainTenant(chainer, T, { batch: 30 }),
      chainTenant(chainer, T, { batch: 30 }),
    ]);
    expect(results.map((r) => r.chained).sort((a, b) => a - b)).toEqual([20, 30]);
    const seqs = await admin.query<{ chain_seq: string }>(
      "select chain_seq from audit.audit_log where tenant_id = $1 order by chain_seq",
      [T],
    );
    expect(seqs.rows.map((r) => Number(r.chain_seq))).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(await verifyTenantChain(chainer, T)).toMatchObject({ ok: true, length: 50 });
    // a single-transaction insert chains in identity-id order (numeric, not lexical)
    const byId = await admin.query<{ ok: boolean }>(
      `select bool_and(chain_seq > lag) as ok from (
         select chain_seq, lag(chain_seq) over (order by id) as lag from audit.audit_log where tenant_id = $1) x
       where lag is not null`,
      [T],
    );
    expect(byId.rows[0]?.ok).toBe(true);
  });

  it("a late-committing row is chained in the next pass and verification still passes", async () => {
    const T = uuid7();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const hasInserted = new Promise<void>((r) => {
      started = r;
    });
    const slow = withTenantTx(app, ctx(T), async (tx) => {
      await appendAudit(tx, [entry({ action: "slow" })]); // lowest identity id, commits last
      started();
      await gate;
    });
    await hasInserted;
    await put(T, 2);
    expect((await chainTenant(chainer, T)).chained).toBe(2);
    release();
    await slow;
    expect((await chainTenant(chainer, T)).chained).toBe(1);
    expect(await verifyTenantChain(chainer, T)).toMatchObject({ ok: true, length: 3 });
    const order = await loadChain(chainer, T);
    expect((order[2]?.payload as { action: string }).action).toBe("slow");
  });

  it("payload rebuild is stable for null / unicode / ipv6 / microsecond timestamps", async () => {
    const T = uuid7();
    await withTenantTx(app, ctx(T), (tx) =>
      appendAudit(tx, [
        entry({ ip: "2001:db8::1", ...bare }),
        entry({ deviceId: uuid7(), actorType: "device", ...noEntityId }),
        entry({ before: { n: 12345678901234, f: 1.5, s: "free é" } }),
      ]),
    );
    await chainTenant(chainer, T);
    expect(await verifyTenantChain(chainer, T)).toMatchObject({ ok: true, length: 3 });
  });
});

const bare = { before: undefined, after: undefined, reason: undefined } as unknown as Record<
  string,
  never
>;
const noEntityId = { entityId: undefined } as unknown as Record<string, never>;

describe("anchors", () => {
  it("is pending while unchained, then created once; second call is idempotent", async () => {
    const T = uuid7();
    const today = new Date().toISOString().slice(0, 10);
    await put(T, 5);
    expect(await buildDailyAnchor(chainer, T, today)).toEqual({ status: "pending" });
    await chainTenant(chainer, T);
    const first = await buildDailyAnchor(chainer, T, today);
    expect(first.status).toBe("created");
    const rows = await loadChain(chainer, T);
    if (first.status !== "created") throw new Error("unreachable");
    expect(first.anchor).toMatchObject({
      chainSeqFrom: 1,
      chainSeqTo: 5,
      rowCount: 5,
      headHash: rows[4]?.hash,
      merkleRoot: merkleRoot(rows.map((r) => r.hash)),
    });
    const again = await buildDailyAnchor(chainer, T, today);
    expect(again).toEqual({ status: "exists", anchor: first.anchor });
    expect(await buildDailyAnchor(chainer, T, "2001-01-01")).toEqual({ status: "empty" });
    await expect(buildDailyAnchor(chainer, T, "2001-13-45")).rejects.toThrow(/YYYY-MM-DD/);
    expect(
      Number(
        (
          await admin.query<{ n: string }>(
            "select count(*) n from audit.anchors where tenant_id = $1",
            [T],
          )
        ).rows[0]?.n,
      ),
    ).toBe(1);
    await expect(
      admin.query("delete from audit.anchors where tenant_id = $1", [T]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("partitions and RLS lint", () => {
  it("ensureAuditPartitions creates future partitions with forced RLS; idempotent", async () => {
    const before = await admin.query<{ n: string }>(
      "select count(*) n from pg_inherits where inhparent = 'audit.audit_log'::regclass",
    );
    expect(Number(before.rows[0]?.n)).toBe(4); // migration: current + 3
    expect(await ensureAuditPartitions(chainer, 3)).toBe(0);
    expect(await ensureAuditPartitions(chainer, 5)).toBe(2);
    expect(await ensureAuditPartitions(chainer)).toBe(0);
    await expect(ensureAuditPartitions(chainer, 99)).rejects.toThrow(/monthsAhead/);
    const parts = await admin.query<{ relname: string; relforcerowsecurity: boolean; n: string }>(
      `select c.relname, c.relforcerowsecurity,
              (select count(*) from pg_policies p where p.schemaname = 'audit' and p.tablename = c.relname)::text n
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'audit.audit_log'::regclass
       order by c.relname`,
    );
    expect(parts.rows).toHaveLength(6);
    expect(parts.rows.every((r) => r.relforcerowsecurity && Number(r.n) === 3)).toBe(true);
    expect(parts.rows[0]?.relname).toMatch(/^audit_log_y\d{4}m\d{2}$/);
    expect(await findTablesWithoutRls(admin, ["audit", "infra"])).toEqual([]);
  });

  it("a row for a far-future month without a partition fails loudly", async () => {
    const T = uuid7();
    const code = await sqlState(
      withTenantTx(app, ctx(T), (tx) =>
        tx.query(
          `insert into audit.audit_log (tenant_id, actor_type, actor_id, action, entity, request_id, at)
           values ($1, 'user', 'u', 'a', 'e', 'r', now() + interval '5 years')`,
          [T],
        ),
      ),
    );
    expect(code).toBe("23514"); // no partition of relation found for row
  });
});

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

const currentPartition = `audit_log_y${new Date().toISOString().slice(0, 4)}m${new Date().toISOString().slice(5, 7)}`;

describe("query plans on seeded data", () => {
  const BIG = uuid7();
  const SMALL = uuid7();
  beforeAll(async () => {
    // 100k chained rows (history) + 40 unchained + a second tenant with unchained rows.
    await admin.query(
      `insert into audit.audit_log (tenant_id, actor_type, actor_id, action, entity, entity_id, request_id, at, chain_seq, prev_hash, hash)
       select $1, 'user', 'u', 'sale.create', 'sale', 's' || g, 'r' || g, now() - (g || ' seconds')::interval, g,
              repeat('a', 64), repeat('b', 64) from generate_series(1, 100000) g`,
      [BIG],
    );
    await admin.query(
      `insert into audit.audit_log (tenant_id, actor_type, actor_id, action, entity, request_id)
       select t, 'user', 'u', 'x', 'e', 'r' from unnest($1::uuid[]) t, generate_series(1, 20)`,
      [[BIG, SMALL]],
    );
    await admin.query("analyze audit.audit_log");
  });

  const plan = async (sql: string, params: unknown[]): Promise<PlanNode[]> => {
    const c = await chainer.connect();
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

  it("chainer work-queue query uses the partial unchained index (no seq scan)", async () => {
    const nodes = await plan(
      `select id from audit.audit_log where tenant_id = $1 and hash is null order by id limit 1000 for update skip locked`,
      [BIG],
    );
    expect(nodes.some((n) => (n["Index Name"] ?? "").endsWith("_tenant_id_id_idx"))).toBe(true);
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });

  it("listTenantsWithUnchained uses the partial index", async () => {
    const nodes = await plan(
      `with recursive t(tenant_id) as (
         (select tenant_id from audit.audit_log where hash is null order by tenant_id limit 1)
         union all
         select (select a.tenant_id from audit.audit_log a where a.hash is null and a.tenant_id > t.tenant_id order by a.tenant_id limit 1)
         from t where t.tenant_id is not null
       ) select tenant_id from t where tenant_id is not null limit $1`,
      [100],
    );
    expect(nodes.some((n) => (n["Index Name"] ?? "").endsWith("_tenant_id_id_idx"))).toBe(true);
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
    expect(await listTenantsWithUnchained(chainer, 50)).toEqual(
      expect.arrayContaining([BIG, SMALL]),
    );
  });

  it("chain verification walk uses the chain_seq index", async () => {
    const nodes = await plan(
      `select chain_seq, hash from audit.audit_log where tenant_id = $1 and chain_seq is not null and chain_seq >= $2 and chain_seq <= $3 order by chain_seq`,
      [BIG, 1000, 2000],
    );
    expect(nodes.some((n) => (n["Index Name"] ?? "").endsWith("_chain_seq_idx"))).toBe(true);
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });

  it("chain update by (tenant, at, id) join uses the primary key", async () => {
    const nodes = await plan(
      `update audit.audit_log a set chain_seq = v.seq, prev_hash = v.prev, hash = v.hash
       from unnest($2::bigint[], $3::timestamptz[], $4::bigint[], $5::text[], $6::text[]) as v(id, at, seq, prev, hash)
       where a.tenant_id = $1 and a.at = v.at and a.id = v.id and a.hash is null`,
      [BIG, ["1"], ["2000-01-01T00:00:00Z"], ["1"], ["a".repeat(64)], ["b".repeat(64)]],
    );
    expect(
      nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === currentPartition),
    ).toBe(false);
  });
});
