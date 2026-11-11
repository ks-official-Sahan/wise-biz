import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, permits, requireTenant, runCommand } from "@wise-biz/module-kit";

import {
  approveCountCommand,
  cancelCountCommand,
  closeCountCommand,
  createCountCommand,
  getCount,
  getVariance,
  listCounts,
  openCountCommand,
  requestRecountCommand,
  scanCountCommand,
} from "./application/counts.ts";
import {
  addGapTaskCommand,
  generateGapCasesCommand,
  getGapCase,
  listGapCases,
  resolveGapCommand,
  updateGapCommand,
  updateGapTaskCommand,
} from "./application/gaps.ts";
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
  CloseCountSchema,
  CountDetailSchema,
  CountHeaderSchema,
  CountLinesQuerySchema,
  CountListQuerySchema,
  CountPageSchema,
  CountScanResultSchema,
  CountVersionSchema,
  CreateCountSchema,
  CreateGapTaskSchema,
  GapCaseDetailSchema,
  GapCasePageSchema,
  GapCaseSchema,
  GapGenerateResultSchema,
  GapListQuerySchema,
  GapTaskResultSchema,
  GenerateGapsSchema,
  MovementPageSchema,
  MovementsQuerySchema,
  ReceiptSchema,
  ReceiveSchema,
  RecountSchema,
  ResolveGapSchema,
  ScansSchema,
  SetThresholdsSchema,
  ThresholdSchema,
  UpdateBatchSchema,
  UpdateGapSchema,
  UpdateGapTaskSchema,
  uuid7,
  VarianceSchema,
} from "./schemas.ts";

import type { LocationExists } from "./application/stock.ts";
import type { GapEvidencePorts } from "./port.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv, AuthorizeResource, CommandOptions, ModuleDeps } from "@wise-biz/module-kit";
import type { Permission } from "@wise-biz/policy";
import type { Context, MiddlewareHandler } from "hono";

type InventoryPermission =
  | "inventory:read"
  | "inventory:receive"
  | "inventory:adjust"
  | "inventory:write"
  | "counts:read"
  | "counts:write"
  | "counts:approve"
  | "gaps:read"
  | "gaps:write"
  | "gaps:resolve";
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
const TaskParams = z.object({ id: uuid7, taskId: uuid7 });
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
  listCounts: createRoute({
    method: "get",
    path: "/v1/inventory/counts",
    tags,
    summary: "Stock counts, newest first, optionally by status",
    middleware: needs("counts:read"),
    request: { query: CountListQuerySchema },
    responses: ok(CountPageSchema),
  }),
  createCount: createRoute({
    method: "post",
    path: "/v1/inventory/counts",
    tags,
    summary: "Create a count (draft) and take the snapshot of expected stock at its location",
    middleware: needs("counts:write"),
    request: body(CreateCountSchema),
    responses: created(CountHeaderSchema),
  }),
  getCount: createRoute({
    method: "get",
    path: "/v1/inventory/counts/{id}",
    tags,
    summary: "One count: header and a keyset page of lines (expected hidden for blind counts)",
    middleware: needs("counts:read"),
    request: { params: Id, query: CountLinesQuerySchema },
    responses: ok(CountDetailSchema),
  }),
  countVariance: createRoute({
    method: "get",
    path: "/v1/inventory/counts/{id}/variance",
    tags,
    summary:
      "Variance per line after close, valued at line cost (hidden for blind counts without counts:approve)",
    middleware: needs("counts:read"),
    request: { params: Id },
    responses: ok(VarianceSchema),
  }),
  openCount: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/open",
    tags,
    summary: "Open a draft count for counting (scans are accepted from now on)",
    middleware: needs("counts:write"),
    request: { params: Id, ...body(CountVersionSchema) },
    responses: ok(CountHeaderSchema),
  }),
  scanCount: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/scans",
    tags,
    summary:
      "Submit device scans (idempotent per scan id); the count is not revealed in the response",
    middleware: needs("counts:write"),
    request: { params: Id, ...body(ScansSchema) },
    responses: ok(CountScanResultSchema),
  }),
  requestRecount: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/recounts",
    tags,
    summary:
      "Request a recount of lines (their counted quantity is cleared; a reviewed count reopens)",
    middleware: needs("counts:write"),
    request: { params: Id, ...body(RecountSchema) },
    responses: ok(CountHeaderSchema),
  }),
  closeCount: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/close",
    tags,
    summary:
      "Close counting: take the close cut, sum the scans, value the lines; the count awaits review",
    middleware: needs("counts:write"),
    request: { params: Id, ...body(CloseCountSchema) },
    responses: ok(CountHeaderSchema),
  }),
  approveCount: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/approve",
    tags,
    summary: "Approve a reviewed count: variances post as count_variance movements",
    middleware: needs("counts:approve"),
    request: { params: Id, ...body(CountVersionSchema) },
    responses: ok(CountHeaderSchema),
  }),
  cancelCount: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/cancel",
    tags,
    summary: "Cancel a count that is not approved (nothing has been posted)",
    middleware: needs("counts:write"),
    request: { params: Id, ...body(CountVersionSchema) },
    responses: ok(CountHeaderSchema),
  }),
  // Stock-gap cases (P2-04b). Evidence and variance are read-only; every mutation is a command.
  generateGaps: createRoute({
    method: "post",
    path: "/v1/inventory/counts/{id}/gaps",
    tags,
    summary:
      "Create gap cases from an approved count: one per line over the thresholds (idempotent per line)",
    middleware: needs("gaps:write"),
    request: { params: Id, ...body(GenerateGapsSchema) },
    responses: created(GapGenerateResultSchema),
  }),
  listGaps: createRoute({
    method: "get",
    path: "/v1/inventory/gap-cases",
    tags,
    summary: "Gap cases, newest first, by status or assignee (keyset pages)",
    middleware: needs("gaps:read"),
    request: { query: GapListQuerySchema },
    responses: ok(GapCasePageSchema),
  }),
  getGap: createRoute({
    method: "get",
    path: "/v1/inventory/gap-cases/{id}",
    tags,
    summary:
      "One gap case: its tasks and the evidence correlated within the count window (ledger and wired sales sources)",
    middleware: needs("gaps:read"),
    request: { params: Id },
    responses: ok(GapCaseDetailSchema),
  }),
  updateGap: createRoute({
    method: "patch",
    path: "/v1/inventory/gap-cases/{id}",
    tags,
    summary: "Move a case to investigating and set or clear its assignee",
    middleware: needs("gaps:write"),
    request: { params: Id, ...body(UpdateGapSchema) },
    responses: ok(GapCaseSchema),
  }),
  addGapTask: createRoute({
    method: "post",
    path: "/v1/inventory/gap-cases/{id}/tasks",
    tags,
    summary: "Add a manual task to a case",
    middleware: needs("gaps:write"),
    request: { params: Id, ...body(CreateGapTaskSchema) },
    responses: created(GapTaskResultSchema),
  }),
  updateGapTask: createRoute({
    method: "patch",
    path: "/v1/inventory/gap-cases/{id}/tasks/{taskId}",
    tags,
    summary: "Mark a task done or reassign it",
    middleware: needs("gaps:write"),
    request: { params: TaskParams, ...body(UpdateGapTaskSchema) },
    responses: ok(GapTaskResultSchema),
  }),
  resolveGap: createRoute({
    method: "post",
    path: "/v1/inventory/gap-cases/{id}/resolve",
    tags,
    summary:
      "Resolve a case once (theft, damage, data error, misplaced found, supplier short); misplaced found posts the found stock",
    middleware: needs("gaps:resolve"),
    request: { params: Id, ...body(ResolveGapSchema) },
    responses: ok(GapCaseSchema),
  }),
};

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  locationExists: LocationExists,
  gapEvidence: GapEvidencePorts,
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

  // Stock counts. Blind counts hide expected quantities from callers without counts:approve; mutation responses are
  // header summaries only (no quantities), so an idempotent replay never leaks what a blind count hides.
  app.openapi(routes.listCounts, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listCounts(tx, t, q)), 200);
  });
  app.openapi(routes.createCount, (c) =>
    command(c, "counts:write", CreateCountSchema, (tx, b, ctx) =>
      createCountCommand(tx, ctx, b, locationExists),
    ),
  );
  app.openapi(routes.getCount, async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const review = permits(c, "counts:approve");
    return c.json(await reading(c, (tx, t) => getCount(tx, t, id, q, review)), 200);
  });
  app.openapi(routes.countVariance, async (c) => {
    const { id } = c.req.valid("param");
    const review = permits(c, "counts:approve");
    return c.json(await reading(c, (tx, t) => getVariance(tx, t, id, review)), 200);
  });
  app.openapi(routes.openCount, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "counts:write", CountVersionSchema, (tx, b, ctx) =>
      openCountCommand(tx, ctx, id, b.version),
    );
  });
  app.openapi(routes.scanCount, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "counts:write", ScansSchema, (tx, b, ctx) =>
      scanCountCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.requestRecount, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "counts:write", RecountSchema, (tx, b, ctx) =>
      requestRecountCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.closeCount, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "counts:write", CloseCountSchema, (tx, b, ctx) =>
      closeCountCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.approveCount, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "counts:approve", CountVersionSchema, (tx, b, ctx) =>
      approveCountCommand(tx, ctx, id, b.version),
    );
  });
  app.openapi(routes.cancelCount, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "counts:write", CountVersionSchema, (tx, b, ctx) =>
      cancelCountCommand(tx, ctx, id, b.version),
    );
  });

  app.openapi(routes.generateGaps, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "gaps:write", GenerateGapsSchema, (tx, b, ctx) =>
      generateGapCasesCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.listGaps, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listGapCases(tx, t, q)), 200);
  });
  app.openapi(routes.getGap, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await reading(c, (tx, t) => getGapCase(tx, t, id, gapEvidence)), 200);
  });
  app.openapi(routes.updateGap, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "gaps:write", UpdateGapSchema, (tx, b, ctx) =>
      updateGapCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.addGapTask, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "gaps:write", CreateGapTaskSchema, (tx, b, ctx) =>
      addGapTaskCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.updateGapTask, (c) => {
    const { id, taskId } = c.req.valid("param");
    return command(c, "gaps:write", UpdateGapTaskSchema, (tx, b, ctx) =>
      updateGapTaskCommand(tx, ctx, id, taskId, b),
    );
  });
  app.openapi(routes.resolveGap, (c) => {
    const { id } = c.req.valid("param");
    return command(c, "gaps:resolve", ResolveGapSchema, (tx, b, ctx) =>
      resolveGapCommand(tx, ctx, id, b, locationExists),
    );
  });
}
