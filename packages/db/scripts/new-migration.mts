import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listMigrations } from "../src/index.ts";

const [module, name] = process.argv.slice(2);
if (!module || !name || !/^[a-z][a-z0-9_]*$/.test(name) || !/^_?[a-z][a-z0-9_]*$/.test(module)) {
  console.error("usage: pnpm db:migration <module> <snake_case_name>");
  process.exit(1);
}
const dir = join(import.meta.dirname, "..", "..", "..", "modules", module, "migrations");
const next = (await listMigrations({ module, dir })).length + 1;
const file = `${String(next).padStart(4, "0")}_${name}.sql`;
await mkdir(dir, { recursive: true });
await writeFile(
  join(dir, file),
  `-- ${module}: ${name}
-- Expand/contract only. Review before commit.
-- New tenant table checklist:
--   id uuid primary key default uuidv7(), tenant_id uuid not null, tenant_id FIRST in every composite index,
--   then: ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY + tenant_isolation policy (see rlsSql in @wise-biz/db),
--   wb_app gets DML on new tables/sequences automatically (default privileges), but NOT schema USAGE:
--   a new schema needs GRANT USAGE ON SCHEMA <m> TO wb_app. Append-only tables: REVOKE UPDATE, DELETE, TRUNCATE.
-- Long-running DDL (CREATE INDEX CONCURRENTLY): make the FIRST line of the file exactly
--   -- wb:no-transaction
--   and put exactly ONE statement in it (runs without BEGIN; if it fails, drop the INVALID index and fix forward).
`,
  { flag: "wx" },
);
console.log(join(dir, file));
