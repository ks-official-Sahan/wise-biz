import { isUuidV7, run } from "./tx.ts";

import type { TxHandle } from "./tx.ts";
import type pg from "pg";

export type PlatformCtx = Readonly<{ reason: string; requestId: string; actorId: string }>;

const PLATFORM_SQL =
  "select set_config('app.platform', 'on', true), set_config('app.platform_reason', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)";

// No control (Cc) or format (Cf) characters: keeps the reason log/audit safe and single-line.
const PRINTABLE = /^[^\p{Cc}\p{Cf}]+$/u;

/**
 * PLATFORM-ONLY (staff/back-office, cross-tenant support). Import from `@wise-biz/db/platform`;
 * tenant-facing code must never import this subpath.
 *
 * Does NOT set app.tenant_id, so tenant tables return zero rows. Platform tables use a separate policy keyed
 * on `current_setting('app.platform', true) = 'on'`. `reason` (1..200 printable chars) and `actorId` (UUIDv7)
 * are exposed as app.platform_reason / app.actor_id for the audit row the caller must write in the same
 * transaction. `requestId` is 1..128 chars.
 */
export async function withPlatformTx<T>(
  pool: pg.Pool,
  ctx: PlatformCtx,
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  if (!isUuidV7(ctx.actorId)) throw new Error("withPlatformTx: actorId must be a UUIDv7");
  if (ctx.reason.trim() === "" || ctx.reason.length > 200 || !PRINTABLE.test(ctx.reason))
    throw new Error("withPlatformTx: reason must be 1..200 printable characters");
  if (ctx.requestId === "" || ctx.requestId.length > 128)
    throw new Error("withPlatformTx: requestId must be 1..128 characters");
  return run(pool, PLATFORM_SQL, [ctx.reason, ctx.actorId, ctx.requestId], fn);
}
