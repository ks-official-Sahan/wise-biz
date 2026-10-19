import { z } from "zod";

import { EnvError } from "./error.ts";

export type EnvSource = Readonly<Record<string, string | undefined>>;

const MIN_SECRET = 32;

/** Drop unset and "" entries: .env files commonly leave keys empty. */
function clean(source: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function kind(issue: z.core.$ZodIssue, present: boolean): string {
  switch (issue.code) {
    case "invalid_type":
      return present ? "invalid type" : "required";
    case "invalid_format":
      return `invalid ${issue.format}`;
    case "too_small":
      return "too short or small";
    case "too_big":
      return "too long or large";
    case "invalid_value":
      return "invalid value";
    case "custom":
      return issue.message; // only our own static messages are used with refine
    default:
      return "invalid";
  }
}

function freezeDeep<T extends object>(obj: T): Readonly<T> {
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) Object.freeze(v);
  }
  return Object.freeze(obj);
}

/** Validate env against a zod shape. Throws EnvError naming every bad key, never values. */
export function defineEnv<S extends z.ZodRawShape>(
  shape: S,
  source: EnvSource = process.env,
): Readonly<z.output<z.ZodObject<S>>> {
  const cleaned = clean(source);
  const result = z.object(shape).safeParse(cleaned);
  if (result.success) return freezeDeep(result.data);

  const problems = new Map<string, string>();
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "env");
    if (!problems.has(key)) problems.set(key, kind(issue, key in cleaned));
  }
  throw new EnvError(problems);
}

/** Production-only guardrails. Pure: the secret source is a parameter. */
export function assertProductionEnv(source: EnvSource = process.env): void {
  const env = clean(source);
  const { NODE_ENV, AUTH_SECRET, EMAIL_PROVIDER } = env;
  if (NODE_ENV !== "production") return;

  const problems = new Map<string, string>();
  if (AUTH_SECRET === undefined) problems.set("AUTH_SECRET", "required");
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith("_SECRET") && value.length < MIN_SECRET) {
      problems.set(key, `too short (min ${String(MIN_SECRET)})`);
    }
  }
  if ((EMAIL_PROVIDER ?? "capture") === "capture") {
    problems.set("EMAIL_PROVIDER", "capture is not allowed in production");
  }
  if (problems.size > 0) throw new EnvError(problems);
}
