import { createLocalDb } from "../storage/local-db.ts";

import type { LocalDb } from "../storage/local-db.ts";
import type { StorageAdapter } from "../storage/port.ts";

/**
 * The device database, version by version. Append only: a shipped version is never edited (devices in the field have
 * applied it). Each version runs in its own transaction, so a crash leaves the previous version intact.
 *
 *   kv               small durable facts: cursors per dataset, snapshot versions, the device's chain head
 *   device_outbox    the signed, hash-chained commands waiting for the server (seq is the device_seq)
 *   entities         the pulled datasets, one row per entity (payload is the server's JSON)
 *   variant_search   FTS5 over variant name and sku; rowid is variant_rowid in `variant_index`
 *   drafts           carts that are not sales yet
 *   local_movements  stock decrements made on this device and not yet confirmed by a pulled balance
 *   local_shifts / local_sales / local_returns / local_cash_movements  what this terminal sold, returned and counted (v2):
 *                    the source for returns, voids, reprints and the Z-report while offline
 */
export const MIGRATIONS: readonly { readonly version: number; readonly sql: readonly string[] }[] =
  [
    {
      version: 1,
      sql: [
        `CREATE TABLE kv (
         key text PRIMARY KEY,
         value text NOT NULL
       ) WITHOUT ROWID`,
        `CREATE TABLE device_outbox (
         seq integer PRIMARY KEY,
         id text NOT NULL,
         type text NOT NULL,
         body text NOT NULL,
         hash text NOT NULL,
         prev_hash text NOT NULL,
         hlc text NOT NULL,
         created_at integer NOT NULL,
         status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acked', 'rejected')),
         ack text,
         attempts integer NOT NULL DEFAULT 0,
         UNIQUE (type, id)
       )`,
        // The push loop reads the oldest pending commands; acked rows stay until pruned (audit, support export).
        `CREATE INDEX device_outbox_pending_idx ON device_outbox (seq) WHERE status = 'pending'`,
        `CREATE TABLE entities (
         dataset text NOT NULL,
         entity text NOT NULL,
         entity_id text NOT NULL,
         version integer NOT NULL DEFAULT 0,
         payload text NOT NULL,
         changed_at text NOT NULL,
         PRIMARY KEY (dataset, entity, entity_id)
       ) WITHOUT ROWID`,
        `CREATE TABLE variant_index (
         variant_rowid integer PRIMARY KEY,
         variant_id text NOT NULL UNIQUE
       )`,
        `CREATE VIRTUAL TABLE variant_search USING fts5(name, sku, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
        `CREATE TABLE drafts (
         id text PRIMARY KEY,
         operator_id text NOT NULL,
         body text NOT NULL,
         updated_at integer NOT NULL
       ) WITHOUT ROWID`,
        `CREATE TABLE local_movements (
         id text PRIMARY KEY,
         variant_id text NOT NULL,
         location_id text NOT NULL,
         batch_id text,
         qty text NOT NULL,
         ref_id text NOT NULL,
         created_at integer NOT NULL
       ) WITHOUT ROWID`,
        `CREATE INDEX local_movements_variant_idx ON local_movements (variant_id, location_id)`,
      ],
    },
    {
      // Everything a shift needs to be counted and every sale needs to be returned or voided, on the device and offline.
      version: 2,
      sql: [
        `CREATE TABLE local_shifts (
         id text PRIMARY KEY,
         opened_at integer NOT NULL,
         business_date text NOT NULL,
         currency text NOT NULL,
         opening_float_minor integer NOT NULL,
         closed_at integer,
         counted_minor integer,
         expected_minor integer,
         auto_closed integer NOT NULL DEFAULT 0
       ) WITHOUT ROWID`,
        `CREATE INDEX local_shifts_open_idx ON local_shifts (opened_at) WHERE closed_at IS NULL`,
        `CREATE TABLE local_sales (
         id text PRIMARY KEY,
         shift_id text NOT NULL,
         sale_no integer NOT NULL,
         completed_at integer NOT NULL,
         body text NOT NULL,
         voided_at integer,
         voided_shift_id text
       ) WITHOUT ROWID`,
        `CREATE INDEX local_sales_recent_idx ON local_sales (completed_at DESC)`,
        `CREATE INDEX local_sales_shift_idx ON local_sales (shift_id)`,
        `CREATE INDEX local_sales_void_shift_idx ON local_sales (voided_shift_id)`,
        `CREATE TABLE local_returns (
         id text PRIMARY KEY,
         sale_id text,
         shift_id text NOT NULL,
         return_no integer NOT NULL,
         occurred_at integer NOT NULL,
         body text NOT NULL
       ) WITHOUT ROWID`,
        `CREATE INDEX local_returns_sale_idx ON local_returns (sale_id)`,
        `CREATE INDEX local_returns_shift_idx ON local_returns (shift_id)`,
        `CREATE TABLE local_cash_movements (
         id text PRIMARY KEY,
         shift_id text NOT NULL,
         kind text NOT NULL,
         amount_minor integer NOT NULL,
         reason text NOT NULL,
         at integer NOT NULL
       ) WITHOUT ROWID`,
        `CREATE INDEX local_cash_movements_shift_idx ON local_cash_movements (shift_id)`,
      ],
    },
  ];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export interface OpenOptions {
  /** Clock for the migration log. */
  now?: () => number;
}

async function supportsFts5(db: LocalDb): Promise<boolean> {
  try {
    await db.exec(
      "CREATE VIRTUAL TABLE temp._fts_probe USING fts5(x); DROP TABLE temp._fts_probe;",
    );
    return true;
  } catch {
    return false;
  }
}

/** Without FTS5 the search table is a plain two-column table (same rowid contract); search then scans it. */
function withoutFts(stmt: string): string {
  return stmt.startsWith("CREATE VIRTUAL TABLE variant_search")
    ? "CREATE TABLE variant_search (name text NOT NULL, sku text NOT NULL)"
    : stmt;
}

/**
 * Opens a device database: durability pragmas, then every migration not applied yet. WAL with `synchronous=FULL`: an
 * acknowledged local sale survives power loss (the outbox row is the only copy until the server acks it).
 */
export async function openLocalDb(
  adapter: StorageAdapter,
  options: OpenOptions = {},
): Promise<LocalDb> {
  const now = options.now ?? Date.now;
  const db = createLocalDb(adapter);
  // WAL where the engine allows it (some web builds silently keep another mode); the rest is mandatory.
  await db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;",
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version integer PRIMARY KEY, applied_at integer NOT NULL)",
  );
  const done = new Set(
    (await db.all<{ version: number }>("SELECT version FROM _migrations")).map((r) => r.version),
  );
  const known = new Set(MIGRATIONS.map((m) => m.version));
  const ahead = [...done].filter((v) => !known.has(v));
  if (ahead.length > 0) {
    await db.close();
    throw new Error(
      `The local database is at version ${String(Math.max(...ahead))}, newer than this app (${String(LATEST_VERSION)}): update the app`,
    );
  }
  const fts = await supportsFts5(db);
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.sql) await tx.exec(fts ? stmt : withoutFts(stmt));
      await tx.run("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", [
        m.version,
        now(),
      ]);
    });
  }
  return db;
}
