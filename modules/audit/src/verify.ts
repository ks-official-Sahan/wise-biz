import { GENESIS_HASH, verifyChain } from "@wise-biz/audit-chain";
import { loadChain } from "@wise-biz/db";

import type { VerifyFailure } from "@wise-biz/audit-chain";
import type pg from "pg";

export type AuditVerifyResult =
  | {
      ok: true;
      /** Always true: verification is against a stored anchor. */
      anchored: true;
      head: string;
      length: number;
      anchorDay: string;
      fromSeq: number;
      toSeq: number;
    }
  | {
      ok: false;
      reason: VerifyFailure | "seq_gap" | "no_anchor";
      /** chain_seq of the first broken row (null when rows are missing or there is no anchor). */
      chainSeq: number | null;
    };

interface AnchorRow {
  day: string;
  chain_seq_to: string;
  head_hash: string;
}

/**
 * Verify one tenant's chain against its LATEST stored anchor (expectedHead = anchor.head_hash,
 * expectedLength = chain_seq_to). Default window is genesis..anchor (full). `incremental: true` verifies only
 * the window since the previous anchor, starting from that anchor's head (bounded cost for a nightly job; older
 * windows were verified when their own anchor was current). Takes a wb_chainer pool.
 */
export async function verifyAuditChain(
  pool: pg.Pool,
  tenantId: string,
  opts: { incremental?: boolean } = {},
): Promise<AuditVerifyResult> {
  const anchors = await pool.query<AnchorRow>(
    `select day::text, chain_seq_to::text, head_hash from audit.anchors
     where tenant_id = $1 order by day desc limit 2`,
    [tenantId],
  );
  const latest = anchors.rows[0];
  if (latest === undefined) return { ok: false, reason: "no_anchor", chainSeq: null };
  const prev = opts.incremental === true ? anchors.rows[1] : undefined;
  const to = Number(latest.chain_seq_to);
  const from = prev === undefined ? 1 : Number(prev.chain_seq_to) + 1;
  const rows = await loadChain(pool, tenantId, { fromSeq: from, toSeq: to });
  for (let i = 0; i < rows.length; i++) {
    const seq = rows[i]?.chainSeq;
    if (seq !== from + i) return { ok: false, reason: "seq_gap", chainSeq: seq ?? null };
  }
  const res = verifyChain(rows, {
    startHash: prev?.head_hash ?? GENESIS_HASH,
    expectedHead: latest.head_hash,
    expectedLength: to - from + 1,
  });
  if (!res.ok) {
    return { ok: false, reason: res.reason, chainSeq: rows[res.index]?.chainSeq ?? null };
  }
  return {
    ok: true,
    anchored: true,
    head: res.head,
    length: res.length,
    anchorDay: latest.day,
    fromSeq: from,
    toSeq: to,
  };
}
