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
];
// fast-redact wildcards match exactly one level, so cover the common nestings explicitly.
const PREFIXES = ["", "*.", "*.*.", "req.headers.", "res.headers.", "headers."];

export const REDACT_PATHS: readonly string[] = PREFIXES.flatMap((p) =>
  SECRET_KEYS.map((k) => (/^[a-z]\w*$/i.test(k) ? `${p}${k}` : `${p}["${k}"]`)),
);

export function createLogger(level = "info", destination?: DestinationStream): Logger {
  const opts = {
    level,
    base: { service: "wise-biz-api" },
    redact: { paths: [...REDACT_PATHS], censor: "[Redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(opts, destination) : pino(opts);
}
