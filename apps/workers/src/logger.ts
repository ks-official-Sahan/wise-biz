import { pino } from "pino";

import type { DestinationStream, Logger } from "pino";

const SECRET_KEYS = [
  "authorization",
  "cookie",
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
  "email",
  "phone",
  "phoneNumber",
];
const PREFIXES = ["", "*.", "*.*.", "*.*.*."];

export const REDACT_PATHS: readonly string[] = PREFIXES.flatMap((p) =>
  SECRET_KEYS.map((k) => `${p}${k}`),
);

/** Keeps type/message/stack/code; drops pg `detail`, `where`, `parameters` (row values). */
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
    base: { service: "wise-biz-workers" },
    redact: { paths: [...REDACT_PATHS], censor: "[Redacted]" },
    serializers: { err: serializeErr },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(opts, destination) : pino(opts);
}
