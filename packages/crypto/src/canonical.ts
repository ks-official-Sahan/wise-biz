export class CanonicalizeError extends Error {
  override readonly name = "CanonicalizeError";
}

/** Max nesting depth; deeper input throws CanonicalizeError instead of overflowing the stack. */
const MAX_DEPTH = 1000;

// Messages carry only depth, never keys or values (they may hold PII or secrets).
function fail(depth: number, why: string): never {
  throw new CanonicalizeError(`cannot canonicalize at depth ${String(depth)}: ${why}`);
}

/** RFC 8785 requires well-formed UTF-16: reject unpaired surrogates. */
function checkWellFormed(s: string, depth: number): void {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i++);
    if (c < 0xd800 || c > 0xdfff) continue;
    const d = i < s.length ? s.charCodeAt(i) : 0;
    if (c > 0xdbff || d < 0xdc00 || d > 0xdfff) return fail(depth, "lone surrogate in string");
    i++;
  }
}

function ser(value: unknown, depth: number, stack: Set<object>): string {
  switch (typeof value) {
    case "string":
      checkWellFormed(value, depth);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return fail(depth, "non-finite number");
      return Object.is(value, -0) ? "0" : String(value);
    case "undefined":
      return fail(depth, "undefined");
    case "bigint":
      return fail(depth, "bigint");
    case "symbol":
      return fail(depth, "symbol");
    case "function":
      return fail(depth, "function");
    default:
      break;
  }
  if (value === null) return "null";
  const obj = value as object;
  if (depth >= MAX_DEPTH) return fail(depth, "nesting too deep");
  if (stack.has(obj)) return fail(depth, "cyclic reference");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj as unknown[]) parts.push(ser(item, depth + 1, stack));
      return `[${parts.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) return fail(depth, "non-plain object");
    // Default sort compares UTF-16 code units, as RFC 8785 requires.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      checkWellFormed(k, depth);
      parts.push(`${JSON.stringify(k)}:${ser(v, depth + 1, stack)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** RFC 8785 JSON Canonicalization Scheme. Throws CanonicalizeError on unsupported input. */
export function canonicalize(value: unknown): string {
  return ser(value, 0, new Set());
}
