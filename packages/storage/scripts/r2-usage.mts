// Prints this month's Cloudflare R2 usage against the caps (ADR 0023) and exits 1 when a cap is reached.
// Run it before any step that writes to R2:   pnpm -F @wise-biz/storage r2-usage
// Needs CLOUDFLARE_ACCOUNT_ID (or STORAGE_ENDPOINT) and CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read).
// Optional: R2_LIMIT_STORAGE_BYTES, R2_LIMIT_CLASS_A, R2_LIMIT_CLASS_B, R2_PERIOD_ANCHOR_DAY.
import { appendFileSync } from "node:fs";

import {
  R2_DEFAULT_LIMITS,
  createQuotaGate,
  createUsageReader,
  r2AccountOf,
} from "../src/quota.ts";

const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
};

const account =
  process.env["CLOUDFLARE_ACCOUNT_ID"] ?? r2AccountOf(process.env["STORAGE_ENDPOINT"]);
const token = process.env["CLOUDFLARE_ANALYTICS_TOKEN"];
if (account === undefined || account === "" || token === undefined || token === "") {
  console.error("Set CLOUDFLARE_ACCOUNT_ID (or STORAGE_ENDPOINT) and CLOUDFLARE_ANALYTICS_TOKEN.");
  process.exit(2);
}

const anchor = num("R2_PERIOD_ANCHOR_DAY", 1);
const gate = createQuotaGate({
  limits: {
    storageBytes: num("R2_LIMIT_STORAGE_BYTES", R2_DEFAULT_LIMITS.storageBytes),
    classA: num("R2_LIMIT_CLASS_A", R2_DEFAULT_LIMITS.classA),
    classB: num("R2_LIMIT_CLASS_B", R2_DEFAULT_LIMITS.classB),
  },
  periodAnchorDay: anchor,
});
gate.apply(
  await createUsageReader({ accountId: account, apiToken: token, periodAnchorDay: anchor })(),
);
const s = gate.status();

const names = {
  storage: "Storage (bytes)",
  classA: "Class A operations",
  classB: "Class B operations",
};
const rows = (["storage", "classA", "classB"] as const).map((k) => {
  const m = s.metrics[k];
  return `| ${names[k]} | ${m.used.toLocaleString("en-US")} | ${m.limit.toLocaleString("en-US")} | ${(m.ratio * 100).toFixed(1)}% | ${m.level} |`;
});
const table = [
  `R2 usage, period ${s.periodStart.slice(0, 10)} to ${s.periodEnd.slice(0, 10)}`,
  "",
  "| Metric | Used | Cap | Of cap | Level |",
  "|---|---|---|---|---|",
  ...rows,
].join("\n");
console.log(table);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined && summary !== "") appendFileSync(summary, `${table}\n`);

if (s.level === "blocked") {
  console.log(
    "::error title=R2 cap reached::Uploads and downloads are refused until the period resets.",
  );
  process.exit(1);
}
if (s.level === "warn") console.log("::warning title=R2 near cap::A metric passed 80% of its cap.");
