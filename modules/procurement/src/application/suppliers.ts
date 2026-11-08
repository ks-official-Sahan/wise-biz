import { DomainError } from "@wise-biz/errors";

import { normQty } from "../domain/qty.ts";
import { SupplierUpsertedV1 } from "../events.ts";

import {
  conflict,
  decodeCursor,
  iso,
  invalid,
  one,
  page,
  procurementEvent,
  requireVersion,
} from "./shared.ts";

import type { RefsPort } from "../port.ts";
import type {
  CreateSupplierSchema,
  PriceItemSchema,
  PriceListQuery,
  SupplierListQuery,
  UpdateSupplierSchema,
} from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  address: string;
  payment_terms_days: number;
  lead_time_days: number;
  currency: string;
  archived_at: Date | null;
  version: number;
  updated_at: Date;
}
const COLS =
  "id, name, contact_name, email, phone, address, payment_terms_days, lead_time_days, currency, archived_at, version, updated_at";

export interface Supplier {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  paymentTermsDays: number;
  leadTimeDays: number;
  currency: string;
  archivedAt: string | null;
  version: number;
  updatedAt: string;
}

const toSupplier = (r: SupplierRow): Supplier => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  email: r.email,
  phone: r.phone,
  address: r.address,
  paymentTermsDays: r.payment_terms_days,
  leadTimeDays: r.lead_time_days,
  currency: r.currency,
  archivedAt: iso(r.archived_at),
  version: r.version,
  updatedAt: r.updated_at.toISOString(),
});

export interface Price {
  id: string;
  variantId: string;
  unitCostMinor: number;
  currency: string;
  minOrderQty: string;
  validFrom: string;
}

interface PriceRow {
  id: string;
  variant_id: string;
  unit_cost_minor: string;
  currency: string;
  min_order_qty: string;
  valid_from: string;
}
// bigint and numeric come back as strings: cast in SQL so the mapping is exact.
const PRICE_COLS =
  "id, variant_id, unit_cost_minor::text as unit_cost_minor, currency, min_order_qty::text as min_order_qty, valid_from::text as valid_from";
const toPrice = (r: PriceRow): Price => ({
  id: r.id,
  variantId: r.variant_id,
  unitCostMinor: Number(r.unit_cost_minor),
  currency: r.currency,
  minOrderQty: normQty(r.min_order_qty),
  validFrom: r.valid_from,
});

type CreateInput = z.infer<typeof CreateSupplierSchema>;
type UpdateInput = z.infer<typeof UpdateSupplierSchema>;
type ListInput = z.infer<typeof SupplierListQuery>;
type PriceInput = z.infer<typeof PriceListQuery>;
type PriceItem = z.infer<typeof PriceItemSchema>;

function supplierEvent(ctx: CommandContext, s: Supplier, prices: readonly Price[]) {
  return procurementEvent(SupplierUpsertedV1, ctx, `supplier/${s.id}`, {
    supplierId: s.id,
    name: s.name,
    currency: s.currency,
    paymentTermsDays: s.paymentTermsDays,
    leadTimeDays: s.leadTimeDays,
    archived: s.archivedAt !== null,
    prices: prices.map((p) => ({
      variantId: p.variantId,
      unitCostMinor: p.unitCostMinor,
      currency: p.currency,
      minOrderQty: p.minOrderQty,
      validFrom: p.validFrom,
    })),
  });
}

export async function getSupplier(tx: TxHandle, tenantId: string, id: string): Promise<Supplier> {
  const r = await tx.query<SupplierRow>(
    `select ${COLS} from procurement.suppliers where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return toSupplier(one(r.rows));
}

export async function listSuppliers(tx: TxHandle, tenantId: string, q: ListInput) {
  const params: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  if (!q.includeArchived) where.push("archived_at is null");
  if (q.after !== undefined) {
    params.push(decodeCursor(q.after));
    where.push(`id > $${String(params.length)}`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<SupplierRow>(
    `select ${COLS} from procurement.suppliers where ${where.join(" and ")}
      order by id limit $${String(params.length)}`,
    params,
  );
  return page(r.rows.map(toSupplier), q.limit);
}

export async function listPrices(
  tx: TxHandle,
  tenantId: string,
  supplierId: string,
  q: PriceInput,
) {
  // The supplier must exist in this tenant (404 otherwise); one primary-key lookup, then the keyset page.
  await getSupplier(tx, tenantId, supplierId);
  const params: unknown[] = [tenantId, supplierId];
  let after = "";
  if (q.after !== undefined) {
    params.push(decodeCursor(q.after));
    after = ` and id > $${String(params.length)}`;
  }
  params.push(q.limit + 1);
  const r = await tx.query<PriceRow>(
    `select ${PRICE_COLS} from procurement.supplier_prices
      where tenant_id = $1 and supplier_id = $2${after}
      order by id limit $${String(params.length)}`,
    params,
  );
  return page(r.rows.map(toPrice), q.limit);
}

export async function createSupplierCommand(
  tx: TxHandle,
  ctx: CommandContext,
  b: CreateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const id = ctx.ids.uuidv7();
  const r = await tx.query<SupplierRow>(
    `insert into procurement.suppliers (tenant_id, id, name, contact_name, email, phone, address,
       payment_terms_days, lead_time_days, currency, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning ${COLS}`,
    [
      tenantId,
      id,
      b.name,
      b.contactName,
      b.email,
      b.phone,
      b.address,
      b.paymentTermsDays,
      b.leadTimeDays,
      b.currency,
      ctx.now,
    ],
  );
  const after = toSupplier(one(r.rows));
  return {
    status: 201,
    body: after,
    audit: [
      {
        action: "procurement.supplier.created",
        entity: "procurement.supplier",
        entityId: id,
        after,
      },
    ],
    events: [supplierEvent(ctx, after, [])],
  };
}

async function lockSupplier(tx: TxHandle, tenantId: string, id: string): Promise<Supplier> {
  const r = await tx.query<SupplierRow>(
    `select ${COLS} from procurement.suppliers where tenant_id = $1 and id = $2 for update`,
    [tenantId, id],
  );
  return toSupplier(one(r.rows));
}

export async function updateSupplierCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: UpdateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const before = await lockSupplier(tx, tenantId, id);
  requireVersion(before.version, b.version);
  if (before.archivedAt !== null) throw conflict("An archived supplier cannot be edited.");
  const r = await tx.query<SupplierRow>(
    `update procurement.suppliers
        set name = $3, contact_name = $4, email = $5, phone = $6, address = $7, payment_terms_days = $8,
            lead_time_days = $9, currency = $10, version = version + 1, updated_at = $11
      where tenant_id = $1 and id = $2 returning ${COLS}`,
    [
      tenantId,
      id,
      b.name,
      b.contactName,
      b.email,
      b.phone,
      b.address,
      b.paymentTermsDays,
      b.leadTimeDays,
      b.currency,
      ctx.now,
    ],
  );
  const after = toSupplier(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.supplier.updated",
        entity: "procurement.supplier",
        entityId: id,
        before,
        after,
      },
    ],
    events: [supplierEvent(ctx, after, [])],
  };
}

export async function archiveSupplierCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const before = await lockSupplier(tx, tenantId, id);
  requireVersion(before.version, version);
  if (before.archivedAt !== null) throw conflict("This supplier is already archived.");
  const r = await tx.query<SupplierRow>(
    `update procurement.suppliers set archived_at = $3, version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2 returning ${COLS}`,
    [tenantId, id, ctx.now],
  );
  const after = toSupplier(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.supplier.archived",
        entity: "procurement.supplier",
        entityId: id,
        before,
        after,
      },
    ],
    events: [supplierEvent(ctx, after, [])],
  };
}

/**
 * Upsert the price list: one row per (supplier, variant, valid_from). Currency must be the supplier's, so a PO's
 * currency is never ambiguous. Existing prices keep their id (ON CONFLICT updates in place).
 */
export async function upsertPricesCommand(
  tx: TxHandle,
  ctx: CommandContext,
  supplierId: string,
  items: readonly PriceItem[],
  refs: RefsPort,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const s = await lockSupplier(tx, tenantId, supplierId);
  if (s.archivedAt !== null) throw conflict("An archived supplier cannot change its prices.");
  items.forEach((i, n) => {
    if (i.currency !== s.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "The price must be in the supplier's currency.", {
        fieldErrors: [{ path: `items.${String(n)}.currency`, message: `Expected ${s.currency}.` }],
      });
    }
  });
  const known = await refs.variantsExist(tx, tenantId, [...new Set(items.map((i) => i.variantId))]);
  items.forEach((i, n) => {
    if (!known.has(i.variantId)) {
      invalid(`items.${String(n)}.variantId`, "Unknown or archived variant.");
    }
  });
  const rows = items.map((i) => ({
    id: ctx.ids.uuidv7(),
    variant_id: i.variantId,
    unit_cost_minor: i.unitCostMinor,
    currency: i.currency,
    min_order_qty: i.minOrderQty,
    valid_from: i.validFrom,
  }));
  const r = await tx.query<PriceRow>(
    `insert into procurement.supplier_prices (tenant_id, id, supplier_id, variant_id, unit_cost_minor, currency,
       min_order_qty, valid_from, updated_at)
     select $1, x.id, $2, x.variant_id, x.unit_cost_minor, x.currency, x.min_order_qty::numeric, x.valid_from::date, $3
       from jsonb_to_recordset($4::jsonb) as x(id uuid, variant_id uuid, unit_cost_minor bigint, currency text,
         min_order_qty text, valid_from text)
     on conflict (tenant_id, supplier_id, variant_id, valid_from) do update
       set unit_cost_minor = excluded.unit_cost_minor, currency = excluded.currency,
           min_order_qty = excluded.min_order_qty, updated_at = excluded.updated_at
     returning ${PRICE_COLS}`,
    [tenantId, supplierId, ctx.now, JSON.stringify(rows)],
  );
  const prices = r.rows.map(toPrice);
  return {
    status: 200,
    body: { items: prices },
    audit: [
      {
        action: "procurement.supplier.prices_upserted",
        entity: "procurement.supplier",
        entityId: supplierId,
        after: { count: prices.length },
      },
    ],
    events: [supplierEvent(ctx, s, prices)],
  };
}
