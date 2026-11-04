import { withTenantTx } from "@wise-biz/db";

import { DigestReadyV1, REPORTING_TOPIC } from "./events.ts";

import type pg from "pg";

/**
 * The daily summary (ADR 0013 job pattern). Each business gets one `reporting.digest.ready` per business date: the
 * marker row is the claim, so replicas and hourly reruns never raise it twice.
 */
export interface DigestJobDeps {
  /** wb_worker pool. */
  readonly pool: pg.Pool;
  readonly ids: { uuidv7(): string };
  readonly now: () => Date;
}

/** Business dates are branch-local and the rollups do not know the zone, so wait until the UTC morning: by 06:00 UTC yesterday is over almost everywhere. */
export const DIGEST_FROM_UTC_HOUR = 6;
const SCAN = 200;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Raises yesterday's digest for every business that sold. Returns how many were raised. */
export async function runDailyDigests(deps: DigestJobDeps): Promise<number> {
  const now = deps.now();
  if (now.getUTCHours() < DIGEST_FROM_UTC_HOUR) return 0;
  const date = isoDay(new Date(now.getTime() - 86_400_000));
  const due = await deps.pool.query<{ tenant_id: string }>(
    `select distinct r.tenant_id from reporting.rollup_day r
      where r.business_date = $1 and r.sales_count > 0
        and not exists (select 1 from reporting.digests d where d.tenant_id = r.tenant_id and d.business_date = $1)
      limit $2`,
    [date, SCAN],
  );
  let raised = 0;
  for (const { tenant_id: tenantId } of due.rows) {
    const done = await withTenantTx(
      deps.pool,
      { tenantId, requestId: "job-reporting-digest" },
      async (tx) => {
        const claim = await tx.query(
          `insert into reporting.digests (tenant_id, business_date) values ($1, $2) on conflict do nothing`,
          [tenantId, date],
        );
        if (claim.rowCount !== 1) return false; // another replica raised it
        const totals = await tx.query<{
          currency: string;
          sales_count: string;
          net: string;
          voids_count: string;
          returns_count: string;
        }>(
          `select currency, sum(sales_count) as sales_count, sum(payable_minor - returns_minor) as net,
                  sum(voids_count) as voids_count, sum(returns_count) as returns_count
             from reporting.rollup_day where tenant_id = $1 and business_date = $2
            group by currency order by currency`,
          [tenantId, date],
        );
        const e = DigestReadyV1.parse({
          id: deps.ids.uuidv7(),
          type: DigestReadyV1.type,
          version: DigestReadyV1.version,
          source: "workers/reporting",
          tenantId,
          subject: `digest/${date}`,
          time: now.toISOString(),
          correlationId: "job-reporting.digest.ready",
          actor: { type: "system", id: "reporting-jobs" },
          data: {
            businessDate: date,
            totals: totals.rows.map((r) => ({
              currency: r.currency,
              salesCount: Number(r.sales_count),
              netMinor: Number(r.net),
              voidsCount: Number(r.voids_count),
              returnsCount: Number(r.returns_count),
            })),
          },
        });
        await tx.query(
          `insert into infra.outbox (tenant_id, id, topic, key, type, version, payload)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            tenantId,
            e.id,
            REPORTING_TOPIC,
            `${tenantId}:digest`,
            e.type,
            e.version,
            JSON.stringify(e),
          ],
        );
        return true;
      },
    );
    if (done) raised += 1;
  }
  return raised;
}
