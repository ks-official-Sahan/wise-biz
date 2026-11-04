import { DRAWER_KICK_BYTES } from "@wise-biz/hardware";

import type { TenderEntry } from "./tender.ts";

/**
 * The bytes for one print job: the receipt, followed by the drawer pulse when any cash changed hands (a refund or a
 * card-only sale never opens the drawer). One job means the pulse cannot reach a printer that lost the receipt.
 */
export function receiptJob(
  receipt: Uint8Array,
  tenders: readonly Pick<TenderEntry, "kind">[],
): Uint8Array {
  if (!tenders.some((t) => t.kind === "cash")) return receipt;
  const out = new Uint8Array(receipt.length + DRAWER_KICK_BYTES.length);
  out.set(receipt, 0);
  out.set(DRAWER_KICK_BYTES, receipt.length);
  return out;
}
