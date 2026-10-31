import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { CompleteSaleSchema, OpenShiftSchema } from "@wise-biz/contracts";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { batchSalePrices, recordMovements, selectBatchesFefo } from "@wise-biz/module-inventory";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { completeSale, openShift, SaleCompletedV1 } from "../src/index.ts";

import type {
  OperatorFacts,
  QuoteInput,
  QuoteResult,
  SalesPorts,
  TerminalContext,
} from "../src/index.ts";
import type { CompleteSale } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const BRANCH = uuidv7();
const OPERATOR = uuidv7();
const LOC = uuidv7();
const LIST = uuidv7();
const TODAY = new Date().toISOString().slice(0, 10);

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

// Stubbed neighbours: pricing answers what a test sets, tenancy knows the operators a test sets.
let serverQuote: (input: QuoteInput) => QuoteResult = () => quoteOf(1000);
const operators = new Map<string, OperatorFacts>();
let policyVersion = 1;
const quoteOf = (payableMinor: number, opts: { version?: number; promos?: string[] } = {}) => ({
  engine: "1.0.0",
  priceListId: `${LIST}:${String(opts.version ?? 1)}`,
  totalMinor: payableMinor,
  payableMinor,
  lines: [
    {
      lineDiscounts: (opts.promos ?? []).map((promotionId) => ({ promotionId })),
      cartDiscounts: [],
    },
  ],
});
const ports: SalesPorts = {
  inventory: { recordMovements, batches: batchSalePrices, selectBatchesFefo },
  pricing: { quote: (_tx, _tenant, input) => Promise.resolve(serverQuote(input)) },
  tenancy: {
    operators: (_tx, _tenant, ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const f = operators.get(id);
            return f === undefined ? [] : [[id, f] as const];
          }),
        ),
      ),
    policyVersion: () => Promise.resolve(policyVersion),
  },
};

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: dir("inventory") },
    { module: "sales", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 40 });
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});
beforeEach(() => {
  serverQuote = () => quoteOf(1000);
  operators.clear();
  operators.set(OPERATOR, { active: true, permissions: new Set(["sales:sell", "sales:shift"]) });
  policyVersion = 1;
});

const terminal = (terminalId = uuidv7()): TerminalContext => ({
  tenantId: T,
  terminalId,
  branchId: BRANCH,
  requestId: "req-12345678",
  now: new Date(),
  ids: { uuidv7 },
});
const tx = <R>(fn: (tx: TxHandle) => Promise<R>) =>
  withTenantTx(pool, { tenantId: T, requestId: "req-12345678" }, fn);
const seqs = new Map<string, number>();
const meta = (t: TerminalContext) => {
  const deviceSeq = seqs.get(t.terminalId) ?? 0;
  seqs.set(t.terminalId, deviceSeq + 1);
  return {
    deviceSeq,
    prevHash: randomBytes(32).toString("base64"),
    hash: randomBytes(32).toString("base64"),
    signature: randomBytes(64).toString("base64"),
  };
};
async function open(t: TerminalContext) {
  const cmd = OpenShiftSchema.parse({
    id: uuidv7(),
    operatorId: OPERATOR,
    businessDate: TODAY,
    openedAt: new Date().toISOString(),
    currency: "USD",
    openingFloatMinor: 5000,
    meta: meta(t),
  });
  await tx((x) => openShift(x, ports, t, cmd));
  return cmd.id;
}
const saleNos = new Map<string, number>();
function sale(t: TerminalContext, shiftId: string, over: Partial<CompleteSale> = {}): CompleteSale {
  const saleNo = (saleNos.get(t.terminalId) ?? 0) + 1;
  saleNos.set(t.terminalId, saleNo);
  const variantId = uuidv7();
  return CompleteSaleSchema.parse({
    id: uuidv7(),
    shiftId,
    operatorId: OPERATOR,
    saleNo,
    currency: "USD",
    businessDate: TODAY,
    completedAt: new Date().toISOString(),
    priceListId: LIST,
    priceListVersion: 1,
    engineVersion: "1.0.0",
    policyVersion: 1,
    lines: [
      {
        variantId,
        name: "Milk 1L",
        sku: "MILK-1",
        locationId: LOC,
        qty: "2",
        unitPriceMinor: 500,
        priceSource: "list",
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 1000,
      },
    ],
    tenders: [
      { id: uuidv7(), kind: "cash", amountMinor: 1000, receivedMinor: 2000, changeMinor: 1000 },
    ],
    subtotalMinor: 1000,
    discountMinor: 0,
    feeMinor: 0,
    taxMinor: 0,
    totalMinor: 1000,
    cashRoundingMinor: 0,
    payableMinor: 1000,
    meta: meta(t),
    ...over,
  });
}
const count = async (sql: string, params: unknown[]) =>
  Number((await admin.query<{ n: string }>(sql, params)).rows[0]?.n);
const rowsOf = async (saleId: string) => ({
  sales: await count("select count(*) n from sales.sales where id = $1", [saleId]),
  lines: await count("select count(*) n from sales.sale_lines where sale_id = $1", [saleId]),
  tenders: await count("select count(*) n from sales.sale_tenders where sale_id = $1", [saleId]),
  chain: await count("select count(*) n from sales.device_documents where doc_id = $1", [saleId]),
  movements: await count("select count(*) n from inventory.stock_movements where source_id = $1", [
    saleId,
  ]),
  audit: await count("select count(*) n from audit.audit_log where entity_id = $1", [saleId]),
  outbox: await count("select count(*) n from infra.outbox where payload->>'subject' = $1", [
    `sale/${saleId}`,
  ]),
});
const fails = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  expect((e as DomainError).code).toBe(code);
  return e as DomainError;
};

describe("OpenShift", () => {
  it("opens one shift per terminal and replays the same document", async () => {
    const t = terminal();
    const cmd = OpenShiftSchema.parse({
      id: uuidv7(),
      operatorId: OPERATOR,
      businessDate: TODAY,
      openedAt: new Date().toISOString(),
      currency: "USD",
      openingFloatMinor: 5000,
      meta: meta(t),
    });
    const first = await tx((x) => openShift(x, ports, t, cmd));
    expect(first).toEqual({
      body: { shiftId: cmd.id, status: "open", flags: [] },
      replayed: false,
    });
    const again = await tx((x) => openShift(x, ports, t, cmd));
    expect(again).toEqual({ ...first, replayed: true });
    const second = OpenShiftSchema.parse({ ...cmd, id: uuidv7(), meta: meta(t) });
    await fails(
      tx((x) => openShift(x, ports, t, second)),
      "CONFLICT",
    );
  });
});

describe("CompleteSale", () => {
  it("writes the sale, lines, tenders, chain, stock, invoice, audit and events in one go", async () => {
    const t = terminal();
    const shiftId = await open(t);
    const cmd = sale(t, shiftId);
    const r = await tx((x) => completeSale(x, ports, t, cmd));
    expect(r.replayed).toBe(false);
    expect(r.body).toMatchObject({ saleId: cmd.id, status: "completed", flags: [] });
    expect(r.body.invoiceNo).toMatch(/^INV-\d{6}$/);
    expect(await rowsOf(cmd.id)).toEqual({
      sales: 1,
      lines: 1,
      tenders: 1,
      chain: 1,
      movements: 1,
      audit: 1,
      // sales.sale.completed + inventory.movement.recorded (subject sale/<id>), same transaction.
      outbox: 2,
    });
    const audit = await admin.query<{ actor_type: string; actor_id: string; device_id: string }>(
      "select actor_type, actor_id, device_id from audit.audit_log where entity_id = $1",
      [cmd.id],
    );
    expect(audit.rows[0]).toEqual({
      actor_type: "device",
      actor_id: t.terminalId,
      device_id: t.terminalId,
    });
    const bal = await admin.query<{ qty: string }>(
      "select qty::text from inventory.stock_balances where tenant_id = $1 and variant_id = $2",
      [T, cmd.lines[0]?.variantId],
    );
    expect(Number(bal.rows[0]?.qty)).toBe(-2);
    const ev = await admin.query<{
      key: string;
      payload: { data: { lines: unknown[]; invoiceNo: string } };
    }>("select key, payload from infra.outbox where type = $1 and payload->>'subject' = $2", [
      SaleCompletedV1.type,
      `sale/${cmd.id}`,
    ]);
    expect(ev.rows[0]?.key).toBe(`${T}:${BRANCH}`);
    expect(ev.rows[0]?.payload.data.invoiceNo).toBe(r.body.invoiceNo);
  });

  it("applies the same document twice as one sale with the same answer", async () => {
    const t = terminal();
    const cmd = sale(t, await open(t));
    const first = await tx((x) => completeSale(x, ports, t, cmd));
    const again = await tx((x) => completeSale(x, ports, t, cmd));
    expect(again).toEqual({ body: first.body, replayed: true });
    // Concurrent retries of one document: one writes, the others wait and replay.
    const racing = await Promise.all(
      Array.from({ length: 5 }, () => tx((x) => completeSale(x, ports, t, cmd))),
    );
    for (const r of racing) expect(r).toEqual({ body: first.body, replayed: true });
    expect((await rowsOf(cmd.id)).sales).toBe(1);
  });

  it("refuses a different document under a used id", async () => {
    const t = terminal();
    const cmd = sale(t, await open(t));
    await tx((x) => completeSale(x, ports, t, cmd));
    await fails(
      tx((x) => completeSale(x, ports, t, { ...cmd, meta: meta(t) })),
      "CONFLICT",
    );
    // The same id from another terminal is not a replay either.
    const other = terminal();
    await fails(
      tx((x) => completeSale(x, ports, other, cmd)),
      "CONFLICT",
    );
  });

  it("refuses a used device sequence number or sale number", async () => {
    const t = terminal();
    const shiftId = await open(t);
    const a = sale(t, shiftId);
    await tx((x) => completeSale(x, ports, t, a));
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, shiftId, { meta: a.meta }))),
      "CONFLICT",
    );
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, shiftId, { saleNo: a.saleNo }))),
      "CONFLICT",
    );
  });

  describe("price check (ADR 0014)", () => {
    it("same inputs: within tolerance is flagged, beyond it is PRICE_MISMATCH with nothing written", async () => {
      const t = terminal();
      const shiftId = await open(t);
      serverQuote = () => quoteOf(1003); // 3 minor off: within max(1, 0.5% of 1003 = 5)
      const near = await tx((x) => completeSale(x, ports, t, sale(t, shiftId)));
      expect(near.body.flags).toEqual(["price_mismatch"]);
      serverQuote = () => quoteOf(1100);
      const far = sale(t, shiftId);
      const e = await fails(
        tx((x) => completeSale(x, ports, t, far)),
        "PRICE_MISMATCH",
      );
      expect(e.details).toEqual({ devicePayableMinor: 1000, serverPayableMinor: 1100 });
      expect((await rowsOf(far.id)).sales).toBe(0);
    });

    it("different inputs are accepted and flagged stale_price", async () => {
      const t = terminal();
      const shiftId = await open(t);
      // A newer list version on the server.
      serverQuote = () => quoteOf(1500, { version: 2 });
      expect((await tx((x) => completeSale(x, ports, t, sale(t, shiftId)))).body.flags).toEqual([
        "stale_price",
      ]);
      // A promotion the device applied has ended since.
      serverQuote = () => quoteOf(1500);
      const promo = sale(t, shiftId, { promotionIds: [uuidv7()] });
      expect((await tx((x) => completeSale(x, ports, t, promo))).body.flags).toEqual([
        "stale_price",
      ]);
      // The server can no longer price the cart (archived variant, list out of force).
      serverQuote = () => {
        throw new DomainError("VALIDATION_FAILED", "Unknown or archived variant.");
      };
      expect((await tx((x) => completeSale(x, ports, t, sale(t, shiftId)))).body.flags).toEqual([
        "stale_price",
      ]);
    });

    it("does not swallow an unexpected pricing failure", async () => {
      const t = terminal();
      const shiftId = await open(t);
      serverQuote = () => {
        throw new Error("pricing is down");
      };
      await expect(tx((x) => completeSale(x, ports, t, sale(t, shiftId)))).rejects.toThrow(
        "pricing is down",
      );
    });

    it("sends override prices and batches to the quote", async () => {
      const t = terminal();
      const shiftId = await open(t);
      let seen: QuoteInput | undefined;
      serverQuote = (input) => {
        seen = input;
        return quoteOf(1000);
      };
      const base = sale(t, shiftId);
      const line = {
        ...base.lines[0],
        priceSource: "override",
        unitPriceMinor: 500,
      } as CompleteSale["lines"][number];
      await tx((x) => completeSale(x, ports, t, { ...base, lines: [line] }));
      expect(seen?.lines[0]).toMatchObject({ priceOverrideMinor: 500, qty: "2" });
    });
  });

  it("flags an inactive or unauthorized operator and a stale policy, never refuses", async () => {
    const t = terminal();
    const shiftId = await open(t);
    operators.set(OPERATOR, { active: false, permissions: "all" });
    policyVersion = 3;
    expect((await tx((x) => completeSale(x, ports, t, sale(t, shiftId)))).body.flags).toEqual([
      "operator_inactive",
      "stale_policy",
    ]);
    operators.set(OPERATOR, { active: true, permissions: new Set() });
    policyVersion = 1;
    expect((await tx((x) => completeSale(x, ports, t, sale(t, shiftId)))).body.flags).toEqual([
      "operator_unauthorized",
    ]);
  });

  it("checks the shift, the currency and the document time", async () => {
    const t = terminal();
    const shiftId = await open(t);
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, uuidv7()))),
      "VALIDATION_FAILED",
    );
    await fails(
      tx((x) => completeSale(x, ports, terminal(), sale(t, shiftId))),
      "VALIDATION_FAILED",
    );
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, shiftId, { currency: "EUR" }))),
      "CURRENCY_MISMATCH",
    );
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, shiftId, { completedAt: ahead }))),
      "VALIDATION_FAILED",
    );
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, shiftId, { completedAt: old }))),
      "VALIDATION_FAILED",
    );
    await admin.query(
      "update sales.shifts set status = 'closed', closed_by = $2, closed_at = now(), " +
        "expected_cash_minor = 0, counted_cash_minor = 0, over_short_minor = 0, blind_count = false, z_report = '{}' " +
        "where id = $1",
      [shiftId, OPERATOR],
    );
    await fails(
      tx((x) => completeSale(x, ports, t, sale(t, shiftId))),
      "VALIDATION_FAILED",
    );
  });

  describe("stock", () => {
    async function batch(variantId: string, expiresOn: string | null, qty: number, cost = 120) {
      const id = uuidv7();
      await admin.query(
        `insert into inventory.batches (id, tenant_id, variant_id, expires_on, currency, unit_cost_minor, received_at)
         values ($1, $2, $3, $4, 'USD', $5, now())`,
        [id, T, variantId, expiresOn, cost],
      );
      await tx((x) =>
        recordMovements(
          x,
          {
            tenant: { tenantId: T, userId: OPERATOR, requestId: "req-12345678" },
            userId: OPERATOR,
            requestId: "req-12345678",
            now: new Date(),
            ids: { uuidv7 },
          },
          { type: "seed", id: uuidv7(), occurredAt: new Date() },
          [
            {
              locationId: LOC,
              variantId,
              batchId: id,
              qty: String(qty),
              reason: "receive",
              sourceLine: 0,
            },
          ],
        ),
      );
      return id;
    }
    const withLine = (base: CompleteSale, over: Partial<CompleteSale["lines"][number]>) => ({
      ...base,
      lines: [{ ...base.lines[0], ...over } as CompleteSale["lines"][number]],
    });
    const movements = async (saleId: string) =>
      (
        await admin.query<{ batch_id: string | null; qty: string; source_line: number }>(
          `select batch_id, qty::text, source_line from inventory.stock_movements where source_id = $1
           order by source_line`,
          [saleId],
        )
      ).rows.map((r) => ({ batchId: r.batch_id, qty: Number(r.qty), line: r.source_line }));

    it("sells from the device's batch with its cost; an expired batch is recorded and flagged", async () => {
      const t = terminal();
      const shiftId = await open(t);
      const base = sale(t, shiftId);
      const variantId = base.lines[0]?.variantId ?? "";
      const good = await batch(variantId, "2999-01-01", 10, 150);
      const cmd = withLine(base, { batchId: good });
      expect((await tx((x) => completeSale(x, ports, t, cmd))).body.flags).toEqual([]);
      expect(await movements(cmd.id)).toEqual([{ batchId: good, qty: -2, line: 0 }]);
      const line = await admin.query<{ unit_cost_minor: string }>(
        "select unit_cost_minor from sales.sale_lines where sale_id = $1",
        [cmd.id],
      );
      expect(Number(line.rows[0]?.unit_cost_minor)).toBe(150);
      const expired = await batch(variantId, "2000-01-01", 5);
      const old = withLine(sale(t, shiftId), { variantId, batchId: expired });
      expect((await tx((x) => completeSale(x, ports, t, old))).body.flags).toEqual([
        "expired_batch",
      ]);
      expect(await movements(old.id)).toEqual([{ batchId: expired, qty: -2, line: 0 }]);
    });

    it("re-allocates FEFO when the batch is unknown; the rest goes to the no-batch balance", async () => {
      const t = terminal();
      const shiftId = await open(t);
      const base = sale(t, shiftId);
      const variantId = base.lines[0]?.variantId ?? "";
      const first = await batch(variantId, "2998-01-01", 1);
      const cmd = withLine(base, { batchId: uuidv7(), qty: "3", totalMinor: 1000 });
      expect((await tx((x) => completeSale(x, ports, t, cmd))).body.flags).toEqual([
        "batch_reallocated",
      ]);
      expect(await movements(cmd.id)).toEqual([
        { batchId: first, qty: -1, line: 0 },
        { batchId: null, qty: -2, line: 1 },
      ]);
    });
  });

  it("keeps a 500-line sale event under the outbox payload limit", async () => {
    const t = terminal();
    const base = sale(t, await open(t));
    const lines = Array.from({ length: 500 }, (_, i) => ({
      variantId: uuidv7(),
      name: "N".repeat(250),
      sku: `S${String(i).padStart(63, "0")}`,
      locationId: LOC,
      batchId: null,
      qty: "99999999999999.9999",
      unitPriceMinor: 0,
      priceSource: "list" as const,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: i === 0 ? 1000 : 0,
      detail: { trace: "x".repeat(2000) },
    }));
    const cmd = CompleteSaleSchema.parse({ ...base, lines });
    await tx((x) => completeSale(x, ports, t, cmd));
    const size = await count(
      "select octet_length(payload::text) n from infra.outbox where payload->>'subject' = $1",
      [`sale/${cmd.id}`],
    );
    expect(size).toBeLessThan(256 * 1024);
  });

  it("leaves no partial rows when any write fails", async () => {
    const t = terminal();
    const shiftId = await open(t);
    await tx((x) => completeSale(x, ports, t, sale(t, shiftId))); // the branch sequence exists
    await admin.query(
      "create or replace function public.inject_failure() returns trigger language plpgsql as " +
        "$$ begin raise exception 'injected failure'; end $$",
    );
    const targets = [
      ["sales.sales", "insert"],
      ["sales.device_documents", "insert"],
      ["sales.sale_lines", "insert"],
      ["sales.sale_tenders", "insert"],
      ["inventory.stock_movements", "insert"],
      ["inventory.stock_balances", "insert or update"],
      ["sales.invoice_sequences", "update"],
      ["sales.sales", "update"],
      ["audit.audit_log", "insert"],
      ["infra.outbox", "insert"],
    ] as const;
    const lastNo = () =>
      count(
        "select last_no n from sales.invoice_sequences where tenant_id = $1 and branch_id = $2",
        [T, BRANCH],
      );
    for (const [table, op] of targets) {
      const before = await lastNo();
      await admin.query(
        `create trigger inject before ${op} on ${table} for each row execute function public.inject_failure()`,
      );
      const cmd = sale(t, shiftId);
      try {
        const e = await tx((x) => completeSale(x, ports, t, cmd)).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(String(e), `${table} ${op}`).toContain("injected failure");
      } finally {
        await admin.query(`drop trigger inject on ${table}`);
      }
      expect(await rowsOf(cmd.id), `${table} ${op}`).toEqual({
        sales: 0,
        lines: 0,
        tenders: 0,
        chain: 0,
        movements: 0,
        audit: 0,
        outbox: 0,
      });
      expect(await lastNo()).toBe(before);
    }
  });

  it("numbers invoices gaplessly per branch under 100 concurrent sales, some rejected", async () => {
    const branch = uuidv7();
    const terminals = Array.from({ length: 10 }, () => ({ ...terminal(), branchId: branch }));
    const shifts = await Promise.all(terminals.map((t) => open(t)));
    const cmds = terminals.flatMap((t, i) =>
      Array.from({ length: 10 }, () => sale(t, shifts[i] ?? "")),
    );
    // Every 7th sale is beyond price tolerance and rolls back after the checks.
    const bad = new Set(cmds.filter((_, i) => i % 7 === 3).map((c) => c.id));
    serverQuote = () => quoteOf(1000);
    const results = await Promise.all(
      cmds.map((cmd, i) => {
        const t = terminals[Math.floor(i / 10)] ?? terminal();
        return tx((x) =>
          completeSale(
            x,
            ports,
            t,
            bad.has(cmd.id)
              ? {
                  ...cmd,
                  payableMinor: 500,
                  tenders: [
                    { ...cmd.tenders[0], amountMinor: 500 } as CompleteSale["tenders"][number],
                  ],
                }
              : cmd,
          ),
        ).then(
          (r) => r.body.invoiceNo,
          (e: unknown) => {
            expect((e as DomainError).code).toBe("PRICE_MISMATCH");
            return undefined;
          },
        );
      }),
    );
    const numbers = results
      .filter((n): n is string => n !== undefined)
      .map((n) => Number(n.slice(4)))
      .sort((a, b) => a - b);
    expect(numbers.length).toBe(100 - bad.size);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });
});
