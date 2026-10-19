export class CanonicalizeError extends Error {
  override readonly name = "CanonicalizeError";
}

function fail(path: string, why: string): never {
  throw new CanonicalizeError(`cannot canonicalize ${path || "$"}: ${why}`);
}

function ser(value: unknown, path: string, stack: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return fail(path, "non-finite number");
      return Object.is(value, -0) ? "0" : String(value);
    case "undefined":
      return fail(path, "undefined");
    case "bigint":
      return fail(path, "bigint");
    case "symbol":
      return fail(path, "symbol");
    case "function":
      return fail(path, "function");
    default:
      break;
  }
  if (value === null) return "null";
  const obj = value as object;
  if (stack.has(obj)) return fail(path, "cyclic reference");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) parts.push(ser(obj[i], `${path}[${String(i)}]`, stack));
      return `[${parts.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) return fail(path, "non-plain object");
    // Default sort compares UTF-16 code units, as RFC 8785 requires.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      parts.push(`${JSON.stringify(k)}:${ser(v, `${path}.${k}`, stack)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** RFC 8785 JSON Canonicalization Scheme. Throws CanonicalizeError on unsupported input. */
export function canonicalize(value: unknown): string {
  return ser(value, "", new Set());
}
