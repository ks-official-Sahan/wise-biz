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
            and p.qual like '%app.tenant_id%' and p.with_check like '%app.tenant_id%')))
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
