import { buildDailyAnchor, verifyTenantChain } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { fakeClock } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAnchorJob,
  createAuditChainer,
  createPartitionJob,
  createPeriodic,
  dueDay,
  verifyAuditChain,
} from "../src/index.ts";

import {
  asSuperuserNoTriggers,
  seedAudit,
  setupDb,
  silentLogger,
  unchained,
  until,
  utcDay,
} from "./helpers.ts";

import type { Db } from "./helpers.ts";

let db: Db;
beforeAll(async () => {
  db = await setupDb();
});
afterAll(async () => {
  await db.drop();
});

const DAY = 86_400_000;

/** Seed + chain + anchor "today" for one tenant; returns tenant id. */
async function anchoredTenant(rows: number): Promise<string> {
  const t = uuidv7();
  await seedAudit(db.app, t, rows);
  const chainer = createAuditChainer({ pool: db.chainer, logger: silentLogger });
  await chainer.tick();
  const a = await buildDailyAnchor(db.chainer, t, utcDay(Date.now()));
  expect(a.status).toBe("created");
  return t;
}

describe("chainer loop", () => {
  it("fills hashes within 5 s across 3 tenants", async () => {
    const tenants = [uuidv7(), uuidv7(), uuidv7()];
    const chainer = createAuditChainer({ pool: db.chainer, logger: silentLogger, intervalMs: 200 });
    chainer.start();
    try {
      for (const t of tenants) await seedAudit(db.app, t, 5);
      const start = Date.now();
      await until(async () => {
        const counts = await Promise.all(tenants.map((t) => unchained(db.admin, t)));
        return counts.every((n) => n === 0);
      }, 5000);
      expect(Date.now() - start).toBeLessThan(5000);
      for (const t of tenants) {
        const r = await verifyTenantChain(db.chainer, t);
        expect(r).toMatchObject({ ok: true, length: 5 });
      }
    } finally {
      await chainer.stop();
    }
  });

  it("one tenant failing does not stop the others; stop() during sleep is prompt", async () => {
    const [good1, bad, good2] = [uuidv7(), uuidv7(), uuidv7()].sort();
    if (good1 === undefined || bad === undefined || good2 === undefined) throw new Error("ids");
    await db.admin
      .query(`create or replace function audit.test_boom() returns trigger language plpgsql as
      $$ begin if new.tenant_id = '${bad}' then raise exception 'boom'; end if; return new; end $$`);
    await db.admin.query(
      "create trigger zz_test_boom before update on audit.audit_log for each row execute function audit.test_boom()",
    );
    try {
      for (const t of [good1, bad, good2]) await seedAudit(db.app, t, 3);
      const metrics: string[] = [];
      const chainer = createAuditChainer({
        pool: db.chainer,
        logger: silentLogger,
        intervalMs: 60_000,
        onMetric: (name) => metrics.push(name),
      });
      chainer.start();
      await until(async () => (await unchained(db.admin, good2)) === 0);
      expect(await unchained(db.admin, good1)).toBe(0);
      expect(await unchained(db.admin, bad)).toBe(3);
      expect(metrics).toContain("audit_chain_tenant_error");
      const t0 = Date.now();
      await chainer.stop();
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      await db.admin.query("drop trigger zz_test_boom on audit.audit_log");
    }
  });
});

describe("verifyAuditChain", () => {
  it("passes against the anchor, anchored === true", async () => {
    const t = await anchoredTenant(4);
    const r = await verifyAuditChain(db.chainer, t);
    expect(r).toMatchObject({ ok: true, anchored: true, length: 4, toSeq: 4 });
  });

  it("reports no_anchor when none exists", async () => {
    const r = await verifyAuditChain(db.chainer, uuidv7());
    expect(r).toEqual({ ok: false, reason: "no_anchor", chainSeq: null });
  });

  it("detects a tampered row at its seq", async () => {
    const t = await anchoredTenant(4);
    await asSuperuserNoTriggers(
      db.admin,
      `update audit.audit_log set "after" = '{"evil":true}' where tenant_id = $1 and chain_seq = 3`,
      [t],
    );
    const r = await verifyAuditChain(db.chainer, t);
    expect(r).toMatchObject({ ok: false, reason: "hash_mismatch", chainSeq: 3 });
  });

  it("detects tail truncation only against the anchor", async () => {
    const t = await anchoredTenant(4);
    await asSuperuserNoTriggers(
      db.admin,
      "delete from audit.audit_log where tenant_id = $1 and chain_seq = 4",
      [t],
    );
    // Unanchored verification sees a perfectly valid shorter chain.
    expect(await verifyTenantChain(db.chainer, t)).toMatchObject({ ok: true, length: 3 });
    const r = await verifyAuditChain(db.chainer, t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["head_mismatch", "length_mismatch"]).toContain(r.reason);
  });
});

describe("anchor job", () => {
  it("is due only after 00:05 UTC and builds yesterday once; reruns are idempotent", async () => {
    const t = uuidv7();
    await seedAudit(db.app, t, 3);
    await createAuditChainer({ pool: db.chainer, logger: silentLogger }).tick();
    const midnight = Math.floor(Date.now() / DAY) * DAY + DAY;
    const clock = fakeClock(midnight + 60_000);
    const job = createAnchorJob({ pool: db.chainer, logger: silentLogger, clock });
    expect(dueDay(midnight + 60_000, 5)).toBeUndefined();
    expect((await job.runDue()).day).toBeUndefined();

    clock.set(midnight + 6 * 60_000);
    const first = await job.runDue();
    expect(first.day).toBe(utcDay(midnight - 1));
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(first.verifyFailed).toBe(0);
    expect((await job.runDue()).day).toBeUndefined(); // done in this process

    const fresh = createAnchorJob({ pool: db.chainer, logger: silentLogger, clock });
    const again = await fresh.runDue();
    expect(again.created).toBe(0);
    expect(again.exists).toBeGreaterThanOrEqual(1);
    const n = await db.admin.query(
      "select count(*)::int n from audit.anchors where tenant_id = $1",
      [t],
    );
    expect(n.rows[0]).toEqual({ n: 1 });
  });
});

describe("partition job", () => {
  it("recreates a missing future partition (current + 3 months)", async () => {
    const children = async (): Promise<string[]> =>
      (
        await db.admin.query<{ relname: string }>(
          `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
           where i.inhparent = 'audit.audit_log'::regclass order by c.relname`,
        )
      ).rows.map((r) => r.relname);
    const before = await children();
    expect(before.length).toBeGreaterThanOrEqual(4);
    const last = before[before.length - 1];
    if (last === undefined) throw new Error("no partitions");
    await db.admin.query(`drop table audit.${last}`);
    const created: number[] = [];
    const job = createPartitionJob({
      pool: db.chainer,
      logger: silentLogger,
      onMetric: (name, v) => {
        if (name === "audit_partitions_created") created.push(v);
      },
    });
    await job.runOnce();
    expect(await children()).toEqual(before);
    expect(created).toEqual([1]);
  });
});

describe("periodic", () => {
  it("survives a failing run and stops promptly", async () => {
    let runs = 0;
    const errors: string[] = [];
    const p = createPeriodic({
      name: "x",
      intervalMs: 10,
      logger: { ...silentLogger, error: (o) => errors.push(JSON.stringify(o)) },
      run: () => {
        runs += 1;
        return Promise.reject(new Error("nope"));
      },
    });
    p.start();
    await until(() => Promise.resolve(runs >= 3), 2000);
    await p.stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(after);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
