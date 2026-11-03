import { createGzip } from "node:zlib";

import { withTenantTx } from "@wise-biz/db";
import { tenantKey } from "@wise-biz/storage";

import { REPORTING_TOPIC, ExportReadyV1 } from "./events.ts";
import { csvCell } from "./queries.ts";

import type { ObjectStore } from "@wise-biz/storage";
import type pg from "pg";

/**
 * Builds requested export files (ADR 0013 job pattern, same as inventory and devices): the scan reads across businesses
 * with the wb_worker pool, every write is a tenant-scoped transaction, and the claim is one atomic UPDATE so two
 * replicas never build the same file.
 */
export interface ExportJobDeps {
  /** wb_worker pool. */
  readonly pool: pg.Pool;
  readonly store: ObjectStore;
  readonly ids: { uuidv7(): string };
  readonly now: () => Date;
}

/** Hard ceiling: past this the request fails and asks for a shorter period (the file is gzipped in memory). */
export const MAX_EXPORT_ROWS = 1_000_000;
const PAGE = 2000;
const STALE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
const SCAN = 20;

const HEADER = [
  "business date",
  "sale",
  "status",
  "branch",
  "terminal",
  "operator",
  "sku",
  "qty",
  "discount",
  "tax",
  "total",
  "payments",
] as const;

interface Params {
  from: string;
  to: string;
  branchIds: string[] | null;
}

class TooLarge extends Error {}

interface SaleRow {
  sale_id: string;
  business_date: string;
  status: string;
  branch_id: string;
  terminal_id: string;
  operator_id: string | null;
  lines: {
    sku: string;
    qty: string;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
  }[];
  tenders: { kind: string; amountMinor: number }[];
}

/** Runs every open export once. Returns how many files were built. */
export async function runExports(deps: ExportJobDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - STALE_MS);
  const open = await deps.pool.query<{ tenant_id: string; id: string }>(
    `select tenant_id, id from reporting.exports
      where status = 'queued' or (status = 'running' and started_at < $1)
      order by created_at limit $2`,
    [cutoff, SCAN],
  );
  let built = 0;
  for (const j of open.rows) if (await build(deps, j.tenant_id, j.id, cutoff)) built += 1;
  return built;
}

async function build(
  deps: ExportJobDeps,
  tenantId: string,
  id: string,
  cutoff: Date,
): Promise<boolean> {
  const ctx = { tenantId, requestId: "job-reporting-export" };
  const claimed = await withTenantTx(deps.pool, ctx, async (tx) => {
    const r = await tx.query<{ params: Params; attempts: number }>(
      `update reporting.exports set status = 'running', started_at = $3, attempts = attempts + 1
        where tenant_id = $1 and id = $2
          and (status = 'queued' or (status = 'running' and started_at < $4))
        returning params, attempts`,
      [tenantId, id, deps.now(), cutoff],
    );
    return r.rows[0];
  });
  if (claimed === undefined) return false; // another replica took it
  if (claimed.attempts > MAX_ATTEMPTS) {
    await fail(
      deps,
      tenantId,
      id,
      "The file could not be built after several tries. Request it again.",
    );
    return false;
  }
  try {
    const { bytes, rows } = await render(deps, tenantId, claimed.params);
    const key = tenantKey(tenantId, "exports", `${id}.csv.gz`);
    await deps.store.put(key, bytes, "application/gzip");
    await withTenantTx(deps.pool, ctx, async (tx) => {
      const r = await tx.query<{ requested_by: string; kind: string }>(
        `update reporting.exports set status = 'ready', row_count = $3, object_key = $4, finished_at = $5
          where tenant_id = $1 and id = $2 and status = 'running' returning requested_by, kind`,
        [tenantId, id, rows, key, deps.now()],
      );
      const row = r.rows[0];
      if (row === undefined) return; // lost the job to a newer attempt: the file holds the same bytes
      const e = ExportReadyV1.parse({
        id: deps.ids.uuidv7(),
        type: ExportReadyV1.type,
        version: ExportReadyV1.version,
        source: "workers/reporting",
        tenantId,
        subject: `export/${id}`,
        time: deps.now().toISOString(),
        correlationId: "job-reporting.export.ready",
        actor: { type: "system", id: "reporting-jobs" },
        data: { exportId: id, requestedBy: row.requested_by, kind: row.kind, rowCount: rows },
      });
      await tx.query(
        `insert into infra.outbox (tenant_id, id, topic, key, type, version, payload)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          tenantId,
          e.id,
          REPORTING_TOPIC,
          `${tenantId}:${id}`,
          e.type,
          e.version,
          JSON.stringify(e),
        ],
      );
    });
    return true;
  } catch (err) {
    await fail(
      deps,
      tenantId,
      id,
      err instanceof TooLarge
        ? "Too many rows for one file. Choose a shorter period or one branch."
        : "The file could not be built. Try again; if it keeps failing, contact support.",
    );
    return false;
  }
}

async function fail(
  deps: ExportJobDeps,
  tenantId: string,
  id: string,
  message: string,
): Promise<void> {
  await withTenantTx(deps.pool, { tenantId, requestId: "job-reporting-export" }, (tx) =>
    tx.query(
      `update reporting.exports set status = 'failed', error = $3, finished_at = $4
        where tenant_id = $1 and id = $2 and status = 'running'`,
      [tenantId, id, message, deps.now()],
    ),
  );
}

/** One CSV line per sale line, read in keyset pages (one short transaction each) and gzipped as it goes. */
async function render(
  deps: ExportJobDeps,
  tenantId: string,
  p: Params,
): Promise<{ bytes: Uint8Array; rows: number }> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  const write = (cells: readonly (string | number)[]) => {
    gzip.write(`${cells.map(csvCell).join(",")}\n`);
  };
  write(HEADER);

  let rows = 0;
  let afterDate = "0001-01-01";
  let afterSale = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await withTenantTx(
      deps.pool,
      { tenantId, requestId: "job-reporting-export" },
      async (tx) =>
        (
          await tx.query<SaleRow>(
            `select sale_id, business_date::text as business_date, status, branch_id, terminal_id, operator_id, lines,
                    tenders
               from reporting.sale_facts
              where tenant_id = $1 and business_date between $2 and $3
                and ($4::uuid[] is null or branch_id = any($4::uuid[]))
                and (business_date, sale_id) > ($5::date, $6::uuid)
              order by business_date, sale_id limit $7`,
            [tenantId, p.from, p.to, p.branchIds, afterDate, afterSale, PAGE],
          )
        ).rows,
    );
    for (const s of page) {
      const pay = s.tenders.map((t) => `${t.kind} ${String(t.amountMinor)}`).join("; ");
      for (const l of s.lines) {
        rows += 1;
        if (rows > MAX_EXPORT_ROWS) throw new TooLarge();
        write([
          s.business_date,
          s.sale_id,
          s.status,
          s.branch_id,
          s.terminal_id,
          s.operator_id ?? "",
          l.sku,
          l.qty,
          l.discountMinor,
          l.taxMinor,
          l.totalMinor,
          pay,
        ]);
      }
    }
    const last = page.at(-1);
    if (page.length < PAGE || last === undefined) break;
    afterDate = last.business_date;
    afterSale = last.sale_id;
  }
  gzip.end();
  await done;
  return { bytes: Buffer.concat(chunks), rows };
}
