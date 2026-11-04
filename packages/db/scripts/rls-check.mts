import { join } from "node:path";

import pg from "pg";

import {
  findGlobalSchemaLeaks,
  findTablesWithoutRls,
  loadGlobalSchemas,
  loadRegistry,
} from "../src/index.ts";

const url = process.env["DATABASE_MIGRATOR_URL"];
if (!url) {
  console.error("DATABASE_MIGRATOR_URL is required");
  process.exit(1);
}
const root = join(import.meta.dirname, "..", "..", "..");
const entries = await loadRegistry(root);
const globals = new Set(await loadGlobalSchemas(root));
const schemaOf = (module: string): string => module.replace(/^_/, "");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const bad = await findTablesWithoutRls(
    client,
    entries.filter((e) => !globals.has(e.module)).map((e) => schemaOf(e.module)),
  );
  if (bad.length > 0) {
    console.error(`Tables without enabled+forced RLS and a policy:\n${bad.join("\n")}`);
    process.exitCode = 1;
  }
  // Global schemas (identity): no RLS by design; wb_app / wb_worker must hold no privilege at all.
  const leaks = await findGlobalSchemaLeaks(client, [...globals].map(schemaOf));
  if (leaks.length > 0) {
    console.error(`Global schema privileges leaked to runtime roles:\n${leaks.join("\n")}`);
    process.exitCode = 1;
  }
  if (bad.length === 0 && leaks.length === 0) console.log("rls-check ok");
} finally {
  await client.end();
}
