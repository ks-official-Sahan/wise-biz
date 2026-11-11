import { utcDate } from "./expiry.ts";

/**
 * FEFO compliance (P2-04c). Pure: the caller loads the rows, this function decides.
 *
 * Rule. An outflow (sale or transfer out, negative qty, from one batch at one location) is a FEFO violation when, at its
 * instant, another batch of the same variant at the same location (a) expires strictly earlier than the batch it took
 * from (a batch without expiry sorts last, like selectBatchesFefo), (b) has not expired on the sale's UTC date (expired
 * stock is skipped by FEFO, so it is not a violation), and (c) held stock after that instant (balance > 0). The balance
 * at an instant t is the batch's current balance minus the movements dated after t (inclusive of t), so only movements
 * since the report start are needed.
 */

export interface FefoBatchRow {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId: string;
  /** `YYYY-MM-DD` or null (no expiry). */
  readonly expiresOn: string | null;
  /** Current on-hand qty4 of the batch at the location (may be negative after an offline oversell). */
  readonly currentQty4: bigint;
}

export interface FefoMovementRow {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId: string;
  readonly occurredAt: number;
  readonly qty4: bigint;
}

export interface FefoOutflowRow extends FefoMovementRow {
  readonly expiresOn: string | null;
}

export interface FefoVariantRow {
  readonly variantId: string;
  readonly outflows: number;
  readonly violations: number;
  /** Absolute qty4 of the violating outflows. */
  readonly violatedQty4: bigint;
}

export interface FefoInput {
  /** Inclusive start, exclusive end (epoch ms). Only outflows inside it are judged. */
  readonly fromMs: number;
  readonly toMs: number;
  readonly outflows: readonly FefoOutflowRow[];
  /** Every batch at the locations/variants of the outflows (zero-balance batches included). */
  readonly batches: readonly FefoBatchRow[];
  /** Every batch movement dated at or after fromMs at those locations/variants. */
  readonly movements: readonly FefoMovementRow[];
}

const sep = "\u0001";
const pairKey = (loc: string, variant: string): string => `${loc}${sep}${variant}`;
const batchKey = (loc: string, variant: string, batch: string): string =>
  `${loc}${sep}${variant}${sep}${batch}`;

/** One batch's movements sorted by time, with suffix sums: the balance after any instant is a binary search away. */
interface Timeline {
  readonly times: readonly number[];
  /** suffix[i] = sum of qty4 of movements i..end; suffix[length] = 0. */
  readonly suffix: readonly bigint[];
  readonly current: bigint;
}

function buildTimelines(
  batches: readonly FefoBatchRow[],
  movements: readonly FefoMovementRow[],
): Map<string, Timeline> {
  const byBatch = new Map<string, FefoMovementRow[]>();
  for (const m of movements) {
    const k = batchKey(m.locationId, m.variantId, m.batchId);
    const list = byBatch.get(k);
    if (list === undefined) byBatch.set(k, [m]);
    else list.push(m);
  }
  const out = new Map<string, Timeline>();
  for (const b of batches) {
    const k = batchKey(b.locationId, b.variantId, b.batchId);
    const list = (byBatch.get(k) ?? []).sort((x, y) => x.occurredAt - y.occurredAt);
    const suffix: bigint[] = new Array<bigint>(list.length + 1);
    suffix[list.length] = 0n;
    for (let i = list.length - 1; i >= 0; i--) {
      suffix[i] = (suffix[i + 1] ?? 0n) + (list[i]?.qty4 ?? 0n);
    }
    out.set(k, {
      times: list.map((m) => m.occurredAt),
      suffix,
      current: b.currentQty4,
    });
  }
  return out;
}

/** Index of the first movement strictly after t (binary search over sorted times). */
function firstAfter(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Balance of a batch at instant t (movements dated at or before t). */
function balanceAt(tl: Timeline, t: number): bigint {
  return tl.current - (tl.suffix[firstAfter(tl.times, t)] ?? 0n);
}

const isEarlier = (e1: string, e2: string | null): boolean => e2 === null || e1 < e2;

export function fefoCompliance(input: FefoInput): FefoVariantRow[] {
  const timelines = buildTimelines(input.batches, input.movements);
  // Candidate earlier batches per (location, variant), each with an expiry: the only batches that can be violated for.
  const candidates = new Map<string, FefoBatchRow[]>();
  for (const b of input.batches) {
    if (b.expiresOn === null) continue;
    const k = pairKey(b.locationId, b.variantId);
    const list = candidates.get(k);
    if (list === undefined) candidates.set(k, [b]);
    else list.push(b);
  }

  const perVariant = new Map<
    string,
    { outflows: number; violations: number; violatedQty4: bigint }
  >();
  for (const o of input.outflows) {
    if (o.occurredAt < input.fromMs || o.occurredAt >= input.toMs || o.qty4 >= 0n) continue;
    const row = perVariant.get(o.variantId) ?? { outflows: 0, violations: 0, violatedQty4: 0n };
    row.outflows += 1;
    perVariant.set(o.variantId, row);
    const saleDate = utcDate(o.occurredAt);
    const violated = (candidates.get(pairKey(o.locationId, o.variantId)) ?? []).some((c) => {
      if (c.batchId === o.batchId) return false;
      if (c.expiresOn === null || c.expiresOn < saleDate) return false;
      if (!isEarlier(c.expiresOn, o.expiresOn)) return false;
      const tl = timelines.get(batchKey(c.locationId, c.variantId, c.batchId));
      return tl !== undefined && balanceAt(tl, o.occurredAt) > 0n;
    });
    if (violated) {
      row.violations += 1;
      row.violatedQty4 += -o.qty4;
    }
  }
  return [...perVariant.entries()]
    .map(([variantId, r]) => ({ variantId, ...r }))
    .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
}
