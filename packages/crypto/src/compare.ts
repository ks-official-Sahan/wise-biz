import { sha256 } from "./hash.ts";

import type { Bytes } from "./bytes.ts";

/** Constant-time equality. Both sides are hashed first, so length never leaks. */
export function constantTimeEqual(a: Bytes | string, b: Bytes | string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}
