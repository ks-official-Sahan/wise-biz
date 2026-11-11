import { join } from "node:path";

import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantCtx } from "@wise-biz/db";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const supportDir = join(import.meta.dirname, "..", "migrations");

const T1 = uuidv7();
const T2 = uuidv7();
const USER = uuidv7();

const ctx = (tenantId: string): TenantCtx => ({ tenantId, requestId: "rls-test" });

let db: TestDatabase;
let app: pg.Pool;
let admin: pg.Pool;
let ticketT1: string;

/** Inserts one ticket and its first message for `tenantId` (through the app role, so RLS applies). */
async function insertTicket(tenantId: string): Promise<string> {
  const id = uuidv7();
  await withTenantTx(app, ctx(tenantId), async (tx) => {
    await tx.query(
      `insert into support.tickets (tenant_id, id, subject, status, priority, created_by, plan_code,
         sla_first_response_due_at, sla_resolution_due_at)
       values ($1, $2, 'Printer', 'open', 'normal', $3, 'free', now(), now() + interval '5 days')`,
      [tenantId, id, USER],
    );
    await tx.query(
      `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body)
       values ($1, $2, $3, 'tenant', $4, 'help')`,
      [tenantId, uuidv7(), id, USER],
    );
  });
  return id;
}

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "support", dir: supportDir },
  ]);
  app = createPool(db.url("app"));
  admin = createPool(db.url("admin"));
  ticketT1 = await insertTicket(T1);
});

afterAll(async () => {
  await app.end();
  await admin.end();
  await db.drop();
});

describe("RLS on support tables", () => {
  it("both tables have RLS enabled and forced", async () => {
    const r = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'support' and c.relkind = 'r'
        order by c.relname`,
    );
    expect(r.rows).toEqual([
      { relname: "ticket_messages", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "tickets", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("tenant two sees none of tenant one's tickets or messages", async () => {
    const seen = await withTenantTx(app, ctx(T2), async (tx) => ({
      tickets: (await tx.query("select id from support.tickets")).rowCount,
      messages: (await tx.query("select id from support.ticket_messages")).rowCount,
      byId: (await tx.query("select id from support.tickets where id = $1", [ticketT1])).rowCount,
    }));
    expect(seen).toEqual({ tickets: 0, messages: 0, byId: 0 });
  });

  it("tenant one still sees its own ticket", async () => {
    const n = await withTenantTx(
      app,
      ctx(T1),
      async (tx) =>
        (await tx.query("select id from support.tickets where id = $1", [ticketT1])).rowCount,
    );
    expect(n).toBe(1);
  });

  it("no tenant set means no rows at all", async () => {
    const r = await app.query<{ n: string }>(
      "select (select count(*) from support.tickets)::text as n",
    );
    expect(r.rows[0]?.n).toBe("0");
  });

  it("tenant two cannot insert a row that claims tenant one", async () => {
    await expect(
      withTenantTx(app, ctx(T2), (tx) =>
        tx.query(
          `insert into support.tickets (tenant_id, id, subject, status, priority, created_by, plan_code,
             sla_first_response_due_at, sla_resolution_due_at)
           values ($1, $2, 'x', 'open', 'low', $3, 'free', now(), now())`,
          [T1, uuidv7(), USER],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a message cannot point at another tenant's ticket (composite foreign key)", async () => {
    await expect(
      withTenantTx(app, ctx(T2), (tx) =>
        tx.query(
          `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body)
           values ($1, $2, $3, 'tenant', $4, 'sneaky')`,
          [T2, uuidv7(), ticketT1, USER],
        ),
      ),
    ).rejects.toThrow(/foreign key|ticket_messages_ticket_fk/i);
  });
});

describe("column-level grants for the app role", () => {
  const priv = async (sql: string) =>
    (await admin.query<{ ok: boolean }>(`select (${sql}) as ok`)).rows[0]?.ok;

  it("tickets: status and SLA stamps are updatable, the rest is not", async () => {
    expect(
      await priv("has_column_privilege('wb_app', 'support.tickets', 'status', 'UPDATE')"),
    ).toBe(true);
    expect(
      await priv("has_column_privilege('wb_app', 'support.tickets', 'solved_at', 'UPDATE')"),
    ).toBe(true);
    for (const col of [
      "subject",
      "priority",
      "tenant_id",
      "created_by",
      "diagnostics",
      "plan_code",
    ]) {
      expect(
        await priv(`has_column_privilege('wb_app', 'support.tickets', '${col}', 'UPDATE')`),
      ).toBe(false);
    }
  });

  it("no delete or truncate on either table, and messages are append-only", async () => {
    for (const table of ["support.tickets", "support.ticket_messages"]) {
      expect(await priv(`has_table_privilege('wb_app', '${table}', 'DELETE')`)).toBe(false);
      expect(await priv(`has_table_privilege('wb_app', '${table}', 'TRUNCATE')`)).toBe(false);
    }
    expect(await priv("has_table_privilege('wb_app', 'support.ticket_messages', 'UPDATE')")).toBe(
      false,
    );
    expect(await priv("has_table_privilege('wb_app', 'support.ticket_messages', 'INSERT')")).toBe(
      true,
    );
  });

  it("the app role is refused a message edit and a ticket delete at run time", async () => {
    await expect(
      withTenantTx(app, ctx(T1), (tx) =>
        tx.query("update support.ticket_messages set body = 'edited'"),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenantTx(app, ctx(T1), (tx) => tx.query("delete from support.tickets")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("table checks", () => {
  it("a tenant author can never write an internal note", async () => {
    await expect(
      withTenantTx(app, ctx(T1), (tx) =>
        tx.query(
          `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body, internal)
           values ($1, $2, $3, 'tenant', $4, 'secret note', true)`,
          [T1, uuidv7(), ticketT1, USER],
        ),
      ),
    ).rejects.toThrow(/ticket_messages_internal_chk/);
  });

  it("bodies are bounded to 8000 characters and never blank", async () => {
    await expect(
      withTenantTx(app, ctx(T1), (tx) =>
        tx.query(
          `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body)
           values ($1, $2, $3, 'tenant', $4, $5)`,
          [T1, uuidv7(), ticketT1, USER, "a".repeat(8001)],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      withTenantTx(app, ctx(T1), (tx) =>
        tx.query(
          `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body)
           values ($1, $2, $3, 'tenant', $4, '   ')`,
          [T1, uuidv7(), ticketT1, USER],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("the SLA resolution cannot be earlier than the first response", async () => {
    await expect(
      withTenantTx(app, ctx(T1), (tx) =>
        tx.query(
          `insert into support.tickets (tenant_id, id, subject, status, priority, created_by, plan_code,
             sla_first_response_due_at, sla_resolution_due_at)
           values ($1, $2, 'x', 'open', 'low', $3, 'free', now() + interval '1 day', now())`,
          [T1, uuidv7(), USER],
        ),
      ),
    ).rejects.toThrow(/tickets_sla_order_chk/);
  });
});
