// @ts-check
// Load smoke for P0-07: POST /v1/template/items through runCommand (authorize -> validate ->
// idempotency -> tx with audit + outbox). Usage (API running with API_DEV_AUTH=1, NODE_ENV=development):
//   node scripts/load/template-create.mjs [url] [rate] [seconds]
// Prints p50/p95/p99 latency and polls pg_stat_activity for lock waits during the run.
import { console } from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";

import autocannon from "autocannon";
import pg from "pg";

const url = process.argv[2] ?? "http://localhost:3999";
const rate = Number(process.argv[3] ?? 1000);
const seconds = Number(process.argv[4] ?? 30);
const adminUrl =
  process.env.LOAD_ADMIN_DB_URL ?? "postgres://postgres:postgres@localhost:5432/wise_biz";

// uuidv7-shaped ids for dev auth headers (version and variant nibbles set).
const v7 = () => {
  const hex = randomUUID().replaceAll("-", "");
  const ms = Date.now().toString(16).padStart(12, "0");
  const variant = ((parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  const s = `${ms}7${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
const tenants = Array.from({ length: 20 }, v7);
const user = v7();

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
let lockWaits = 0;
let maxActive = 0;
const poll = setInterval(() => {
  void admin
    .query(
      `select count(*) filter (where wait_event_type = 'Lock')::int as locks,
              count(*) filter (where state = 'active')::int as active
       from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
    )
    .then(({ rows }) => {
      const r = rows[0] ?? { locks: 0, active: 0 };
      lockWaits = Math.max(lockWaits, r.locks);
      maxActive = Math.max(maxActive, r.active);
    })
    .catch(() => undefined);
}, 200);

let i = 0;
const result = await autocannon({
  url: `${url}/v1/template/items`,
  method: "POST",
  connections: 64,
  overallRate: rate,
  duration: seconds,
  requests: [
    {
      setupRequest: (req) => {
        i += 1;
        return {
          ...req,
          headers: {
            "content-type": "application/json",
            "idempotency-key": `load-${randomUUID()}`,
            "x-wb-dev-tenant": tenants[i % tenants.length],
            "x-wb-dev-user": user,
          },
          body: JSON.stringify({ name: `item ${i}`, children: ["a", "b"] }),
        };
      },
    },
  ],
});
clearInterval(poll);
await admin.end();

const l = result.latency;
const summary = {
  targetRps: rate,
  achievedRps: Math.round(result.requests.average),
  total: result.requests.total,
  non2xx: result.non2xx,
  errors: result.errors,
  timeouts: result.timeouts,
  p50ms: l.p50,
  p975ms: l.p97_5,
  p99ms: l.p99,
  maxLockWaitsSeen: lockWaits,
  maxActiveBackends: maxActive,
};
console.log(JSON.stringify(summary, null, 2));
