import { applyTax, TaxPolicyError } from "@wise-biz/tax";

import {
  FeeUpsertedV1,
  FxRateRecordedV1,
  PriceChangedV1,
  PriceListUpsertedV1,
  TaxRegionUpsertedV1,
} from "../events.ts";

import { invalid, iso, notFound, pricingEvent, stale, one } from "./shared.ts";

import type {
  CreateFeeSchema,
  CreateFxRateSchema,
  CreatePriceListSchema,
  CreateTaxRegionSchema,
  SetPricesSchema,
  UpdateFeeSchema,
  UpdatePriceListSchema,
  UpdateTaxRegionSchema,
} from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

type In<S extends z.ZodType> = z.output<S>;

// --- Tax regions ---

interface RegionRow {
  id: string;
  code: string;
  name: string;
  inclusive: boolean;
  strategy: "per-line" | "per-document";
  rounding_mode: "half-even" | "half-up" | "up" | "down";
  version: number;
}
interface RuleRow {
  id: string;
  region_id: string;
  name: string;
  rate_bps: number;
  compound: boolean;
  categories: string[];
  ord: number;
}

export interface TaxRegion {
  id: string;
  code: string;
  name: string;
  inclusive: boolean;
  strategy: "per-line" | "per-document";
  roundingMode: "half-even" | "half-up" | "up" | "down";
  version: number;
  rules: {
    id: string;
    name: string;
    rateBps: number;
    compound: boolean;
    categories: string[];
    order: number;
  }[];
}

/** Regions with their rules: two queries for any number of regions (no N+1). */
export async function loadRegions(
  tx: TxHandle,
  tenantId: string,
  ids?: readonly string[],
): Promise<TaxRegion[]> {
  const regions = await tx.query<RegionRow>(
    `select id, code, name, inclusive, strategy, rounding_mode, version from pricing.tax_regions
     where tenant_id = $1 ${ids === undefined ? "" : "and id = any($2::uuid[])"} order by code`,
    ids === undefined ? [tenantId] : [tenantId, ids],
  );
  if (regions.rows.length === 0) return [];
  const rules = await tx.query<RuleRow>(
    `select id, region_id, name, rate_bps, compound, categories, ord from pricing.tax_rules
     where tenant_id = $1 and region_id = any($2::uuid[]) order by ord, id`,
    [tenantId, regions.rows.map((r) => r.id)],
  );
  return regions.rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    inclusive: r.inclusive,
    strategy: r.strategy,
    roundingMode: r.rounding_mode,
    version: r.version,
    rules: rules.rows
      .filter((x) => x.region_id === r.id)
      .map((x) => ({
        id: x.id,
        name: x.name,
        rateBps: x.rate_bps,
        compound: x.compound,
        categories: x.categories,
        order: x.ord,
      })),
  }));
}

/** The engine is the judge of a policy (rates, duplicate ids): run it once on an empty cart. */
function checkPolicy(region: TaxRegion): void {
  try {
    applyTax("USD", [], {
      inclusive: region.inclusive,
      strategy: region.strategy,
      mode: region.roundingMode,
      rules: region.rules,
    });
  } catch (e) {
    if (e instanceof TaxPolicyError) invalid("rules", e.message);
    throw e;
  }
}

async function writeRules(
  tx: TxHandle,
  ctx: CommandContext,
  regionId: string,
  rules: TaxRegion["rules"],
): Promise<void> {
  await tx.query("delete from pricing.tax_rules where tenant_id = $1 and region_id = $2", [
    ctx.tenant.tenantId,
    regionId,
  ]);
  if (rules.length === 0) return;
  await tx.query(
    `insert into pricing.tax_rules (tenant_id, region_id, id, name, rate_bps, compound, categories, ord)
     select $1, $2, r.id, r.name, r.rate_bps, r.compound, r.categories, r.ord
     from jsonb_to_recordset($3::jsonb) as r(id uuid, name text, rate_bps int, compound boolean, categories text[], ord smallint)`,
    [
      ctx.tenant.tenantId,
      regionId,
      JSON.stringify(
        rules.map((r) => ({
          id: r.id,
          name: r.name,
          rate_bps: r.rateBps,
          compound: r.compound,
          categories: r.categories,
          ord: r.order,
        })),
      ),
    ],
  );
}

const regionEvent = (ctx: CommandContext, r: TaxRegion) => {
  const { id, ...rest } = r;
  return pricingEvent(TaxRegionUpsertedV1, ctx, `tax_region/${id}`, { taxRegionId: id, ...rest });
};

export async function createTaxRegionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: In<typeof CreateTaxRegionSchema>,
): Promise<CommandResult> {
  const region: TaxRegion = {
    id: input.id ?? ctx.ids.uuidv7(),
    code: input.code,
    name: input.name,
    inclusive: input.inclusive,
    strategy: input.strategy,
    roundingMode: input.roundingMode,
    version: 1,
    rules: input.rules.map((r) => ({ ...r, id: r.id ?? ctx.ids.uuidv7() })),
  };
  checkPolicy(region);
  await tx.query(
    `insert into pricing.tax_regions (tenant_id, id, code, name, inclusive, strategy, rounding_mode, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      ctx.tenant.tenantId,
      region.id,
      region.code,
      region.name,
      region.inclusive,
      region.strategy,
      region.roundingMode,
      ctx.now,
    ],
  );
  await writeRules(tx, ctx, region.id, region.rules);
  return {
    status: 201,
    body: region,
    audit: [
      {
        action: "pricing.tax_region.created",
        entity: "pricing.tax_region",
        entityId: region.id,
        after: region,
      },
    ],
    events: [regionEvent(ctx, region)],
  };
}

export async function updateTaxRegionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: In<typeof UpdateTaxRegionSchema>,
): Promise<CommandResult> {
  const [before] = await loadRegions(tx, ctx.tenant.tenantId, [id]);
  if (before === undefined) return notFound();
  if (before.version !== input.version) return stale();
  const after: TaxRegion = {
    ...before,
    name: input.name,
    inclusive: input.inclusive,
    strategy: input.strategy,
    roundingMode: input.roundingMode,
    version: before.version + 1,
    rules: input.rules.map((r) => ({ ...r, id: r.id ?? ctx.ids.uuidv7() })),
  };
  checkPolicy(after);
  const r = await tx.query(
    `update pricing.tax_regions set name = $3, inclusive = $4, strategy = $5, rounding_mode = $6, version = $7,
       updated_at = $8
     where tenant_id = $1 and id = $2 and version = $9`,
    [
      ctx.tenant.tenantId,
      id,
      after.name,
      after.inclusive,
      after.strategy,
      after.roundingMode,
      after.version,
      ctx.now,
      before.version,
    ],
  );
  if (r.rowCount !== 1) return stale();
  await writeRules(tx, ctx, id, after.rules);
  // Rules and rounding are part of every list's snapshot: bump the lists on this region (devices re-price).
  await tx.query(
    "update pricing.price_lists set version = version + 1, updated_at = $3 where tenant_id = $1 and tax_region_id = $2",
    [ctx.tenant.tenantId, id, ctx.now],
  );
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "pricing.tax_region.updated",
        entity: "pricing.tax_region",
        entityId: id,
        before,
        after,
      },
    ],
    events: [regionEvent(ctx, after)],
  };
}

// --- Price lists ---

interface ListRow {
  id: string;
  name: string;
  currency: string;
  tax_region_id: string;
  branch_id: string | null;
  customer_group: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  cash_increment_minor: number | null;
  version: number;
  archived_at: Date | null;
}
export type PriceList = ReturnType<typeof toList>;
const LIST_COLS = `id, name, currency, tax_region_id, branch_id, customer_group, valid_from, valid_to,
  cash_increment_minor, version, archived_at`;
const toList = (r: ListRow) => ({
  id: r.id,
  name: r.name,
  currency: r.currency,
  taxRegionId: r.tax_region_id,
  branchId: r.branch_id,
  customerGroup: r.customer_group,
  validFrom: iso(r.valid_from),
  validTo: iso(r.valid_to),
  cashIncrementMinor: r.cash_increment_minor,
  version: r.version,
  archived: r.archived_at !== null,
});

export async function getPriceList(
  tx: TxHandle,
  tenantId: string,
  id: string,
  lock: "update" | "share" | false = false,
): Promise<PriceList | undefined> {
  const r = await tx.query<ListRow>(
    `select ${LIST_COLS} from pricing.price_lists where tenant_id = $1 and id = $2${lock === false ? "" : ` for ${lock}`}`,
    [tenantId, id],
  );
  const row = r.rows[0];
  return row === undefined ? undefined : toList(row);
}

export async function listPriceLists(tx: TxHandle, tenantId: string): Promise<PriceList[]> {
  const r = await tx.query<ListRow>(
    `select ${LIST_COLS} from pricing.price_lists where tenant_id = $1 order by archived_at nulls first, lower(name), id`,
    [tenantId],
  );
  return r.rows.map(toList);
}

const listEvent = (ctx: CommandContext, l: PriceList) => {
  const { id, ...rest } = l;
  return pricingEvent(PriceListUpsertedV1, ctx, `price_list/${id}`, { priceListId: id, ...rest });
};

export async function createPriceListCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: In<typeof CreatePriceListSchema>,
): Promise<CommandResult> {
  const id = input.id ?? ctx.ids.uuidv7();
  const r = await tx.query<ListRow>(
    `insert into pricing.price_lists (tenant_id, id, name, currency, tax_region_id, branch_id, customer_group,
       valid_from, valid_to, cash_increment_minor, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning ${LIST_COLS}`,
    [
      ctx.tenant.tenantId,
      id,
      input.name,
      input.currency,
      input.taxRegionId,
      input.branchId ?? null,
      input.customerGroup ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.cashIncrementMinor ?? null,
      ctx.now,
    ],
  );
  const list = toList(one(r.rows));
  return {
    status: 201,
    body: list,
    audit: [
      {
        action: "pricing.price_list.created",
        entity: "pricing.price_list",
        entityId: id,
        after: list,
      },
    ],
    events: [listEvent(ctx, list)],
  };
}

export async function updatePriceListCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: In<typeof UpdatePriceListSchema>,
): Promise<CommandResult> {
  const before = await getPriceList(tx, ctx.tenant.tenantId, id, "update");
  if (before === undefined) return notFound();
  if (before.version !== input.version) return stale();
  // null clears a field, undefined keeps it: `??` would turn a clear into a keep.
  const pick = <K extends keyof PriceList>(k: K, v: PriceList[K] | undefined) =>
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- see above
    v === undefined ? before[k] : v;
  const validFrom = pick("validFrom", input.validFrom);
  const validTo = pick("validTo", input.validTo);
  if (validFrom !== null && validTo !== null && validTo <= validFrom)
    invalid("validTo", "must be after validFrom");
  const archived = input.archived ?? before.archived;
  const r = await tx.query<ListRow>(
    `update pricing.price_lists set name = $3, tax_region_id = $4, branch_id = $5, customer_group = $6,
       valid_from = $7, valid_to = $8, cash_increment_minor = $9, version = version + 1,
       archived_at = case when $10 then coalesce(archived_at, $11) end, updated_at = $11
     where tenant_id = $1 and id = $2 returning ${LIST_COLS}`,
    [
      ctx.tenant.tenantId,
      id,
      pick("name", input.name),
      pick("taxRegionId", input.taxRegionId),
      pick("branchId", input.branchId),
      pick("customerGroup", input.customerGroup),
      validFrom,
      validTo,
      pick("cashIncrementMinor", input.cashIncrementMinor),
      archived,
      ctx.now,
    ],
  );
  const after = toList(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "pricing.price_list.updated",
        entity: "pricing.price_list",
        entityId: id,
        before,
        after,
      },
    ],
    events: [listEvent(ctx, after)],
  };
}

/**
 * Upserts or removes up to 1000 prices in two statements, then bumps the list version once (the snapshot id). Only
 * real changes reach the event and the audit row.
 */
export async function setPricesCommand(
  tx: TxHandle,
  ctx: CommandContext,
  listId: string,
  input: In<typeof SetPricesSchema>,
): Promise<CommandResult> {
  const list = await getPriceList(tx, ctx.tenant.tenantId, listId, "update");
  if (list === undefined) return notFound();
  if (list.version !== input.version) return stale();
  const tenantId = ctx.tenant.tenantId;
  const ids = input.prices.map((p) => p.variantId);
  const old = await tx.query<{ variant_id: string; price_minor: string }>(
    `select variant_id, price_minor from pricing.prices
     where tenant_id = $1 and price_list_id = $2 and variant_id = any($3::uuid[])`,
    [tenantId, listId, ids],
  );
  const was = new Map(old.rows.map((r) => [r.variant_id, Number(r.price_minor)]));
  const changes = input.prices.filter((p) => (was.get(p.variantId) ?? null) !== p.priceMinor);
  const upserts = changes.filter((p) => p.priceMinor !== null);
  const removes = changes.filter((p) => p.priceMinor === null).map((p) => p.variantId);
  if (upserts.length > 0) {
    await tx.query(
      `insert into pricing.prices (tenant_id, price_list_id, variant_id, price_minor, updated_at)
       select $1, $2, v, p, $5 from unnest($3::uuid[], $4::bigint[]) as u(v, p)
       on conflict (tenant_id, price_list_id, variant_id) do update set price_minor = excluded.price_minor,
         updated_at = excluded.updated_at`,
      [
        tenantId,
        listId,
        upserts.map((p) => p.variantId),
        upserts.map((p) => p.priceMinor),
        ctx.now,
      ],
    );
  }
  if (removes.length > 0) {
    await tx.query(
      "delete from pricing.prices where tenant_id = $1 and price_list_id = $2 and variant_id = any($3::uuid[])",
      [tenantId, listId, removes],
    );
  }
  const body = { priceListId: listId, version: list.version, changed: changes.length };
  if (changes.length === 0) {
    return {
      status: 200,
      body,
      audit: [
        {
          action: "pricing.prices.unchanged",
          entity: "pricing.price_list",
          entityId: listId,
          after: body,
        },
      ],
      noEvents: true,
    };
  }
  const version = list.version + 1;
  await tx.query(
    "update pricing.price_lists set version = $3, updated_at = $4 where tenant_id = $1 and id = $2",
    [tenantId, listId, version, ctx.now],
  );
  const data = { priceListId: listId, version, changes };
  return {
    status: 200,
    body: { ...body, version },
    audit: [
      {
        action: "pricing.prices.set",
        entity: "pricing.price_list",
        entityId: listId,
        before: {
          changes: changes.map((c) => ({
            variantId: c.variantId,
            priceMinor: was.get(c.variantId) ?? null,
          })),
        },
        after: data,
      },
    ],
    events: [pricingEvent(PriceChangedV1, ctx, `price_list/${listId}`, data)],
  };
}

/** Keyset page by variant id. */
export async function listPrices(
  tx: TxHandle,
  tenantId: string,
  listId: string,
  after: string | undefined,
  limit: number,
) {
  const r = await tx.query<{ variant_id: string; price_minor: string }>(
    `select variant_id, price_minor from pricing.prices
     where tenant_id = $1 and price_list_id = $2 ${after === undefined ? "" : "and variant_id > $4"}
     order by variant_id limit $3`,
    after === undefined ? [tenantId, listId, limit + 1] : [tenantId, listId, limit + 1, after],
  );
  const rows = r.rows.slice(0, limit);
  return {
    items: rows.map((x) => ({ variantId: x.variant_id, priceMinor: Number(x.price_minor) })),
    nextCursor: r.rows.length > limit ? (rows.at(-1)?.variant_id ?? null) : null,
  };
}

// --- Fees ---

interface FeeRow {
  id: string;
  name: string;
  kind: "percent" | "amount";
  value: string;
  tax_category: string;
  active: boolean;
  version: number;
}
const FEE_COLS = "id, name, kind, value, tax_category, active, version";
const toFee = (r: FeeRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  value: Number(r.value),
  taxCategory: r.tax_category,
  active: r.active,
  version: r.version,
});
type FeeOut = ReturnType<typeof toFee>;
const feeEvent = (ctx: CommandContext, f: FeeOut) => {
  const { id, ...rest } = f;
  return pricingEvent(FeeUpsertedV1, ctx, `fee/${id}`, { feeId: id, ...rest });
};

export async function listFees(
  tx: TxHandle,
  tenantId: string,
  activeOnly = false,
): Promise<FeeOut[]> {
  const r = await tx.query<FeeRow>(
    `select ${FEE_COLS} from pricing.fees where tenant_id = $1 ${activeOnly ? "and active" : ""} order by lower(name), id`,
    [tenantId],
  );
  return r.rows.map(toFee);
}

export async function createFeeCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: In<typeof CreateFeeSchema>,
): Promise<CommandResult> {
  const id = input.id ?? ctx.ids.uuidv7();
  const r = await tx.query<FeeRow>(
    `insert into pricing.fees (tenant_id, id, name, kind, value, tax_category, active, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning ${FEE_COLS}`,
    [
      ctx.tenant.tenantId,
      id,
      input.name,
      input.kind,
      input.value,
      input.taxCategory,
      input.active,
      ctx.now,
    ],
  );
  const fee = toFee(one(r.rows));
  return {
    status: 201,
    body: fee,
    audit: [{ action: "pricing.fee.created", entity: "pricing.fee", entityId: id, after: fee }],
    events: [feeEvent(ctx, fee)],
  };
}

export async function updateFeeCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: In<typeof UpdateFeeSchema>,
): Promise<CommandResult> {
  const cur = await tx.query<FeeRow>(
    `select ${FEE_COLS} from pricing.fees where tenant_id = $1 and id = $2 for update`,
    [ctx.tenant.tenantId, id],
  );
  const row = cur.rows[0];
  if (row === undefined) return notFound();
  const before = toFee(row);
  if (before.version !== input.version) return stale();
  const kind = input.kind ?? before.kind;
  const value = input.value ?? before.value;
  if (kind === "percent" && value > 10_000)
    invalid("value", "percent fees are basis points (max 10000)");
  const r = await tx.query<FeeRow>(
    `update pricing.fees set name = $3, kind = $4, value = $5, tax_category = $6, active = $7, version = version + 1,
       updated_at = $8
     where tenant_id = $1 and id = $2 returning ${FEE_COLS}`,
    [
      ctx.tenant.tenantId,
      id,
      input.name ?? before.name,
      kind,
      value,
      input.taxCategory ?? before.taxCategory,
      input.active ?? before.active,
      ctx.now,
    ],
  );
  const after = toFee(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [{ action: "pricing.fee.updated", entity: "pricing.fee", entityId: id, before, after }],
    events: [feeEvent(ctx, after)],
  };
}

// --- FX rates ---

interface FxRow {
  id: string;
  base: string;
  quote: string;
  rate: string;
  valid_from: Date;
  source: string;
}
const toFx = (r: FxRow) => ({
  id: r.id,
  base: r.base,
  quote: r.quote,
  // numeric(20,10) comes back padded ("300.5000000000"): trim to the significant digits.
  rate: r.rate.includes(".") ? r.rate.replace(/0+$/, "").replace(/\.$/, "") : r.rate,
  validFrom: r.valid_from.toISOString(),
  source: r.source,
});

export async function recordFxRateCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: In<typeof CreateFxRateSchema>,
): Promise<CommandResult> {
  const id = input.id ?? ctx.ids.uuidv7();
  const r = await tx.query<FxRow>(
    `insert into pricing.fx_rates (tenant_id, id, base, quote, rate, valid_from, created_at, created_by)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8) returning id, base, quote, rate::text, valid_from, source`,
    [
      ctx.tenant.tenantId,
      id,
      input.base,
      input.quote,
      input.rate,
      input.validFrom ?? ctx.now,
      ctx.now,
      ctx.userId,
    ],
  );
  const fx = toFx(one(r.rows));
  return {
    status: 201,
    body: fx,
    audit: [
      { action: "pricing.fx_rate.recorded", entity: "pricing.fx_rate", entityId: id, after: fx },
    ],
    events: [
      pricingEvent(FxRateRecordedV1, ctx, `fx_rate/${id}`, {
        fxRateId: id,
        base: fx.base,
        quote: fx.quote,
        rate: fx.rate,
        validFrom: fx.validFrom,
      }),
    ],
  };
}

/** The rate in force now for every pair (DISTINCT ON over the pair index). */
export async function currentFxRates(tx: TxHandle, tenantId: string, now: Date) {
  const r = await tx.query<FxRow>(
    `select distinct on (base, quote) id, base, quote, rate::text, valid_from, source from pricing.fx_rates
     where tenant_id = $1 and valid_from <= $2 order by base, quote, valid_from desc, id desc`,
    [tenantId, now],
  );
  return r.rows.map(toFx);
}
