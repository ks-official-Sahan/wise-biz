import { join } from "node:path";

import pg from "pg";

import { findTablesWithoutRls, loadRegistry } from "../src/index.ts";

const url = process.env["DATABASE_MIGRATOR_URL"];
if (!url) {
  console.error("DATABASE_MIGRATOR_URL is required");
  process.exit(1);
}
const entries = await loadRegistry(join(import.meta.dirname, "..", "..", ".."));
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const bad = await findTablesWithoutRls(
    client,
    entries.map((e) => e.module.replace(/^_/, "")),
  );
  if (bad.length > 0) {
    console.error(`Tables without enabled+forced RLS and a policy:\n${bad.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("rls-check ok");
  }
} finally {
  await client.end();
}
