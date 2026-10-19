import { envKeys } from "./registry.ts";

import type { EnvShape } from "./registry.ts";

export interface EnvExampleDiff {
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
  readonly duplicate: readonly string[];
  readonly missingRequiredMarker: readonly string[];
  readonly ok: boolean;
}

const KEY_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const REQUIRED_MARKER = "(required)";

/** Compare .env.example text with the schema keys. Reads key names and comments only. */
export function diffEnvExample(
  text: string,
  fragments: Readonly<Record<string, EnvShape>>,
): EnvExampleDiff {
  const comments = new Map<string, string>();
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  let pending: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      pending = [];
    } else if (line.startsWith("#")) {
      if (!line.startsWith("# ---")) pending.push(line);
    } else {
      const key = KEY_LINE.exec(line)?.[1];
      if (key !== undefined) {
        if (seen.has(key)) duplicate.add(key);
        seen.add(key);
        comments.set(key, pending.join(" "));
      }
      pending = [];
    }
  }

  const info = envKeys(fragments);
  const expected = new Set(info.map((i) => i.key));
  const missing = [...expected].filter((k) => !seen.has(k)).sort();
  const unknown = [...seen].filter((k) => !expected.has(k)).sort();
  const missingRequiredMarker = info
    .filter(
      (i) =>
        i.required && seen.has(i.key) && !(comments.get(i.key) ?? "").includes(REQUIRED_MARKER),
    )
    .map((i) => i.key)
    .sort();
  const dup = [...duplicate].sort();

  return {
    missing,
    unknown,
    duplicate: dup,
    missingRequiredMarker,
    ok: [missing, unknown, dup, missingRequiredMarker].every((l) => l.length === 0),
  };
}
