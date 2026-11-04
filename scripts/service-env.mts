import { envKeys } from "../packages/env/src/index.ts";

import { API_ENV } from "../apps/api/src/server.ts";
import { REALTIME_ENV } from "../apps/realtime/src/start.ts";
import { CONSUMER_ENV, WORKER_ENV } from "../apps/workers/src/worker.ts";

/**
 * Prints the environment variable names a service reads, one per line (required first), so the deploy workflow wires
 * exactly what the code asks for instead of a hand-kept list that drifts. Usage: `node scripts/service-env.mts api`.
 */
const SERVICES = {
  api: API_ENV,
  workers: { ...WORKER_ENV, ...CONSUMER_ENV },
  realtime: REALTIME_ENV,
} as const;

const name = process.argv[2];
if (name !== "api" && name !== "workers" && name !== "realtime") {
  console.error("usage: service-env.mts api|workers|realtime");
  process.exit(2);
}
const onlyRequired = process.argv[3] === "--required";
const keys = envKeys({ [name]: SERVICES[name] }).filter((k) => !onlyRequired || k.required);
for (const k of [...keys].sort(
  (a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key),
)) {
  console.log(k.key);
}
