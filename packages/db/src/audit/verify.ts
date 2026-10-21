import { merkleRoot, verifyChain } from "@wise-biz/audit-chain";

import { isUuidV7, run } from "../tx.ts";

import { PAYLOAD_COLUMNS, auditPayload } from "./rows.ts";

import type { PayloadRow } from "./rows.ts";
import type { ChainHash, ChainRow, VerifyFailure } from "@wise-biz/audit-chain";
import type pg from "pg";

export type AuditChainRow = ChainRow & Readonly<{ chainSeq: number }>;

export type TenantVerifyResult =
  | { ok: true; head: ChainHash; length: number; anchored: boolean }
  | { ok: false; index: number; reason: VerifyFailure | "seq_gap"; chainSeq: number | null };

export type AuditAnchor = Readonly<{
  tenantId: string;
  day: string;
  chainSeqFrom: number;
  chainSeqTo: number;
  rowCount: number;
  merkleRoot: string;
  headHash: string;
}>;

export type AnchorResult =
  { status: "created" | "exists"; anchor: AuditAnchor } | { status: "empty" | "pending" };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type ChainedRow = PayloadRow & { chain_seq: string; prev_hash: string; hash: string };

/**
 * Chained rows of a tenant ordered by chain_seq (optionally a [fromSeq, toSeq] window), payload rebuilt from the
 * current column values. Takes a wb_chainer (or any role that can read audit_log) pool.
 */
export async function loadChain(
  pool: Pick<pg.Pool, "query">,
  tenantId: string,
  opts: { fromSeq?: number; toSeq?: number } = {},
): Promise<AuditChainRow[]> {
  if (!isUuidV7(tenantId)) throw new Error("loadChain: tenantId must be a UUIDv7");
  const params: unknown[] = [tenantId];
  let where = "tenant_id = $1 and chain_seq is not null";
  for (const [col, op, v] of [
    ["fromSeq", ">=", opts.fromSeq],
    ["toSeq", "<=", opts.toSeq],
  ] as const) {
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 1) throw new Error(`${col} must be an integer >= 1`);
    params.push(v);
    where += ` and chain_seq ${op} $${String(params.length)}`;
  }
  const res = await pool.query<ChainedRow>(
    `select ${PAYLOAD_COLUMNS}, chain_seq::text, prev_hash, hash from audit.audit_log where ${where} order by audit_log.chain_seq`,
    params,
  );
  return res.rows.map((r) => ({
    chainSeq: Number(r.chain_seq),
    payload: auditPayload(r),
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}

/**
 * Verify a tenant's whole chain: chain_seq contiguity (1..n) then hashes via verifyChain. Pass `expectedHead` /
 * `expectedLength` from a trusted anchor: without them tail truncation and a consistently re-hashed chain are
 * undetectable (the chain is unkeyed).
 */
export async function verifyTenantChain(
  pool: Pick<pg.Pool, "query">,
  tenantId: string,
  opts: { expectedHead?: string; expectedLength?: number } = {},
): Promise<TenantVerifyResult> {
  const rows = await loadChain(pool, tenantId);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined && row.chainSeq !== i + 1)
      return { ok: false, index: i, reason: "seq_gap", chainSeq: row.chainSeq };
  }
  const res = verifyChain(rows, opts);
  if (res.ok) return res;
  return {
    ok: false,
    index: res.index,
    reason: res.reason,
    chainSeq: rows[res.index]?.chainSeq ?? null,
  };
}

interface AnchorRow {
  chain_seq_from: string;
  chain_seq_to: string;
  row_count: number;
  merkle_root: string;
  head_hash: string;
}

/**
 * Daily (UTC) Merkle anchor of a tenant's chain hashes by chain_seq. Idempotent (an existing anchor is returned,
 * never rewritten). "pending" while any row up to the end of that day is still unchained (so a late-committing row can
 * never be missing from a stored anchor); "empty" when the day has no chained rows. wb_chainer pool.
 */
export async function buildDailyAnchor(
  pool: pg.Pool,
  tenantId: string,
  day: string,
): Promise<AnchorResult> {
  if (!isUuidV7(tenantId)) throw new Error("buildDailyAnchor: tenantId must be a UUIDv7");
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))
    throw new Error("day must be YYYY-MM-DD");
  const lo = `${day}T00:00:00Z`;
  const hi = new Date(Date.parse(lo) + 86_400_000).toISOString();
  return run(pool, "select set_config('app.tenant_id', $1, true)", [tenantId], async (tx) => {
    const pending = await tx.query(
      "select 1 from audit.audit_log where tenant_id = $1 and hash is null and at < $2::timestamptz limit 1",
      [tenantId, hi],
    );
    if (pending.rows.length > 0) return { status: "pending" } as const;
    const rows = await tx.query<{ chain_seq: string; hash: string }>(
      `select chain_seq::text, hash from audit.audit_log
       where tenant_id = $1 and chain_seq is not null and at >= $2::timestamptz and at < $3::timestamptz
       order by audit_log.chain_seq`,
      [tenantId, lo, hi],
    );
    const first = rows.rows[0];
    const last = rows.rows[rows.rows.length - 1];
    if (first === undefined || last === undefined) return { status: "empty" } as const;
    const root = merkleRoot(rows.rows.map((r) => r.hash));
    const toAnchor = (r: AnchorRow): AuditAnchor => ({
      tenantId,
      day,
      chainSeqFrom: Number(r.chain_seq_from),
      chainSeqTo: Number(r.chain_seq_to),
      rowCount: r.row_count,
      merkleRoot: r.merkle_root,
      headHash: r.head_hash,
    });
    const cols = "chain_seq_from::text, chain_seq_to::text, row_count, merkle_root, head_hash";
    const ins = await tx.query<AnchorRow>(
      `insert into audit.anchors (tenant_id, day, chain_seq_from, chain_seq_to, row_count, merkle_root, head_hash)
       values ($1, $2::date, $3, $4, $5, $6, $7) on conflict (tenant_id, day) do nothing returning ${cols}`,
      [tenantId, day, first.chain_seq, last.chain_seq, rows.rows.length, root, last.hash],
    );
    const created = ins.rows[0];
    if (created !== undefined) return { status: "created", anchor: toAnchor(created) } as const;
    const existing = await tx.query<AnchorRow>(
      `select ${cols} from audit.anchors where tenant_id = $1 and day = $2::date`,
      [tenantId, day],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error("buildDailyAnchor: anchor vanished");
    return { status: "exists", anchor: toAnchor(row) } as const;
  });
}
