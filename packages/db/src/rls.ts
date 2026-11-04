import type pg from "pg";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(kind: string, name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid ${kind} identifier: ${name}`);
  return `"${name}"`;
}

/** Enable + force RLS and add the tenant policy. Missing OR empty setting (a pooled connection that once set the GUC reports "" not NULL) -> NULL -> zero rows (fail closed). */
export function rlsSql(
  schema: string,
  table: string,
  opts: { tenantColumn?: string } = {},
): string {
  const t = `${ident("schema", schema)}.${ident("table", table)}`;
  const col = ident("column", opts.tenantColumn ?? "tenant_id");
  const expr = `${col} = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY tenant_isolation ON ${t} USING (${expr}) WITH CHECK (${expr});`,
  ].join("\n");
}

// A policy counts only if it is PERMISSIVE, FOR ALL, and both USING and WITH CHECK reference app.tenant_id.
// Also flagged: a PERMISSIVE policy for wb_app/PUBLIC referencing neither app.tenant_id nor app.user_id
// (e.g. `USING (true)`), and any non-SELECT policy that mentions app.user_id.
// Text match on the deparsed expression: catches `USING (true)`, SELECT-only and RESTRICTIVE-only
// policies; it is a lint, not a proof (a hand-written `true OR ...` would pass; review those).
const FIND_SQL = `
select n.nspname || '.' || c.relname as name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1::text[])
  and (
    (c.relkind in ('r', 'p')
      and (not c.relrowsecurity
        or not c.relforcerowsecurity
        or not exists (
          select 1 from pg_policies p
          where p.schemaname = n.nspname and p.tablename = c.relname
            and p.permissive = 'PERMISSIVE' and p.cmd = 'ALL'
            and p.qual like '%app.tenant_id%' and p.with_check like '%app.tenant_id%')
        -- a PERMISSIVE policy reachable by wb_app / PUBLIC must be keyed on app.tenant_id or app.user_id
        or exists (
          select 1 from pg_policies p
          where p.schemaname = n.nspname and p.tablename = c.relname and p.permissive = 'PERMISSIVE'
            and ('public' = any(p.roles) or 'wb_app' = any(p.roles))
            and coalesce(p.qual, '') || coalesce(p.with_check, '') !~ 'app\\.(tenant_id|user_id)')
        -- app.user_id may only widen reads: never in a policy that can write
        or exists (
          select 1 from pg_policies p
          where p.schemaname = n.nspname and p.tablename = c.relname and p.cmd <> 'SELECT'
            and coalesce(p.qual, '') || coalesce(p.with_check, '') like '%app.user_id%')))
    or (c.relkind in ('m', 'f') and has_table_privilege('wb_app', c.oid, 'SELECT'))
    or (c.relkind = 'v'
      and not exists (
        select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) o
        where o ~* '^security_invoker=(true|on|yes|1|t)$')))
order by 1`;

/**
 * Relations in the given schemas that can leak across tenants:
 * - tables and partitioned parents lacking enabled+forced RLS or a tenant-scoped PERMISSIVE ALL policy;
 *   partitions are checked too (a direct query on a partition ignores the parent's policies);
 * - materialized views and foreign tables wb_app can SELECT (RLS cannot protect them);
 * - views without security_invoker=true (they would run with the owner's rights, bypassing RLS).
 */
export async function findTablesWithoutRls(
  client: Pick<pg.ClientBase, "query">,
  schemas: string[],
): Promise<string[]> {
  if (schemas.length === 0) return [];
  const res = await client.query<{ name: string }>(FIND_SQL, [schemas]);
  return res.rows.map((r) => r.name);
}

// Runtime roles that must have NOTHING on a global schema (identity). has_*_privilege with a list is "any of".
const GLOBAL_LEAK_SQL = `
select name from (
  select n.nspname || ' -> ' || r.role as name
  from pg_namespace n cross join unnest($2::text[]) as r(role)
  where n.nspname = any($1::text[]) and has_schema_privilege(r.role, n.oid, 'USAGE,CREATE')
  union all
  select n.nspname || '.' || c.relname || ' -> ' || r.role
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest($2::text[]) as r(role)
  where n.nspname = any($1::text[])
    and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and case when c.relkind = 'S'
      then has_sequence_privilege(r.role, c.oid, 'USAGE,SELECT,UPDATE')
      else has_any_column_privilege(r.role, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
        or has_table_privilege(r.role, c.oid, 'DELETE,TRUNCATE,TRIGGER') end
  union all
  select n.nspname || '.' || p.proname || '() -> ' || r.role
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join unnest($2::text[]) as r(role)
  where n.nspname = any($1::text[]) and has_function_privilege(r.role, p.oid, 'EXECUTE')
) o
order by 1`;

/**
 * GLOBAL schemas (no tenant column, no RLS, e.g. identity) are protected by privilege separation instead:
 * wb_app, wb_worker and wb_chainer must hold NO privilege on the schema or on any table, view, sequence or
 * column in it, and may not EXECUTE any function in it
 * (including privileges inherited from PUBLIC). Returns "schema[.relation] -> role" offenders.
 */
export async function findGlobalSchemaLeaks(
  client: Pick<pg.ClientBase, "query">,
  schemas: string[],
  roles: readonly string[] = ["wb_app", "wb_worker", "wb_chainer"],
): Promise<string[]> {
  if (schemas.length === 0) return [];
  const res = await client.query<{ name: string }>(GLOBAL_LEAK_SQL, [schemas, [...roles]]);
  return res.rows.map((r) => r.name);
}
