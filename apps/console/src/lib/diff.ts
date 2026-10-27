/** One changed field between two audit snapshots. */
export interface FieldChange {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Flat field-level diff of two JSON values for the audit drawer: nested objects become dotted paths, arrays and
 * scalars compare by JSON value. Unchanged fields are left out. Pure, so it is unit-tested.
 */
export function diffJson(before: unknown, after: unknown, prefix = ""): FieldChange[] {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffJson(before[k], after[k], prefix === "" ? k : `${prefix}.${k}`));
  }
  if (isObject(before) && after === undefined) return diffJson(before, {}, prefix);
  if (before === undefined && isObject(after)) return diffJson({}, after, prefix);
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: prefix === "" ? "(value)" : prefix, before, after }];
}

export function show(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
