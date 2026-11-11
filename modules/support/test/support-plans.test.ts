import { join } from "node:path";

import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantCtx, TxHandle } from "@wise-biz/db";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const supportDir = join(import.meta.dirname, "..", "migrations");
const T1 = uuidv7();
const ctx = (tenantId: string): TenantCtx => ({ tenantId, requestId: "plans-test" });

/**
 * Query plans of the three list and thread reads, run as wb_app inside the tenant transaction with sequential scans
 * disabled: any plan that still reads the table in full is a seq-scan-only plan, and the index must be the one named.
 * The SQL mirrors application/tickets.ts (listTickets) and application/messages.ts (messagesOf).
 */
const READS: readonly { name: string; sql: string; params: unknown[]; indexes: string[] }[] = [
  {
    // Either index is a valid plan: the planner picks by statistics (tickets_created_idx with a status filter on a
    // small table; tickets_status_idx once status is selective).
    name: "list filtered by status (keyset)",
    sql: `select id from support.tickets
           where tenant_id = $1 and status = $2 and (created_at, id) < ($3, $4)
           order by created_at desc, id desc limit $5`,
    params: [T1, "open", new Date(), uuidv7(), 51],
    indexes: ["tickets_status_idx", "tickets_created_idx"],
  },
  {
    name: "list across statuses (keyset)",
    sql: `select id from support.tickets
           where tenant_id = $1 order by created_at desc, id desc limit $2`,
    params: [T1, 51],
    indexes: ["tickets_created_idx"],
  },
  {
    name: "ticket thread for a tenant (no internal notes)",
    sql: `select id from support.ticket_messages
           where tenant_id = $1 and ticket_id = $2 and not internal
           order by created_at, id limit $3`,
    params: [T1, uuidv7(), 201],
    indexes: ["ticket_messages_thread_idx"],
  },
];

let db: TestDatabase;
let app: pg.Pool;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "support", dir: supportDir },
  ]);
  app = createPool(db.url("app"));
  await withTenantTx(app, ctx(T1), async (tx: TxHandle) => {
    for (let i = 0; i < 3; i++) {
      const id = uuidv7();
      await tx.query(
        `insert into support.tickets (tenant_id, id, subject, status, priority, created_by, plan_code,
           sla_first_response_due_at, sla_resolution_due_at)
         values ($1, $2, $3, 'open', 'normal', $4, 'free', now(), now() + interval '5 days')`,
        [T1, id, `Ticket ${String(i)}`, uuidv7()],
      );
    }
  });
});

afterAll(async () => {
  await app.end();
  await db.drop();
});

describe("query plans of the support reads (wb_app, sequential scans off)", () => {
  it("each read uses its index and never reads the whole table", async () => {
    await withTenantTx(app, ctx(T1), async (tx: TxHandle) => {
      await tx.query("set local enable_seqscan = off");
      for (const q of READS) {
        const r = await tx.query<{ "QUERY PLAN": unknown }>(
          `explain (format json) ${q.sql}`,
          q.params,
        );
        const plan = JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
        expect(plan, q.name).not.toContain('"Node Type":"Seq Scan"');
        expect(
          q.indexes.some((ix) => plan.includes(`"Index Name":"${ix}"`)),
          q.name,
        ).toBe(true);
      }
    });
  });
});
