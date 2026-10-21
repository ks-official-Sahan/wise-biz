import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";

export interface ModuleEntry {
  module: string;
  dir: string;
}
export interface AppliedMigration {
  module: string;
  version: number;
  name: string;
}
interface MigrationFile {
  version: number;
  name: string;
  file: string;
}

const MODULE_RE = /^_?[a-z][a-z0-9_]*$/;
const NO_TX_HEADER = /^-- wb:no-transaction[ \t]*(\r?\n|$)/;

/**
 * Session-level advisory lock key serialising all migrate() runs on a database.
 * Fixed arbitrary constant (do not reuse elsewhere; 7_706_001 is the test harness's CREATE DATABASE lock).
 */
export const MIGRATE_LOCK_KEY = 7_706_002n;
const LOCK_POLL_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export function assertModuleName(module: string): void {
  if (!MODULE_RE.test(module))
    throw new Error(`invalid module name: ${JSON.stringify(module)} (want ^_?[a-z][a-z0-9_]*$)`);
}

/** A `-- wb:no-transaction` file must be one statement (CREATE INDEX CONCURRENTLY cannot run in a tx block). */
function assertSingleStatement(module: string, file: string, text: string): void {
  const body = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;$/, "");
  if (body === "" || body.includes(";"))
    throw new Error(
      `${module}: ${file} is marked wb:no-transaction and must contain exactly one statement (no ';' inside)`,
    );
}

async function acquireLock(client: pg.Client, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
      MIGRATE_LOCK_KEY.toString(),
    ]);
    if (res.rows[0]?.ok) return;
    if (Date.now() >= deadline)
      throw new Error(`migrate: could not get advisory lock within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

const FILE_RE = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Files `NNNN_snake_name.sql`, contiguous from 0001, no duplicates. */
export async function listMigrations(entry: ModuleEntry): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(entry.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: MigrationFile[] = [];
  for (const file of names.filter((n) => n.endsWith(".sql")).sort()) {
    const m = FILE_RE.exec(file);
    const [, ver, nm] = m ?? [];
    if (ver === undefined || nm === undefined)
      throw new Error(`${entry.module}: bad migration filename ${file} (want NNNN_snake_name.sql)`);
    files.push({ version: Number(ver), name: nm, file });
  }
  files.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new Error(
        `${entry.module}: migration gap or duplicate at ${f.file} (expected version ${String(i + 1)})`,
      );
    }
  });
  return files;
}

/**
 * Apply per-module migrations in the given order. Advisory-locked (polls up to `lockTimeoutMs`, default 60s,
 * then throws); one transaction per file, except files whose first line is `-- wb:no-transaction`:
 * those hold exactly one statement, run without BEGIN (e.g. CREATE INDEX CONCURRENTLY) and are recorded
 * after success. If such a statement fails midway, fix forward (it may leave an INVALID index to drop).
 * An applied migration whose file vanished (removed/renamed) is an error.
 */
export async function migrate(
  migratorUrl: string,
  entries: ModuleEntry[],
  opts: { lockTimeoutMs?: number } = {},
): Promise<AppliedMigration[]> {
  for (const e of entries) assertModuleName(e.module);
  const client = new pg.Client({ connectionString: migratorUrl, application_name: "wb-migrate" });
  await client.connect();
  const applied: AppliedMigration[] = [];
  try {
    await acquireLock(client, opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    await client.query("CREATE SCHEMA IF NOT EXISTS wb_migrations");
    await client.query(`CREATE TABLE IF NOT EXISTS wb_migrations.applied (
      module text NOT NULL, version int NOT NULL, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (module, version))`);
    for (const entry of entries) {
      const files = await listMigrations(entry);
      const done = await client.query<{ version: number; checksum: string }>(
        "select version, checksum from wb_migrations.applied where module = $1",
        [entry.module],
      );
      const known = new Map(done.rows.map((r) => [r.version, r.checksum]));
      const onDisk = new Set(files.map((f) => f.version));
      for (const v of known.keys()) {
        if (!onDisk.has(v))
          throw new Error(
            `${entry.module}: applied migration ${String(v)} is missing on disk (removed or renamed)`,
          );
      }
      for (const f of files) {
        const text = await readFile(join(entry.dir, f.file), "utf8");
        const checksum = sha256(text);
        const prior = known.get(f.version);
        if (prior !== undefined) {
          if (prior !== checksum)
            throw new Error(`${entry.module}: checksum mismatch for ${f.file} (already applied)`);
          continue;
        }
        const record = (): Promise<unknown> =>
          client.query(
            "insert into wb_migrations.applied (module, version, name, checksum) values ($1, $2, $3, $4)",
            [entry.module, f.version, f.name, checksum],
          );
        if (NO_TX_HEADER.test(text)) {
          assertSingleStatement(entry.module, f.file, text);
          await client.query(text);
          await record();
        } else {
          try {
            await client.query("BEGIN");
            await client.query(text);
            await record();
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw err;
          }
        }
        applied.push({ module: entry.module, version: f.version, name: f.name });
      }
    }
    return applied;
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY.toString()])
      .catch(() => undefined);
    await client.end();
  }
}
