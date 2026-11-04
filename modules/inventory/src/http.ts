import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant, runCommand } from "@wise-biz/module-kit";

import {
  listBalances,
  listMovements,
  listThresholds,
  setThresholdsCommand,
} from "./application/queries.ts";
import { pgErrors } from "./application/shared.ts";
import {
  adjustCommand,
  listBatches,
  receiveCommand,
  updateBatchCommand,
} from "./application/stock.ts";
import {
  AdjustmentSchema,
  AdjustSchema,
  BalancePageSchema,
  BalancesQuerySchema,
  BatchSchema,
  MovementPageSchema,
  MovementsQuerySchema,
  ReceiptSchema,
  ReceiveSchema,
  SetThresholdsSchema,
  ThresholdSchema,
  UpdateBatchSchema,
  uuid7,
} from "./schemas.ts";

import type { LocationExists } from "./application/stock.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv, AuthorizeResource, CommandOptions, ModuleDeps } from "@wise-biz/module-kit";
import type { Permission } from "@wise-biz/policy";
import type { Context, MiddlewareHandler } from "hono";

type InventoryPermission =
  "inventory:read" | "inventory:receive" | "inventory:adjust" | "inventory:write";
/** authorize runs BEFORE validation, so an unauthorized caller gets 404 without learning the request shape. */
const needs =
  (permission: InventoryPermission, precheck?: AuthorizeResource): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission, precheck);
    await next();
  };
const read = needs("inventory:read");
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const ok = <T extends z.ZodType>(schema: T, description = "OK") => ({
  200: { description, ...json(schema) },
});
const created = <T extends z.ZodType>(schema: T) => ({
  201: { description: "Created", ...json(schema) },
});
const Id = z.object({ id: uuid7 });
const tags = ["inventory"];
const ZERO: AuthorizeResource = { amountMinor: 0 };

const routes = {
  receive: createRoute({
    method: "post",
    path: "/v1/inventory/receipts",
    tags,
    summary:
      "Receive stock (with or without a purchase order); creates batches for batch-tracked variants",
    middleware: needs("inventory:receive"),
    request: body(ReceiveSchema),
    responses: created(ReceiptSchema),
  }),
  adjust: createRoute({
    method: "post",
    path: "/v1/inventory/adjustments",
    tags,
    summary: "Adjust stock with a reason; value over the role's limit is 412 with approver roles",
    // The value is known only after costs are read: a value-limited grant passes here, the handler checks the value.
    middleware: needs("inventory:adjust", ZERO),
    request: body(AdjustSchema),
    responses: created(AdjustmentSchema),
  }),
  balances: createRoute({
    method: "get",
    path: "/v1/inventory/balances",
    tags,
    summary: "Stock balances by location or variant (per batch with byBatch or expiringBefore)",
    middleware: read,
    request: { query: BalancesQuerySchema },
    responses: ok(BalancePageSchema),
  }),
  movements: createRoute({
    method: "get",
    path: "/v1/inventory/movements",
    tags,
    summary: "Ledger of one variant, newest first (keyset pages)",
    middleware: read,
    request: { query: MovementsQuerySchema },
    responses: ok(MovementPageSchema),
  }),
  batches: createRoute({
    method: "get",
    path: "/v1/inventory/batches",
    tags,
    summary: "Batches of a variant, earliest expiry first",
    middleware: read,
    request: { query: z.object({ variantId: uuid7, expiringBefore: z.iso.date().optional() }) },
    responses: ok(z.object({ batches: z.array(BatchSchema) })),
  }),
  updateBatch: createRoute({
    method: "patch",
    path: "/v1/inventory/batches/{id}",
    tags,
    summary: "Set or clear a batch's own sale price (wins over the price list)",
    middleware: needs("inventory:write"),
    request: { params: Id, ...body(UpdateBatchSchema) },
    responses: ok(BatchSchema),
  }),
  thresholds: createRoute({
    method: "get",
    path: "/v1/inventory/thresholds",
    tags,
    summary: "Low-stock thresholds of a location",
    middleware: read,
    request: { query: z.object({ locationId: uuid7 }) },
    responses: ok(z.object({ thresholds: z.array(ThresholdSchema) })),
  }),
  setThresholds: createRoute({
    method: "put",
    path: "/v1/inventory/thresholds",
    tags,
    summary: "Set (or remove with minQty null) up to 1000 thresholds of a location",
    middleware: needs("inventory:write"),
    request: body(SetThresholdsSchema),
    responses: ok(
      z.object({ locationId: z.string(), set: z.number().int(), removed: z.number().int() }),
    ),
  }),
};

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  locationExists: LocationExists,
): void {
  const command = <I>(
    c: Context<AppEnv>,
    permission: Permission,
    input: CommandOptions<I>["input"],
    handler: CommandOptions<I>["handler"],
    precheckResource?: AuthorizeResource,
  ) =>
    runCommand<I>(c, deps, {
      permission,
      input,
      ...(precheckResource === undefined ? {} : { precheckResource }),
      handler: (tx, b, ctx) => pgErrors(() => handler(tx, b, ctx)),
    }) as never;
  const reading = <T>(c: Context<AppEnv>, fn: (tx: TxHandle, tenantId: string) => Promise<T>) => {
    const tenant = requireTenant(c);
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId));
  };

  app.openapi(routes.receive, (c) =>
    command(c, "inventory:receive", ReceiveSchema, (tx, b, ctx) =>
      receiveCommand(tx, ctx, b, locationExists),
    ),
  );
  app.openapi(routes.adjust, (c) =>
    command(
      c,
      "inventory:adjust",
      AdjustSchema,
      (tx, b, ctx) =>
        adjustCommand(tx, ctx, b, {
          locationExists,
          authorizeValue: (amountMinor) => {
            authorize(c, "inventory:adjust", { amountMinor });
          },
        }),
      ZERO,
    ),
  );
  app.openapi(routes.balances, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listBalances(tx, t, q)), 200);
  });
  app.openapi(routes.movements, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listMovements(tx, t, q)), 200);
  });
  app.openapi(routes.batches, async (c) => {
    const q = c.req.valid("query");
    return c.json({ batches: await reading(c, (tx, t) => listBatches(tx, t, q)) }, 200);
  });
  app.openapi(routes.updateBatch, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "inventory:write", UpdateBatchSchema, (tx, b, ctx) =>
      updateBatchCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.thresholds, async (c) => {
    const { locationId } = c.req.valid("query");
    return c.json(
      { thresholds: await reading(c, (tx, t) => listThresholds(tx, t, locationId)) },
      200,
    );
  });
  app.openapi(routes.setThresholds, (c) =>
    command(c, "inventory:write", SetThresholdsSchema, (tx, b, ctx) =>
      setThresholdsCommand(tx, ctx, b),
    ),
  );
}
