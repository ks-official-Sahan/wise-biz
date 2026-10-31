import { join } from "node:path";

import { generateKeyPair, sign } from "@wise-biz/crypto";
import { countQueries, createPool, instrumentPool, migrate } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { applyBatch, commandHash } from "@wise-biz/module-sync";
import { seedDemoTenant } from "@wise-biz/module-tenancy";
import { createMemoryStore } from "@wise-biz/storage";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSyncMetrics } from "../src/sync-metrics.ts";
import { createSyncPorts } from "../src/sync-ports.ts";

import type { RawCommand } from "@wise-biz/module-sync";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

/**
 * Terminals reconnecting after being offline and pushing their outbox (P1-06 acceptance: no loss, p95 apply latency,
 * throughput). In-process (the signed commands go through applyBatch into the real schemas), so it measures the
 * server's apply path without HTTP. Defaults are small enough for `pnpm check`; scale it for the real number:
 *   SYNC_BURST_DEVICES=1000 SYNC_BURST_COMMANDS=500 SYNC_BURST_CONCURRENCY=32 pnpm -F @wise-biz/api test sync-burst
 * The HTTP path (request signatures, nonces, JSON) is covered by load/k6/sync-burst.js.
 */
const DEVICES = Number(process.env.SYNC_BURST_DEVICES ?? 20);
const COMMANDS = Number(process.env.SYNC_BURST_COMMANDS ?? 100);
const CONCURRENCY = Number(process.env.SYNC_BURST_CONCURRENCY ?? 8);
const DEVICES_PER_BRANCH = 5;
const BATCH = 100;

const modulesDir = join(import.meta.dirname, "..", "..", "..", "modules");
const T = uuidv7();
const OWNER = uuidv7();
const CASHIER = uuidv7();
const LIST = uuidv7();
const VARIANT = uuidv7();
const LOC = uuidv7();
const TODAY = new Date().toISOString().slice(0, 10);
const GENESIS = Buffer.alloc(32).toString("base64");

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
let policyVersion = 0;
const branches: string[] = [];

beforeAll(async () => {
  db = await testDatabase();
  await migrate(
    db.url("migrator"),
    ["infra", "audit", "tenancy", "devices", "pricing", "inventory", "sales", "sync"].map(
      (module) => ({ module, dir: join(modulesDir, module, "migrations") }),
    ),
  );
  pool = createPool(db.url("app"), { max: CONCURRENCY + 4 });
  instrumentPool(pool);
  admin = createPool(db.url("admin"));
  await seedDemoTenant(pool, {
    tenantId: T,
    ownerUserId: OWNER,
    members: [{ userId: CASHIER, roles: ["cashier"], scope: "all" }],
    now: new Date(),
    ids: { uuidv7 },
    requestId: "req-12345678",
  });
  const first = (
    await admin.query<{ id: string }>(
      "select id from tenancy.branches where tenant_id = $1 order by id limit 1",
      [T],
    )
  ).rows[0]?.id;
  branches.push(first ?? "");
  // Gapless invoice numbers serialize one branch, so a realistic burst spreads devices over branches.
  for (let i = 1; i < Math.ceil(DEVICES / DEVICES_PER_BRANCH); i++) {
    const id = uuidv7();
    await admin.query(
      `insert into tenancy.branches (id, tenant_id, name, kind, timezone, currency, tax_region)
       select $1, tenant_id, 'Branch ' || $3, kind, timezone, currency, tax_region from tenancy.branches
       where tenant_id = $2 and id = $4`,
      [id, T, String(i), first],
    );
    branches.push(id);
  }
  const region = uuidv7();
  await admin.query(
    `insert into pricing.tax_regions (id, tenant_id, code, name, inclusive, strategy) values ($1, $2, 'lk', 'LK', false, 'per-line')`,
    [region, T],
  );
  await admin.query(
    `insert into pricing.tax_rules (tenant_id, region_id, name, rate_bps, categories, ord) values ($1, $2, 'VAT', 1000, '{standard}', 0)`,
    [T, region],
  );
  await admin.query(
    `insert into pricing.price_lists (id, tenant_id, name, currency, tax_region_id) values ($1, $2, 'Retail', 'LKR', $3)`,
    [LIST, T, region],
  );
  await admin.query(
    "insert into pricing.prices (tenant_id, price_list_id, variant_id, price_minor) values ($1, $2, $3, 500)",
    [T, LIST, VARIANT],
  );
  await admin.query(
    `insert into pricing.variant_facts (tenant_id, variant_id, tax_category, source_time) values ($1, $2, 'standard', now())`,
    [T, VARIANT],
  );
  policyVersion = Number(
    (
      await admin.query<{ v: number }>(
        "select permissions_version v from tenancy.tenants where tenant_id = $1",
        [T],
      )
    ).rows[0]?.v,
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await db.drop();
});

/** One terminal: its own key, chain and outbox of an open shift followed by sales. */
function terminal(branchId: string) {
  const keys = generateKeyPair();
  const deviceId = uuidv7();
  let seq = 0;
  let last = GENESIS;
  const signed = (type: string, body: Record<string, unknown>): RawCommand => {
    const hash = commandHash(
      type,
      seq,
      body as RawCommand["body"],
      new Uint8Array(Buffer.from(last, "base64")),
    );
    const meta = {
      deviceSeq: seq,
      prevHash: last,
      hash: Buffer.from(hash).toString("base64"),
      signature: Buffer.from(sign(hash, keys.secretKey)).toString("base64"),
    };
    seq += 1;
    last = meta.hash;
    return { type, body: { ...body, meta } };
  };
  const shiftId = uuidv7();
  const outbox: RawCommand[] = [
    signed("open_shift", {
      id: shiftId,
      operatorId: CASHIER,
      businessDate: TODAY,
      openedAt: new Date().toISOString(),
      currency: "LKR",
      openingFloatMinor: 0,
    }),
  ];
  for (let n = 1; n < COMMANDS; n++) {
    outbox.push(
      signed("complete_sale", {
        id: uuidv7(),
        shiftId,
        operatorId: CASHIER,
        saleNo: n,
        currency: "LKR",
        businessDate: TODAY,
        completedAt: new Date().toISOString(),
        priceListId: LIST,
        priceListVersion: 1,
        engineVersion: "1.0.0",
        policyVersion,
        promotionIds: [],
        lines: [
          {
            variantId: VARIANT,
            name: "Tea",
            sku: "TEA",
            locationId: LOC,
            qty: "2",
            unitPriceMinor: 500,
            priceSource: "list",
            discountMinor: 0,
            taxMinor: 100,
            totalMinor: 1100,
          },
        ],
        tenders: [{ id: uuidv7(), kind: "cash", amountMinor: 1100 }],
        subtotalMinor: 1000,
        discountMinor: 0,
        feeMinor: 0,
        taxMinor: 100,
        totalMinor: 1100,
        cashRoundingMinor: 0,
        payableMinor: 1100,
      }),
    );
  }
  return { keys, deviceId, branchId, outbox };
}

describe("sync burst", () => {
  it(
    "applies every command of every reconnecting device with no loss",
    { timeout: 3_600_000 },
    async () => {
      const metrics: { ms: number[]; stopped: number } = { ms: [], stopped: 0 };
      const window = createSyncMetrics({ info: () => undefined });
      const deps = {
        ...createSyncPorts(createMemoryStore(), (name, value, labels) => {
          window.onMetric(name, value, labels);
          if (name === "sync_apply_ms") metrics.ms.push(value);
          if (name === "sync_stopped") metrics.stopped++;
        }),
        pool,
        clock: { now: () => Date.now() },
        ids: { uuidv7 },
      };
      const fleet = Array.from({ length: DEVICES }, (_, i) =>
        terminal(branches[Math.floor(i / DEVICES_PER_BRANCH)] ?? ""),
      );
      for (const t of fleet) {
        await admin.query(
          `insert into devices.devices (id, tenant_id, branch_id, name, platform, app_version, status, public_key, enrolled_by)
           values ($1, $2, $3, 'Till', 'linux', '1.0.0', 'active', $4, $5)`,
          [t.deviceId, T, t.branchId, Buffer.from(t.keys.publicKey), OWNER],
        );
      }

      // The first device sends two commands up front only to count statements; the loop below replays them.
      const probe = fleet[0];
      let perSale = 0;
      if (probe !== undefined && probe.outbox.length > 2) {
        const counted = await countQueries(() =>
          applyBatch(
            deps,
            { tenantId: T, deviceId: probe.deviceId, branchId: probe.branchId },
            "req-12345678",
            probe.outbox.slice(0, 2),
          ),
        );
        // open_shift + one sale: subtract the shift's ~12 statements for a per-sale figure.
        perSale = counted.count;
      }
      const statuses = new Map<string, number>();
      const started = performance.now();
      let next = 0;
      const worker = async () => {
        for (;;) {
          const t = fleet[next++];
          if (t === undefined) return;
          for (let i = 0; i < t.outbox.length; i += BATCH) {
            const r = await applyBatch(
              deps,
              { tenantId: T, deviceId: t.deviceId, branchId: t.branchId },
              "req-12345678",
              t.outbox.slice(i, i + BATCH),
            );
            expect(r.stopped).toBeNull();
            for (const a of r.acks) statuses.set(a.status, (statuses.get(a.status) ?? 0) + 1);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, DEVICES) }, worker));
      const seconds = (performance.now() - started) / 1000;

      const total = DEVICES * COMMANDS;
      expect(statuses.get("applied")).toBe(total - Math.min(2, COMMANDS));
      expect(metrics.stopped).toBe(0);
      const sales = Number(
        (
          await admin.query<{ n: string }>(
            "select count(*) n from sales.sales where tenant_id = $1 and status = 'completed'",
            [T],
          )
        ).rows[0]?.n,
      );
      expect(sales).toBe(DEVICES * (COMMANDS - 1));
      const chain = await admin.query<{ n: string; min: string; max: string }>(
        "select count(*) n, min(last_seq) min, max(last_seq) max from sync.device_sync_state where tenant_id = $1",
        [T],
      );
      expect(chain.rows[0]).toEqual({
        n: String(DEVICES),
        min: String(COMMANDS - 1),
        max: String(COMMANDS - 1),
      });

      const sorted = [...metrics.ms].sort((a, b) => a - b);
      const q = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
      process.stderr.write(
        `sync-burst: ${String(DEVICES)} devices x ${String(COMMANDS)} commands = ${String(total)} applied, 0 lost; ` +
          `${String(Math.round(total / seconds))} commands/s over ${seconds.toFixed(1)}s ` +
          `(concurrency ${String(CONCURRENCY)}); apply p50 ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, ` +
          `max ${(sorted.at(-1) ?? 0).toFixed(1)} ms; ${String(perSale)} statements for a shift open plus one sale
`,
      );
    },
  );
});
