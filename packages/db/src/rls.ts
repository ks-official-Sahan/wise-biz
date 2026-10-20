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

const FIND_SQL = `
select n.nspname || '.' || c.relname as name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and not c.relispartition
  and n.nspname = any($1::text[])
  and (not c.relrowsecurity
    or not c.relforcerowsecurity
    or not exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname))
order by 1`;

/** Tables in the given schemas lacking enabled+forced RLS or any policy. Partitions inherit from parent. */
export async function findTablesWithoutRls(
  client: Pick<pg.ClientBase, "query">,
  schemas: string[],
): Promise<string[]> {
  if (schemas.length === 0) return [];
  const res = await client.query<{ name: string }>(FIND_SQL, [schemas]);
  return res.rows.map((r) => r.name);
}
