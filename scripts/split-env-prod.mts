import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { envKeys } from "../packages/env/src/index.ts";

import { API_ENV } from "../apps/api/src/server.ts";
import { REALTIME_ENV } from "../apps/realtime/src/start.ts";
import { CONSUMER_ENV, WORKER_ENV } from "../apps/workers/src/worker.ts";

/**
 * Splits one `.env.prod` into one file per service (`.env.prod.api`, `.workers`, `.realtime`, `.console`, `.migrate`),
 * each holding only the variables that service reads, so the console (internet facing) never receives the database
 * password or the session secret and a compromised realtime process holds no mail or storage keys.
 * The lists come from the services' own env schemas (the same source as `service-env.mts`), so they cannot drift.
 *
 * Usage: node scripts/split-env-prod.mts [.env.prod] [outDir]   (outDir defaults to the input's folder)
 */
const names = (shape: Parameters<typeof envKeys>[0][string]): string[] =>
  envKeys({ s: shape }).map((k) => k.key);

// The console reads these only; none is secret (the DSN and origins end up in the browser bundle or are plain origins).
const CONSOLE = [
  "CONSOLE_UPLOAD_ORIGIN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
];

const SERVICES: Readonly<Record<string, readonly string[]>> = {
  api: names(API_ENV),
  workers: [...names(WORKER_ENV), ...names(CONSUMER_ENV)],
  realtime: names(REALTIME_ENV),
  console: CONSOLE,
  migrate: ["DATABASE_MIGRATOR_URL"],
};

const input = resolve(process.argv[2] ?? ".env.prod");
const outDir = resolve(process.argv[3] ?? dirname(input));

const entries = new Map<string, string>(); // KEY -> the original line, quotes and all
for (const line of readFileSync(input, "utf8").split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (m?.[1] !== undefined) entries.set(m[1], line.trimStart());
}

const used = new Set<string>();
for (const [service, keys] of Object.entries(SERVICES)) {
  const lines = keys.flatMap((k) => {
    const line = entries.get(k);
    if (line === undefined) return [];
    used.add(k);
    return [line];
  });
  // Mode 0600: the file holds secrets (ignored on Windows).
  writeFileSync(join(outDir, `.env.prod.${service}`), `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`.env.prod.${service}: ${String(lines.length)} variable(s)`);
}
// Names only, never values. Compose itself reads REDIS_PASSWORD, WB_VERSION and TLS_DIR from --env-file.
const unused = [...entries.keys()].filter((k) => !used.has(k));
if (unused.length > 0) console.log(`not passed to any service: ${unused.join(", ")}`);
