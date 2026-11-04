import { canonicalize, sha256, utf8 } from "@wise-biz/crypto";
import { fromBase64, toBase64 } from "@wise-biz/http-signatures";

import type { Bytes } from "@wise-biz/crypto";

export { fromBase64, toBase64 };

/** The `prev_hash` of a device's first command: 32 zero bytes. */
export const GENESIS_HASH: Bytes = new Uint8Array(32);

/** What the server verifies in every command (ADR 0015); the single definition both sides use. */
export interface CommandMeta {
  readonly deviceSeq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly signature: string;
}

/** A command as it travels: the type and the body the device built, `meta` inside the body. */
export interface WireCommand {
  readonly type: string;
  readonly body: Readonly<Record<string, unknown>> & { readonly meta: CommandMeta };
}

/**
 * hash = sha256(canonical({ type, seq, body without meta }) || prev_hash). The command type and sequence number are
 * inside the hash, so a signed command cannot be relabelled or renumbered in transit. `@wise-biz/module-sync`
 * recomputes this exact function from the received body.
 */
export function commandHash(
  type: string,
  seq: number,
  body: Readonly<Record<string, unknown>>,
  prevHash: Bytes,
): Bytes {
  const rest: Record<string, unknown> = { ...body };
  delete rest.meta;
  const canon = utf8(canonicalize({ type, seq, body: rest }));
  const data = new Uint8Array(canon.length + prevHash.length);
  data.set(canon, 0);
  data.set(prevHash, canon.length);
  return sha256(data);
}
