import { gzipSync } from "node:zlib";

import { tenantKey } from "@wise-biz/storage";

import { isDataset } from "./changes.ts";

import type { Dataset } from "./changes.ts";
import type { TxHandle } from "@wise-biz/db";
import type { ObjectStore } from "@wise-biz/storage";

/** What pull needs from the rest of the system, wired at the composition root. */
export interface PullPorts {
  /** Location ids of a branch (tenancy owns them): stock changes are scoped by location. */
  branchLocations(tx: TxHandle, tenantId: string, branchId: string): Promise<readonly string[]>;
  readonly store: ObjectStore;
}

export interface PullOptions {
  /** A snapshot younger than this is reused; the cursor it carries lets the device catch up with a pull. */
  readonly snapshotMaxAgeMs?: number;
  readonly snapshotUrlSeconds?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<txid>:<id>` as base64url: opaque to devices, strictly validated here. */
export function encodeCursor(txid: string, id: string): string {
  return Buffer.from(`${txid}:${id}`).toString("base64url");
}
export function decodeCursor(cursor: string): { txid: string; id: string } | undefined {
  const [txid, id, ...rest] = Buffer.from(cursor, "base64url").toString().split(":");
  if (rest.length > 0 || txid === undefined || id === undefined) return undefined;
  return /^\d{1,20}$/.test(txid) && UUID.test(id) ? { txid, id } : undefined;
}

/** Scopes a terminal reads: tenant-wide rows, its branch, and (stock) the locations of its branch. */
const scopesFor = (dataset: Dataset, branchId: string, locations: readonly string[]) =>
  dataset === "stock_branch" ? [branchId, ...locations] : ["all", branchId];

export interface Change {
  readonly entity: string;
  readonly entityId: string;
  readonly op: "upsert" | "delete";
  readonly version: number;
  readonly payload: unknown;
  readonly changedAt: string;
}

interface ChangeRow {
  txid: string;
  id: string;
  entity: string;
  entity_id: string;
  op: "upsert" | "delete";
  version: string;
  payload: unknown;
  changed_at: Date;
}

/**
 * One page of a dataset after a cursor, in (txid, id) order. A row is visible only below the oldest transaction still
 * in flight, so a late commit can never land behind a cursor a device already holds. One query per page (plus the
 * branch's locations for stock): the cost does not depend on the page size or the number of entity types.
 */
export async function pullChanges(
  tx: TxHandle,
  tenantId: string,
  branchId: string,
  ports: Pick<PullPorts, "branchLocations">,
  q: { dataset: Dataset; cursor?: string | undefined; limit: number },
): Promise<{ changes: Change[]; nextCursor: string | null; hasMore: boolean }> {
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  const locations =
    q.dataset === "stock_branch" ? await ports.branchLocations(tx, tenantId, branchId) : [];
  const params: unknown[] = [tenantId, q.dataset, scopesFor(q.dataset, branchId, locations)];
  let cursorSql = "";
  if (after !== undefined) {
    params.push(after.txid, after.id);
    cursorSql = "and (txid, id) > ($4::xid8, $5::uuid)";
  }
  params.push(q.limit + 1);
  const r = await tx.query<ChangeRow>(
    `select txid::text, id, entity, entity_id, op, version::text, payload, changed_at
     from sync.sync_changes
     where tenant_id = $1 and dataset = $2 and scope_key = any($3::text[])
       and txid < pg_snapshot_xmin(pg_current_snapshot()) ${cursorSql}
     order by txid, id limit $${String(params.length)}`,
    params,
  );
  const page = r.rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    changes: page.map((c) => ({
      entity: c.entity,
      entityId: c.entity_id,
      op: c.op,
      version: Number(c.version),
      payload: c.payload,
      changedAt: c.changed_at.toISOString(),
    })),
    nextCursor: last === undefined ? (q.cursor ?? null) : encodeCursor(last.txid, last.id),
    hasMore: r.rows.length > q.limit,
  };
}

export interface Bootstrap {
  readonly dataset: Dataset;
  readonly cursor: string | null;
  readonly url: string | null;
  readonly expiresInSeconds: number;
  readonly entityCount: number;
  readonly bytes: number;
  readonly builtAt: string;
}

interface SnapshotRow {
  cursor: string;
  object_key: string;
  entity_count: number;
  bytes: number;
  built_at: Date;
}

/**
 * The newest state of every entity of a dataset as of one cursor, from ONE statement (one snapshot of the database):
 * the entities and the cursor they are consistent with can never disagree.
 */
async function readState(
  tx: TxHandle,
  tenantId: string,
  dataset: Dataset,
  scopes: readonly string[],
) {
  const r = await tx.query<{
    kind: "cursor" | "entity";
    txid: string | null;
    id: string | null;
    entity: string | null;
    entity_id: string | null;
    version: string | null;
    payload: unknown;
  }>(
    `with vis as (
       select * from sync.sync_changes
       where tenant_id = $1 and dataset = $2 and txid < pg_snapshot_xmin(pg_current_snapshot())
     ),
     cur as (select txid::text, id from vis order by txid desc, id desc limit 1),
     latest as (
       select distinct on (entity, entity_id) entity, entity_id, version, op, payload
       from vis where scope_key = any($3::text[])
       order by entity, entity_id, txid desc, id desc
     )
     select 'cursor' as kind, txid, id::text, null as entity, null as entity_id, null as version, null::jsonb as payload
       from cur
     union all
     select 'entity', null, null, entity, entity_id, version::text, payload from latest where op = 'upsert'`,
    [tenantId, dataset, [...scopes]],
  );
  const cur = r.rows.find((x) => x.kind === "cursor");
  return {
    cursor: cur?.txid != null && cur.id != null ? encodeCursor(cur.txid, cur.id) : null,
    entities: r.rows.filter((x) => x.kind === "entity"),
  };
}

/**
 * Bootstrap for a first boot: a gzip NDJSON snapshot in object storage and the cursor to continue from. A snapshot
 * younger than `snapshotMaxAgeMs` is reused. The build is one statement and one upload; two concurrent builds only
 * duplicate work (keys carry the cursor, the row keeps the newest).
 */
export async function bootstrap(
  tx: TxHandle,
  tenantId: string,
  branchId: string,
  ports: PullPorts,
  dataset: Dataset,
  now: Date,
  opts: PullOptions = {},
): Promise<Bootstrap> {
  const maxAge = opts.snapshotMaxAgeMs ?? 6 * 3_600_000;
  const urlSeconds = opts.snapshotUrlSeconds ?? 900;
  // Stock is per branch; every other dataset is shared by the tenant.
  const scopeKey = dataset === "stock_branch" ? branchId : "all";
  const existing = await tx.query<SnapshotRow>(
    `select cursor, object_key, entity_count, bytes, built_at from sync.snapshots
     where tenant_id = $1 and dataset = $2 and scope_key = $3`,
    [tenantId, dataset, scopeKey],
  );
  const row = existing.rows[0];
  const reply = (s: SnapshotRow): Bootstrap => ({
    dataset,
    cursor: s.cursor === "" ? null : s.cursor,
    url: ports.store.presignGet(s.object_key, urlSeconds),
    expiresInSeconds: urlSeconds,
    entityCount: s.entity_count,
    bytes: s.bytes,
    builtAt: s.built_at.toISOString(),
  });
  if (row !== undefined && now.getTime() - row.built_at.getTime() < maxAge) return reply(row);

  const locations =
    dataset === "stock_branch" ? await ports.branchLocations(tx, tenantId, branchId) : [];
  const state = await readState(tx, tenantId, dataset, scopesFor(dataset, branchId, locations));
  const lines = [
    JSON.stringify({ dataset, scope: scopeKey, cursor: state.cursor, builtAt: now.toISOString() }),
    ...state.entities.map((e) =>
      JSON.stringify({
        entity: e.entity,
        id: e.entity_id,
        version: Number(e.version),
        payload: e.payload,
      }),
    ),
  ];
  const body = gzipSync(Buffer.from(`${lines.join("\n")}\n`));
  const key = tenantKey(
    tenantId,
    "sync",
    dataset,
    `${scopeKey}-${state.cursor ?? "empty"}.ndjson.gz`,
  );
  await ports.store.put(key, new Uint8Array(body), "application/gzip");
  const built: SnapshotRow = {
    cursor: state.cursor ?? "",
    object_key: key,
    entity_count: state.entities.length,
    bytes: body.length,
    built_at: now,
  };
  await tx.query(
    `insert into sync.snapshots (tenant_id, dataset, scope_key, cursor, object_key, entity_count, bytes, built_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, dataset, scope_key) do update set cursor = excluded.cursor,
       object_key = excluded.object_key, entity_count = excluded.entity_count, bytes = excluded.bytes,
       built_at = excluded.built_at
     where sync.snapshots.built_at <= excluded.built_at`,
    [tenantId, dataset, scopeKey, built.cursor, key, built.entity_count, built.bytes, now],
  );
  return reply(built);
}

export { isDataset };
