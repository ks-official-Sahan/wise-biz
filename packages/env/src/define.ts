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
  if (!present && (issue.code === "invalid_type" || issue.code === "invalid_value")) {
    return "required";
  }
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

/** Values shipped in .env.example; production must never run with them. */
const DEV_PLACEHOLDER = /change-me|^dev-only|^wb-dev-/i;

/** Dev-default role passwords from the local docker setup (password == role name). */
const DEV_DB_PASSWORDS: Readonly<Record<string, string>> = {
  DATABASE_URL: "wb_app",
  DATABASE_MIGRATOR_URL: "wb_migrator",
  DATABASE_WORKER_URL: "wb_worker",
  DATABASE_CHAINER_URL: "wb_chainer",
  DATABASE_IDENTITY_URL: "wb_identity",
};

function hasDevDbPassword(key: string, value: string): boolean {
  const dev = DEV_DB_PASSWORDS[key];
  if (dev === undefined) return false;
  try {
    return decodeURIComponent(new URL(value).password) === dev;
  } catch {
    return false; // unparseable: defineEnv reports the format error; never echo it
  }
}

/** Production-only guardrails. Pure: the secret source is a parameter. */
export function assertProductionEnv(source: EnvSource = process.env): void {
  const env = clean(source);
  const { NODE_ENV, AUTH_SECRET, EMAIL_PROVIDER } = env;
  if (NODE_ENV === "development" || NODE_ENV === "test") return;

  const problems = new Map<string, string>();
  if (NODE_ENV !== "production") {
    // Never infer a safe environment from absence or a typo.
    throw new EnvError(
      new Map([["NODE_ENV", NODE_ENV === undefined ? "required" : "invalid value"]]),
    );
  }
  if (AUTH_SECRET === undefined) problems.set("AUTH_SECRET", "required");
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith("_SECRET") && value.length < MIN_SECRET) {
      problems.set(key, `too short (min ${String(MIN_SECRET)})`);
    } else if (/_SECRET|_KEY$|_PASSWORD$/.test(key) && DEV_PLACEHOLDER.test(value)) {
      problems.set(key, "dev placeholder from .env.example is not allowed in production");
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (hasDevDbPassword(key, value)) {
      problems.set(key, "dev database password is not allowed in production");
    }
  }
  if ((EMAIL_PROVIDER ?? "capture") === "capture") {
    problems.set("EMAIL_PROVIDER", "capture is not allowed in production");
  }
  if (
    (env.CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .includes("*")
  ) {
    problems.set(
      "CORS_ORIGINS",
      "wildcard origin is not allowed in production (credentials are on)",
    );
  }
  if (problems.size > 0) throw new EnvError(problems);
}
