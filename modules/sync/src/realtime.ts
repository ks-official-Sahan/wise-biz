import {
  constantTimeEqual,
  fromBase64url,
  fromUtf8,
  hmacSha256,
  toBase64url,
  utf8,
} from "@wise-biz/crypto";
import { z } from "zod";

import type { Dataset } from "./datasets.ts";

/**
 * Realtime hints (ADR 0015). A notice only says "this dataset moved"; the terminal then pulls with its cursor, so a
 * lost, early or duplicated notice costs one poll and never data. Channels:
 *   t:{tenant}:all:{dataset}         branch-independent datasets
 *   t:{tenant}:l:{location}:stock_branch   stock of one location (the ticket lists the branch's locations)
 * Redis pub/sub key: `rt:{tenantId}:{channel after the tenant}`.
 */
export const MAX_TICKET_CHANNELS = 64;
const TICKET_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface ChangeNotice {
  readonly tenantId: string;
  /** Channel without the tenant prefix: `all:prices`, `l:{location}:stock_branch`. */
  readonly channel: string;
  readonly dataset: Dataset;
}

export const channelFor = (dataset: Dataset, scopeKey: string): string =>
  scopeKey === "all" ? `all:${dataset}` : `l:${scopeKey}:${dataset}`;

/** Distinct channels touched by a set of change rows (a price change carries hundreds of rows, one notice each). */
export function noticesOf(
  tenantId: string,
  rows: readonly { dataset: Dataset; scopeKey: string }[],
): ChangeNotice[] {
  const seen = new Map<string, ChangeNotice>();
  for (const r of rows) {
    const channel = channelFor(r.dataset, r.scopeKey);
    if (!seen.has(channel)) seen.set(channel, { tenantId, channel, dataset: r.dataset });
  }
  return [...seen.values()];
}

export const redisChannel = (tenantId: string, channel: string): string =>
  `rt:${tenantId}:${channel}`;

/** What a terminal may listen to: every branch-independent dataset plus the stock of its branch's locations. */
export function channelsForBranch(
  datasets: readonly Dataset[],
  locationIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const d of datasets) {
    if (d === "stock_branch") for (const l of locationIds) out.push(channelFor(d, l));
    else out.push(channelFor(d, "all"));
  }
  return out.slice(0, MAX_TICKET_CHANNELS);
}

const Claims = z.object({
  v: z.literal(1),
  tid: z.uuid(),
  /** Device (or user) the ticket was minted for; logged, never trusted for permissions. */
  sub: z.string().min(1).max(64),
  ch: z.array(z.string().min(1).max(120)).max(MAX_TICKET_CHANNELS),
  exp: z.number().int(),
});
export type TicketClaims = z.infer<typeof Claims>;

/**
 * A short-lived, HMAC-signed stream ticket. The API checks permissions once when it mints it; the realtime service
 * only verifies the signature and expiry, so it needs no database and scales out by adding instances.
 */
export function signTicket(secret: string, claims: TicketClaims): string {
  const body = toBase64url(utf8(JSON.stringify(claims)));
  return `${body}.${toBase64url(hmacSha256(utf8(secret), utf8(body)))}`;
}

export function verifyTicket(
  secret: string,
  token: string,
  nowMs: number,
): TicketClaims | undefined {
  if (token.length > 8192 || !TICKET_TOKEN.test(token)) return undefined;
  const [body, mac] = token.split(".") as [string, string];
  const want = hmacSha256(utf8(secret), utf8(body));
  let got: Uint8Array;
  try {
    got = fromBase64url(mac);
  } catch {
    return undefined;
  }
  if (!constantTimeEqual(want, got)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(fromBase64url(body)));
  } catch {
    return undefined;
  }
  const claims = Claims.safeParse(json);
  if (!claims.success || claims.data.exp * 1000 <= nowMs) return undefined;
  return claims.data;
}
