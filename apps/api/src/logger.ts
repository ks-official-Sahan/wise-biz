import { pino } from "pino";

import type { DestinationStream, Logger } from "pino";

const SECRET_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "password",
  "secret",
  "pin",
  "cardNumber",
  "pan",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "session",
  "otp",
];
// fast-redact wildcards match exactly one level, so cover the common nestings explicitly.
const PREFIXES = ["", "*.", "*.*.", "*.*.*.", "req.headers.", "res.headers.", "headers."];

/** fast-redact: identifiers use dots; anything else (hyphens) needs bracket syntax with no dot before it. */
const path = (prefix: string, key: string): string =>
  /^[a-z_$][\w$]*$/i.test(key)
    ? `${prefix}${key}`
    : `${prefix.endsWith(".") ? prefix.slice(0, -1) : prefix}["${key}"]`;

export const REDACT_PATHS: readonly string[] = PREFIXES.flatMap((p) =>
  SECRET_KEYS.map((k) => path(p, k)),
);

/** Keeps type/message/stack/code; drops pg `detail`, `where`, `parameters` (row values) and anything else. */
export function serializeErr(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const { code } = err as { code?: unknown };
  return {
    type: err.constructor.name,
    message: err.message,
    stack: err.stack,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

export function createLogger(level = "info", destination?: DestinationStream): Logger {
  const opts = {
    level,
    base: { service: "wise-biz-api" },
    redact: { paths: [...REDACT_PATHS], censor: "[Redacted]" },
    serializers: { err: serializeErr },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(opts, destination) : pino(opts);
}
