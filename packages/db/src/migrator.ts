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

/** Apply per-module migrations in the given order. Advisory-locked; one transaction per file. */
export async function migrate(
  migratorUrl: string,
  entries: ModuleEntry[],
): Promise<AppliedMigration[]> {
  const client = new pg.Client({ connectionString: migratorUrl, application_name: "wb-migrate" });
  await client.connect();
  const applied: AppliedMigration[] = [];
  try {
    await client.query("select pg_advisory_lock(hashtext('wb_migrate'))");
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
      for (const f of files) {
        const text = await readFile(join(entry.dir, f.file), "utf8");
        const checksum = sha256(text);
        const prior = known.get(f.version);
        if (prior !== undefined) {
          if (prior !== checksum)
            throw new Error(`${entry.module}: checksum mismatch for ${f.file} (already applied)`);
          continue;
        }
        try {
          await client.query("BEGIN");
          await client.query(text);
          await client.query(
            "insert into wb_migrations.applied (module, version, name, checksum) values ($1, $2, $3, $4)",
            [entry.module, f.version, f.name, checksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
        applied.push({ module: entry.module, version: f.version, name: f.name });
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('wb_migrate'))").catch(() => undefined);
    await client.end();
  }
}
