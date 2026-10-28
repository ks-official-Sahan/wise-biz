import { DomainError } from "@wise-biz/errors";

import { productEventsFor } from "./products.ts";
import { notFound } from "./shared.ts";

import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";

const MAX_DEPTH = 8;

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  path: string[];
}
const categoryDto = (r: CategoryRow) => ({
  id: r.id,
  parentId: r.parent_id,
  name: r.name,
  path: r.path,
});

const invalid = (path: string, message: string): never => {
  throw new DomainError("VALIDATION_FAILED", message, { fieldErrors: [{ path, message }] });
};

/**
 * Tree writes in one business are serialised (small trees, rare writes): a concurrent move and create can then never
 * commit a cycle or a path computed from a parent that moved meanwhile.
 */
const lockTree = (tx: TxHandle, tenantId: string) =>
  tx.query("select pg_advisory_xact_lock(hashtextextended('catalog.categories:' || $1, 0))", [
    tenantId,
  ]);

async function parentPath(tx: TxHandle, tenantId: string, parentId: string): Promise<string[]> {
  const r = await tx.query<{ path: string[] }>(
    "select path from catalog.categories where tenant_id = $1 and id = $2",
    [tenantId, parentId],
  );
  return r.rows[0]?.path ?? invalid("parentId", "Unknown parent category.");
}

export async function createCategoryCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: { id?: string | undefined; name: string; parentId?: string | null | undefined },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const id = input.id ?? ctx.ids.uuidv7();
  await lockTree(tx, tenantId);
  const prefix = input.parentId ? await parentPath(tx, tenantId, input.parentId) : [];
  if (prefix.length >= MAX_DEPTH)
    invalid("parentId", `Categories nest at most ${String(MAX_DEPTH)} deep.`);
  const r = await tx.query<CategoryRow>(
    `insert into catalog.categories (id, tenant_id, parent_id, name, path, created_at, updated_at)
     values ($1, $2, $3, $4, $5::uuid[], $6, $6) returning id, parent_id, name, path`,
    [id, tenantId, input.parentId ?? null, input.name, [...prefix, id], ctx.now],
  );
  const body = categoryDto(r.rows[0] ?? notFound());
  return {
    status: 201,
    body,
    audit: [
      { action: "catalog.category.created", entity: "catalog.category", entityId: id, after: body },
    ],
    // A new category has no products yet, so no catalog event carries it.
    noEvents: true,
  };
}

/** Rename and/or move. A move rewrites the paths of the whole moved subtree in one UPDATE. */
export async function updateCategoryCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: { name?: string | undefined; parentId?: string | null | undefined },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  await lockTree(tx, tenantId);
  const r = await tx.query<CategoryRow>(
    "select id, parent_id, name, path from catalog.categories where tenant_id = $1 and id = $2 for update",
    [tenantId, id],
  );
  const before = r.rows[0] ?? notFound();
  if (input.name !== undefined) {
    await tx.query(
      "update catalog.categories set name = $3, updated_at = $4 where tenant_id = $1 and id = $2",
      [tenantId, id, input.name, ctx.now],
    );
  }
  if (input.parentId !== undefined && input.parentId !== before.parent_id) {
    const prefix = input.parentId === null ? [] : await parentPath(tx, tenantId, input.parentId);
    if (prefix.includes(id)) invalid("parentId", "A category cannot move under itself.");
    const depth = await tx.query<{ d: number }>(
      `select coalesce(max(cardinality(path)), 0)::int as d from catalog.categories
       where tenant_id = $1 and path @> array[$2::uuid]`,
      [tenantId, id],
    );
    const subtree = (depth.rows[0]?.d ?? 0) - before.path.length + 1;
    if (prefix.length + subtree > MAX_DEPTH) {
      invalid("parentId", `Categories nest at most ${String(MAX_DEPTH)} deep.`);
    }
    await tx.query(
      `update catalog.categories set
         path = $3::uuid[] || path[$4::int + 1:],
         parent_id = case when id = $2 then $5::uuid else parent_id end,
         updated_at = $6
       where tenant_id = $1 and path @> array[$2::uuid]`,
      [tenantId, id, prefix, before.path.length - 1, input.parentId, ctx.now],
    );
  }
  const a = await tx.query<CategoryRow>(
    "select id, parent_id, name, path from catalog.categories where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  const after = categoryDto(a.rows[0] ?? notFound());
  // Every product in the subtree carries this category's name/path in its events: re-emit them (batched reads).
  const affected = await tx.query<{ id: string }>(
    `select p.id from catalog.products p
     where p.tenant_id = $1
       and p.category_id in (select c.id from catalog.categories c where c.tenant_id = $1 and c.path @> array[$2::uuid])`,
    [tenantId, id],
  );
  const events = await productEventsFor(
    tx,
    ctx,
    affected.rows.map((r) => r.id),
  );
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "catalog.category.updated",
        entity: "catalog.category",
        entityId: id,
        before: categoryDto(before),
        after,
      },
    ],
    ...(events.length > 0 ? { events } : { noEvents: true }),
  };
}

export async function listCategories(tx: TxHandle, tenantId: string) {
  const r = await tx.query<CategoryRow>(
    "select id, parent_id, name, path from catalog.categories where tenant_id = $1 order by path",
    [tenantId],
  );
  return r.rows.map(categoryDto);
}

export async function createTagCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: { id?: string | undefined; name: string },
): Promise<CommandResult> {
  const id = input.id ?? ctx.ids.uuidv7();
  await tx.query(
    "insert into catalog.tags (id, tenant_id, name, created_at) values ($1, $2, $3, $4)",
    [id, ctx.tenant.tenantId, input.name, ctx.now],
  );
  const body = { id, name: input.name };
  return {
    status: 201,
    body,
    audit: [{ action: "catalog.tag.created", entity: "catalog.tag", entityId: id, after: body }],
    noEvents: true,
  };
}

export async function listTags(tx: TxHandle, tenantId: string) {
  const r = await tx.query<{ id: string; name: string }>(
    "select id, name from catalog.tags where tenant_id = $1 order by lower(name)",
    [tenantId],
  );
  return r.rows;
}

export async function createUnitCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: { id?: string | undefined; code: string; name: string; decimals?: number | undefined },
): Promise<CommandResult> {
  const id = input.id ?? ctx.ids.uuidv7();
  const body = { id, code: input.code, name: input.name, decimals: input.decimals ?? 0 };
  await tx.query(
    "insert into catalog.units (id, tenant_id, code, name, decimals, created_at) values ($1, $2, $3, $4, $5, $6)",
    [id, ctx.tenant.tenantId, body.code, body.name, body.decimals, ctx.now],
  );
  return {
    status: 201,
    body,
    audit: [{ action: "catalog.unit.created", entity: "catalog.unit", entityId: id, after: body }],
    noEvents: true,
  };
}

export async function createUnitConversionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: { fromUnitId: string; toUnitId: string; factor: string },
): Promise<CommandResult> {
  if (input.fromUnitId === input.toUnitId) invalid("toUnitId", "Pick two different units.");
  const id = ctx.ids.uuidv7();
  const r = await tx.query<{ factor: string }>(
    `insert into catalog.unit_conversions (id, tenant_id, from_unit_id, to_unit_id, factor, created_at)
     values ($1, $2, $3, $4, $5::numeric, $6) returning factor::text`,
    [id, ctx.tenant.tenantId, input.fromUnitId, input.toUnitId, input.factor, ctx.now],
  );
  const body = {
    id,
    fromUnitId: input.fromUnitId,
    toUnitId: input.toUnitId,
    factor: r.rows[0]?.factor ?? input.factor,
  };
  return {
    status: 201,
    body,
    audit: [
      {
        action: "catalog.unit_conversion.created",
        entity: "catalog.unit_conversion",
        entityId: id,
        after: body,
      },
    ],
    noEvents: true,
  };
}

export async function listUnits(tx: TxHandle, tenantId: string) {
  const [u, c] = [
    await tx.query<{ id: string; code: string; name: string; decimals: number }>(
      "select id, code, name, decimals from catalog.units where tenant_id = $1 order by code",
      [tenantId],
    ),
    await tx.query<{ id: string; from_unit_id: string; to_unit_id: string; factor: string }>(
      `select id, from_unit_id, to_unit_id, factor::text from catalog.unit_conversions
       where tenant_id = $1 order by from_unit_id, to_unit_id`,
      [tenantId],
    ),
  ];
  return {
    units: u.rows,
    conversions: c.rows.map((r) => ({
      id: r.id,
      fromUnitId: r.from_unit_id,
      toUnitId: r.to_unit_id,
      factor: r.factor,
    })),
  };
}
