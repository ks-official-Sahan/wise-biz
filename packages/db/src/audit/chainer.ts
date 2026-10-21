import { GENESIS_HASH, link } from "@wise-biz/audit-chain";

import { isUuidV7, run } from "../tx.ts";

import { PAYLOAD_COLUMNS, auditPayload } from "./rows.ts";

import type { PayloadRow } from "./rows.ts";
import type pg from "pg";

const TENANT_SETTING = "select set_config('app.tenant_id', $1, true)";

/**
 * Tenants that have unchained rows (hash IS NULL), via a skip-scan over the partial work-queue index
 * (one index probe per tenant, not a scan of every unchained row). Takes a wb_chainer pool.
 * Ordered by tenant_id and capped at `limit`; the caller drains in passes.
 */
export async function listTenantsWithUnchained(
  pool: Pick<pg.Pool, "query">,
  limit: number,
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be an integer >= 1");
  const res = await pool.query<{ tenant_id: string }>(
    `with recursive t(tenant_id) as (
       (select tenant_id from audit.audit_log where hash is null order by tenant_id limit 1)
       union all
       select (select a.tenant_id from audit.audit_log a where a.hash is null and a.tenant_id > t.tenant_id order by a.tenant_id limit 1)
       from t where t.tenant_id is not null
     )
     select tenant_id::text from t where tenant_id is not null limit $1`,
    [limit],
  );
  return res.rows.map((r) => r.tenant_id);
}

interface HeadRow {
  chain_seq: string;
  head_hash: string;
}

/**
 * Chain up to `batch` unchained rows of one tenant, in ONE transaction, with a wb_chainer pool.
 * The chain_heads row lock serialises concurrent chainers of the same tenant (second waits, then continues from the
 * new head), so chain_seq is contiguous and unique. Rows are taken in identity-id order among those visible
 * (committed); a row that commits later is simply chained in a later pass with a higher chain_seq.
 * Returns the number chained and the head hash after this pass.
 */
export async function chainTenant(
  pool: pg.Pool,
  tenantId: string,
  opts: { batch?: number } = {},
): Promise<{ chained: number; head: string }> {
  if (!isUuidV7(tenantId)) throw new Error("chainTenant: tenantId must be a UUIDv7");
  const batch = opts.batch ?? 1000;
  if (!Number.isInteger(batch) || batch < 1) throw new Error("batch must be an integer >= 1");
  return run(pool, TENANT_SETTING, [tenantId], async (tx) => {
    const lockHead = async (): Promise<HeadRow | undefined> =>
      (
        await tx.query<HeadRow>(
          "select chain_seq::text, head_hash from audit.chain_heads where tenant_id = $1 for update",
          [tenantId],
        )
      ).rows[0];
    let head = await lockHead();
    if (head === undefined) {
      await tx.query(
        "insert into audit.chain_heads (tenant_id, chain_seq, head_hash) values ($1, 0, $2) on conflict (tenant_id) do nothing",
        [tenantId, GENESIS_HASH],
      );
      head = await lockHead();
    }
    if (head === undefined) throw new Error("chainTenant: chain head missing");

    const todo = await tx.query<PayloadRow>(
      `select ${PAYLOAD_COLUMNS} from audit.audit_log
       where tenant_id = $1 and hash is null order by audit_log.id limit $2 for update skip locked`,
      [tenantId, batch],
    );
    if (todo.rows.length === 0) return { chained: 0, head: head.head_hash };

    let seq = Number(head.chain_seq);
    let prev = head.head_hash;
    const ids: string[] = [];
    const ats: string[] = [];
    const seqs: string[] = [];
    const prevs: string[] = [];
    const hashes: string[] = [];
    for (const row of todo.rows) {
      seq += 1;
      const hash = link(prev, auditPayload(row));
      ids.push(row.id);
      ats.push(row.at);
      seqs.push(String(seq));
      prevs.push(prev);
      hashes.push(hash);
      prev = hash;
    }
    // Rendered `at` strings share one fixed-width UTC format, so lexicographic min/max == chronological min/max.
    // The BETWEEN bounds let the planner prune the UPDATE to the partitions the batch actually touches.
    const minAt = ats.reduce((m, x) => (x < m ? x : m));
    const maxAt = ats.reduce((m, x) => (x > m ? x : m));
    // `at` is part of the join so the update prunes to the right partitions and uses the (tenant_id, at, id) PK.
    const upd = await tx.query(
      `update audit.audit_log a set chain_seq = v.seq, prev_hash = v.prev, hash = v.hash
       from unnest($2::bigint[], $3::timestamptz[], $4::bigint[], $5::text[], $6::text[]) as v(id, at, seq, prev, hash)
       where a.tenant_id = $1 and a.at = v.at and a.id = v.id and a.hash is null
         and a.at between $7::timestamptz and $8::timestamptz`,
      [tenantId, ids, ats, seqs, prevs, hashes, minAt, maxAt],
    );
    if (upd.rowCount !== todo.rows.length)
      throw new Error("chainTenant: updated row count mismatch");
    await tx.query(
      "update audit.chain_heads set chain_seq = $2, head_hash = $3, updated_at = now() where tenant_id = $1",
      [tenantId, String(seq), prev],
    );
    return { chained: todo.rows.length, head: prev };
  });
}
