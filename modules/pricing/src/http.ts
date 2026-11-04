import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant, requireTerminal, runCommand } from "@wise-biz/module-kit";

import {
  createCouponCommand,
  createPromotionCommand,
  getPromotion,
  listCoupons,
  listPromotions,
  transitionPromotionCommand,
  updatePromotionCommand,
} from "./application/promotions.ts";
import { quote } from "./application/quote.ts";
import {
  createFeeCommand,
  createPriceListCommand,
  createTaxRegionCommand,
  currentFxRates,
  getPriceList,
  listFees,
  listPriceLists,
  listPrices,
  loadRegions,
  recordFxRateCommand,
  setPricesCommand,
  updateFeeCommand,
  updatePriceListCommand,
  updateTaxRegionCommand,
} from "./application/setup.ts";
import { notFound, pgErrors } from "./application/shared.ts";
import {
  CouponSchema,
  CreateCouponSchema,
  CreateFeeSchema,
  CreateFxRateSchema,
  CreatePriceListSchema,
  CreatePromotionSchema,
  CreateTaxRegionSchema,
  FeeSchema,
  FxRateSchema,
  PriceListSchema,
  PricePageSchema,
  PromotionSchema,
  QuoteResponseSchema,
  QuoteSchema,
  SetPricesSchema,
  TaxRegionSchema,
  UpdateFeeSchema,
  UpdatePriceListSchema,
  UpdatePromotionSchema,
  UpdateTaxRegionSchema,
  uuid7,
  VersionSchema,
} from "./schemas.ts";

import type { BatchPrices } from "./application/quote.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, CommandOptions, ModuleDeps } from "@wise-biz/module-kit";
import type { Context, MiddlewareHandler } from "hono";

/** authorize runs BEFORE validation, so an unauthorized caller gets 404 without learning the request shape. */
const needs =
  (permission: "pricing:read" | "pricing:write"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };
const read = needs("pricing:read");
const write = needs("pricing:write");
/** A signed request is a terminal (must be active); otherwise a signed-in user with pricing:read. */
const terminalOrRead: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("device") === undefined) authorize(c, "pricing:read");
  else requireTerminal(c);
  await next();
};
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const Id = z.object({ id: uuid7 });
const tags = ["pricing"];
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  200: { description, ...json(schema) },
});
const created = <T extends z.ZodType>(schema: T) => ({
  201: { description: "Created", ...json(schema) },
});
const PageQuery = z.object({
  after: uuid7.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const routes = {
  listRegions: createRoute({
    method: "get",
    path: "/v1/pricing/tax-regions",
    tags,
    summary: "Tax regions with their rules",
    middleware: read,
    responses: ok(z.object({ taxRegions: z.array(TaxRegionSchema) })),
  }),
  createRegion: createRoute({
    method: "post",
    path: "/v1/pricing/tax-regions",
    tags,
    summary:
      "Create a tax region (inclusive or exclusive, per-line or per-document rounding) with its rules",
    middleware: write,
    request: body(CreateTaxRegionSchema),
    responses: created(TaxRegionSchema),
  }),
  updateRegion: createRoute({
    method: "put",
    path: "/v1/pricing/tax-regions/{id}",
    tags,
    summary: "Replace a region's settings and rule set (optimistic lock on version)",
    middleware: write,
    request: { params: Id, ...body(UpdateTaxRegionSchema) },
    responses: ok(TaxRegionSchema),
  }),
  listLists: createRoute({
    method: "get",
    path: "/v1/pricing/price-lists",
    tags,
    summary: "Price lists (archived last)",
    middleware: read,
    responses: ok(z.object({ priceLists: z.array(PriceListSchema) })),
  }),
  getList: createRoute({
    method: "get",
    path: "/v1/pricing/price-lists/{id}",
    tags,
    summary: "One price list",
    middleware: read,
    request: { params: Id },
    responses: ok(PriceListSchema),
  }),
  createList: createRoute({
    method: "post",
    path: "/v1/pricing/price-lists",
    tags,
    summary:
      "Create a price list (currency, tax region, optional branch, customer group and validity)",
    middleware: write,
    request: body(CreatePriceListSchema),
    responses: created(PriceListSchema),
  }),
  updateList: createRoute({
    method: "patch",
    path: "/v1/pricing/price-lists/{id}",
    tags,
    summary: "Edit, archive or restore a price list (optimistic lock on version)",
    middleware: write,
    request: { params: Id, ...body(UpdatePriceListSchema) },
    responses: ok(PriceListSchema),
  }),
  listPrices: createRoute({
    method: "get",
    path: "/v1/pricing/price-lists/{id}/prices",
    tags,
    summary: "Prices of a list (keyset pages by variant id)",
    middleware: read,
    request: { params: Id, query: PageQuery },
    responses: ok(PricePageSchema),
  }),
  setPrices: createRoute({
    method: "put",
    path: "/v1/pricing/price-lists/{id}/prices",
    tags,
    summary: "Set or remove (null) up to 1000 prices; bumps the list version once",
    middleware: write,
    request: { params: Id, ...body(SetPricesSchema) },
    responses: ok(
      z.object({ priceListId: z.string(), version: z.number().int(), changed: z.number().int() }),
    ),
  }),
  listFees: createRoute({
    method: "get",
    path: "/v1/pricing/fees",
    tags,
    summary: "Fees (service charge, bag fee…)",
    middleware: read,
    responses: ok(z.object({ fees: z.array(FeeSchema) })),
  }),
  createFee: createRoute({
    method: "post",
    path: "/v1/pricing/fees",
    tags,
    summary: "Create a fee",
    middleware: write,
    request: body(CreateFeeSchema),
    responses: created(FeeSchema),
  }),
  updateFee: createRoute({
    method: "patch",
    path: "/v1/pricing/fees/{id}",
    tags,
    summary: "Edit or deactivate a fee (optimistic lock on version)",
    middleware: write,
    request: { params: Id, ...body(UpdateFeeSchema) },
    responses: ok(FeeSchema),
  }),
  listPromotions: createRoute({
    method: "get",
    path: "/v1/pricing/promotions",
    tags,
    summary: "Promotions (keyset pages; filter by status)",
    middleware: read,
    request: {
      query: PageQuery.extend({ status: z.enum(["draft", "published", "archived"]).optional() }),
    },
    responses: ok(z.object({ items: z.array(PromotionSchema), nextCursor: z.string().nullable() })),
  }),
  getPromotion: createRoute({
    method: "get",
    path: "/v1/pricing/promotions/{id}",
    tags,
    summary: "One promotion",
    middleware: read,
    request: { params: Id },
    responses: ok(PromotionSchema),
  }),
  createPromotion: createRoute({
    method: "post",
    path: "/v1/pricing/promotions",
    tags,
    summary: "Create a draft promotion",
    middleware: write,
    request: body(CreatePromotionSchema),
    responses: created(PromotionSchema),
  }),
  updatePromotion: createRoute({
    method: "patch",
    path: "/v1/pricing/promotions/{id}",
    tags,
    summary: "Edit a draft promotion (optimistic lock on version)",
    middleware: write,
    request: { params: Id, ...body(UpdatePromotionSchema) },
    responses: ok(PromotionSchema),
  }),
  publishPromotion: createRoute({
    method: "post",
    path: "/v1/pricing/promotions/{id}/publish",
    tags,
    summary: "Publish a draft (immutable from here; devices receive it)",
    middleware: write,
    request: { params: Id, ...body(VersionSchema) },
    responses: ok(PromotionSchema),
  }),
  archivePromotion: createRoute({
    method: "post",
    path: "/v1/pricing/promotions/{id}/archive",
    tags,
    summary: "Archive a promotion (stops applying everywhere)",
    middleware: write,
    request: { params: Id, ...body(VersionSchema) },
    responses: ok(PromotionSchema),
  }),
  listCoupons: createRoute({
    method: "get",
    path: "/v1/pricing/promotions/{id}/coupons",
    tags,
    summary: "Coupon codes of a promotion",
    middleware: write,
    request: { params: Id },
    responses: ok(z.object({ coupons: z.array(CouponSchema) })),
  }),
  createCoupon: createRoute({
    method: "post",
    path: "/v1/pricing/promotions/{id}/coupons",
    tags,
    summary: "Add a coupon code (unique per business, case-insensitive; optional max uses)",
    middleware: write,
    request: { params: Id, ...body(CreateCouponSchema) },
    responses: created(CouponSchema),
  }),
  listFx: createRoute({
    method: "get",
    path: "/v1/pricing/fx-rates",
    tags,
    summary: "FX rates in force now (latest per pair)",
    middleware: read,
    responses: ok(z.object({ fxRates: z.array(FxRateSchema) })),
  }),
  recordFx: createRoute({
    method: "post",
    path: "/v1/pricing/fx-rates",
    tags,
    summary: "Record an FX rate (append-only; 1 base = rate quote)",
    middleware: write,
    request: body(CreateFxRateSchema),
    responses: created(FxRateSchema),
  }),
  quote: createRoute({
    method: "post",
    path: "/v1/pricing/quote",
    tags,
    summary:
      "Price a cart server-side with the device engine (read-only; coupons checked, uses not counted)",
    middleware: terminalOrRead,
    request: body(QuoteSchema),
    responses: ok(QuoteResponseSchema, "Priced cart"),
  }),
};

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  batchPrices?: BatchPrices,
): void {
  // Every pricing mutation: pricing:write, idempotency required, constraint violations mapped to 409/422.
  const command = <I>(
    c: Context<AppEnv>,
    input: CommandOptions<I>["input"],
    handler: CommandOptions<I>["handler"],
  ) =>
    runCommand<I>(c, deps, {
      permission: "pricing:write",
      input,
      handler: (tx, b, ctx) => pgErrors(() => handler(tx, b, ctx)),
    }) as never;
  const reading = <T>(
    c: Context<AppEnv>,
    fn: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0], tenantId: string) => Promise<T>,
  ) => {
    const tenant = requireTenant(c);
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId));
  };

  app.openapi(routes.listRegions, async (c) =>
    c.json({ taxRegions: await reading(c, (tx, t) => loadRegions(tx, t)) }, 200),
  );
  app.openapi(routes.createRegion, (c) =>
    command(c, CreateTaxRegionSchema, (tx, b, ctx) => createTaxRegionCommand(tx, ctx, b)),
  );
  app.openapi(routes.updateRegion, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdateTaxRegionSchema, (tx, b, ctx) =>
      updateTaxRegionCommand(tx, ctx, id, b),
    );
  });

  app.openapi(routes.listLists, async (c) =>
    c.json({ priceLists: await reading(c, (tx, t) => listPriceLists(tx, t)) }, 200),
  );
  app.openapi(routes.getList, async (c) => {
    const { id } = c.req.valid("param");
    return c.json((await reading(c, (tx, t) => getPriceList(tx, t, id))) ?? notFound(), 200);
  });
  app.openapi(routes.createList, (c) =>
    command(c, CreatePriceListSchema, (tx, b, ctx) => createPriceListCommand(tx, ctx, b)),
  );
  app.openapi(routes.updateList, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdatePriceListSchema, (tx, b, ctx) =>
      updatePriceListCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.listPrices, async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const page = await reading(c, async (tx, t) =>
      (await getPriceList(tx, t, id)) === undefined
        ? undefined
        : listPrices(tx, t, id, q.after, q.limit ?? 200),
    );
    return c.json(page ?? notFound(), 200);
  });
  app.openapi(routes.setPrices, (c) => {
    const { id } = c.req.valid("param");
    return command(c, SetPricesSchema, (tx, b, ctx) => setPricesCommand(tx, ctx, id, b));
  });

  app.openapi(routes.listFees, async (c) =>
    c.json({ fees: await reading(c, (tx, t) => listFees(tx, t)) }, 200),
  );
  app.openapi(routes.createFee, (c) =>
    command(c, CreateFeeSchema, (tx, b, ctx) => createFeeCommand(tx, ctx, b)),
  );
  app.openapi(routes.updateFee, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdateFeeSchema, (tx, b, ctx) => updateFeeCommand(tx, ctx, id, b));
  });

  app.openapi(routes.listPromotions, async (c) => {
    const q = c.req.valid("query");
    const page = await reading(c, (tx, t) =>
      listPromotions(tx, t, { status: q.status, after: q.after, limit: q.limit ?? 100 }),
    );
    return c.json(page, 200);
  });
  app.openapi(routes.getPromotion, async (c) => {
    const { id } = c.req.valid("param");
    return c.json((await reading(c, (tx, t) => getPromotion(tx, t, id))) ?? notFound(), 200);
  });
  app.openapi(routes.createPromotion, (c) =>
    command(c, CreatePromotionSchema, (tx, b, ctx) => createPromotionCommand(tx, ctx, b)),
  );
  app.openapi(routes.updatePromotion, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdatePromotionSchema, (tx, b, ctx) =>
      updatePromotionCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.publishPromotion, (c) => {
    const { id } = c.req.valid("param");
    return command(c, VersionSchema, (tx, b, ctx) =>
      transitionPromotionCommand(tx, ctx, id, "published", b.version),
    );
  });
  app.openapi(routes.archivePromotion, (c) => {
    const { id } = c.req.valid("param");
    return command(c, VersionSchema, (tx, b, ctx) =>
      transitionPromotionCommand(tx, ctx, id, "archived", b.version),
    );
  });
  app.openapi(routes.listCoupons, async (c) => {
    const { id } = c.req.valid("param");
    const coupons = await reading(c, async (tx, t) =>
      (await getPromotion(tx, t, id)) === undefined ? undefined : listCoupons(tx, t, id),
    );
    return c.json({ coupons: coupons ?? notFound() }, 200);
  });
  app.openapi(routes.createCoupon, (c) => {
    const { id } = c.req.valid("param");
    return command(c, CreateCouponSchema, (tx, b, ctx) => createCouponCommand(tx, ctx, id, b));
  });

  app.openapi(routes.listFx, async (c) =>
    c.json(
      { fxRates: await reading(c, (tx, t) => currentFxRates(tx, t, new Date(deps.clock.now()))) },
      200,
    ),
  );
  app.openapi(routes.recordFx, (c) =>
    command(c, CreateFxRateSchema, (tx, b, ctx) => recordFxRateCommand(tx, ctx, b)),
  );

  app.openapi(routes.quote, async (c) => {
    const device = c.get("device");
    const scope =
      device === undefined
        ? requireTenant(c)
        : { tenantId: device.tenantId, requestId: c.get("requestId") };
    const input = c.req.valid("json");
    const priced = await withTenantTx(deps.pool, scope, (tx) =>
      quote(tx, scope.tenantId, input, new Date(deps.clock.now()), batchPrices),
    );
    return c.json(priced as z.infer<typeof QuoteResponseSchema>, 200);
  });
}
