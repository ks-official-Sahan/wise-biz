import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant, runCommand } from "@wise-biz/module-kit";
import { z } from "zod";

import {
  cancelPoCommand,
  closePoCommand,
  createPoCommand,
  getPo,
  listPos,
  receivePoCommand,
  sendPoCommand,
  updateDraftCommand,
} from "./application/orders.ts";
import {
  archiveSupplierCommand,
  createSupplierCommand,
  getSupplier,
  listPrices,
  listSuppliers,
  updateSupplierCommand,
  upsertPricesCommand,
} from "./application/suppliers.ts";
import {
  cancelTransferCommand,
  closeTransferCommand,
  createTransferCommand,
  dispatchTransferCommand,
  getTransfer,
  listTransfers,
  receiveTransferCommand,
} from "./application/transfers.ts";
import {
  CreatePoSchema,
  CreateTransferSchema,
  DispatchTransferSchema,
  ReceiveTransferSchema,
  TransferListQuery,
  TransferPageSchema,
  TransferSchema,
  CreateSupplierSchema,
  IdParam,
  PoListQuery,
  PoPageSchema,
  PoSchema,
  PriceListQuery,
  PricePageSchema,
  PriceSchema,
  ReceiveResultSchema,
  ReceiveSchema,
  SupplierListQuery,
  SupplierPageSchema,
  SupplierSchema,
  UpdatePoSchema,
  UpdateSupplierSchema,
  UpsertPricesSchema,
  VersionSchema,
} from "./schemas.ts";

import type { ProcurementDeps } from "./port.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, CommandOptions, ModuleDeps } from "@wise-biz/module-kit";
import type { Permission } from "@wise-biz/policy";
import type { MiddlewareHandler } from "hono";

/** authorize runs as route middleware, BEFORE validation: an unauthorised caller gets 404 and learns nothing. */
const needs =
  (permission: Permission): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };
const read = needs("procurement:read");
const write = needs("procurement:write");
const receive = needs("procurement:receive");

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const params = { params: IdParam };
const ok = <T>(schema: T) => ({ 200: { description: "OK", ...json(schema) } });
const created = <T>(schema: T) => ({ 201: { description: "Created", ...json(schema) } });
const tags = ["procurement"];
const PricesBody = z.object({ items: z.array(PriceSchema) }).meta({ id: "SupplierPrices" });

const routes = {
  listSuppliers: createRoute({
    method: "get",
    path: "/v1/procurement/suppliers",
    tags,
    summary: "Suppliers, keyset-paged by id",
    middleware: read,
    request: { query: SupplierListQuery },
    responses: ok(SupplierPageSchema),
  }),
  createSupplier: createRoute({
    method: "post",
    path: "/v1/procurement/suppliers",
    tags,
    summary: "Create a supplier (currency and payment terms fixed on the record)",
    middleware: write,
    request: body(CreateSupplierSchema),
    responses: created(SupplierSchema),
  }),
  getSupplier: createRoute({
    method: "get",
    path: "/v1/procurement/suppliers/{id}",
    tags,
    summary: "One supplier",
    middleware: read,
    request: params,
    responses: ok(SupplierSchema),
  }),
  updateSupplier: createRoute({
    method: "put",
    path: "/v1/procurement/suppliers/{id}",
    tags,
    summary: "Edit a supplier (optimistic version)",
    middleware: write,
    request: { ...params, ...body(UpdateSupplierSchema) },
    responses: ok(SupplierSchema),
  }),
  archiveSupplier: createRoute({
    method: "post",
    path: "/v1/procurement/suppliers/{id}/archive",
    tags,
    summary: "Archive a supplier: no new purchase orders or prices, history kept",
    middleware: write,
    request: { ...params, ...body(VersionSchema) },
    responses: ok(SupplierSchema),
  }),
  listPrices: createRoute({
    method: "get",
    path: "/v1/procurement/suppliers/{id}/prices",
    tags,
    summary: "A supplier's price list, keyset-paged by id",
    middleware: read,
    request: { ...params, query: PriceListQuery },
    responses: ok(PricePageSchema),
  }),
  upsertPrices: createRoute({
    method: "put",
    path: "/v1/procurement/suppliers/{id}/prices",
    tags,
    summary: "Upsert prices per variant and valid-from date (supplier currency only)",
    middleware: write,
    request: { ...params, ...body(UpsertPricesSchema) },
    responses: ok(PricesBody),
  }),
  listPos: createRoute({
    method: "get",
    path: "/v1/procurement/purchase-orders",
    tags,
    summary: "Purchase orders, newest first, optionally by status",
    middleware: read,
    request: { query: PoListQuery },
    responses: ok(PoPageSchema),
  }),
  createPo: createRoute({
    method: "post",
    path: "/v1/procurement/purchase-orders",
    tags,
    summary: "Create a draft purchase order",
    middleware: write,
    request: body(CreatePoSchema),
    responses: created(PoSchema),
  }),
  getPo: createRoute({
    method: "get",
    path: "/v1/procurement/purchase-orders/{id}",
    tags,
    summary: "One purchase order with its lines",
    middleware: read,
    request: params,
    responses: ok(PoSchema),
  }),
  updatePo: createRoute({
    method: "put",
    path: "/v1/procurement/purchase-orders/{id}",
    tags,
    summary: "Edit a draft (lines replaced; optimistic version)",
    middleware: write,
    request: { ...params, ...body(UpdatePoSchema) },
    responses: ok(PoSchema),
  }),
  sendPo: createRoute({
    method: "post",
    path: "/v1/procurement/purchase-orders/{id}/send",
    tags,
    summary: "Send a draft: it becomes read-only and the supplier is notified",
    middleware: write,
    request: { ...params, ...body(VersionSchema) },
    responses: ok(PoSchema),
  }),
  receivePo: createRoute({
    method: "post",
    path: "/v1/procurement/purchase-orders/{id}/receive",
    tags,
    summary: "Receive against lines: writes a receipt and stock receipts at the PO location",
    middleware: receive,
    request: { ...params, ...body(ReceiveSchema) },
    responses: created(ReceiveResultSchema),
  }),
  closePo: createRoute({
    method: "post",
    path: "/v1/procurement/purchase-orders/{id}/close",
    tags,
    summary: "Close a received or partly received PO; any shortfall is recorded as variance",
    middleware: write,
    request: { ...params, ...body(VersionSchema) },
    responses: ok(PoSchema),
  }),
  cancelPo: createRoute({
    method: "post",
    path: "/v1/procurement/purchase-orders/{id}/cancel",
    tags,
    summary: "Cancel a draft or a sent PO that has not been received against",
    middleware: write,
    request: { ...params, ...body(VersionSchema) },
    responses: ok(PoSchema),
  }),
  listTransfers: createRoute({
    method: "get",
    path: "/v1/procurement/transfers",
    tags,
    summary: "Stock transfers, newest first, optionally by status",
    middleware: read,
    request: { query: TransferListQuery },
    responses: ok(TransferPageSchema),
  }),
  createTransfer: createRoute({
    method: "post",
    path: "/v1/procurement/transfers",
    tags,
    summary: "Request a transfer between two locations (no stock moves yet)",
    middleware: write,
    request: body(CreateTransferSchema),
    responses: created(TransferSchema),
  }),
  getTransfer: createRoute({
    method: "get",
    path: "/v1/procurement/transfers/{id}",
    tags,
    summary: "One transfer with its lines and what is in transit",
    middleware: read,
    request: params,
    responses: ok(TransferSchema),
  }),
  dispatchTransfer: createRoute({
    method: "post",
    path: "/v1/procurement/transfers/{id}/dispatch",
    tags,
    summary: "Dispatch every line: stock leaves the source into the transfer's in-transit location",
    middleware: write,
    request: { ...params, ...body(DispatchTransferSchema) },
    responses: ok(TransferSchema),
  }),
  receiveTransfer: createRoute({
    method: "post",
    path: "/v1/procurement/transfers/{id}/receive",
    tags,
    summary:
      "Receive every line: stock lands at the destination; any shortage is written off as a loss",
    middleware: receive,
    request: { ...params, ...body(ReceiveTransferSchema) },
    responses: ok(TransferSchema),
  }),
  cancelTransfer: createRoute({
    method: "post",
    path: "/v1/procurement/transfers/{id}/cancel",
    tags,
    summary: "Cancel a requested transfer (only before dispatch)",
    middleware: write,
    request: { ...params, ...body(VersionSchema) },
    responses: ok(TransferSchema),
  }),
  closeTransfer: createRoute({
    method: "post",
    path: "/v1/procurement/transfers/{id}/close",
    tags,
    summary: "Close a received transfer",
    middleware: write,
    request: { ...params, ...body(VersionSchema) },
    responses: ok(TransferSchema),
  }),
};

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  ports: ProcurementDeps,
): void {
  const reading = <T>(
    c: Parameters<typeof requireTenant>[0],
    fn: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0], tenantId: string) => Promise<T>,
  ) => {
    const tenant = requireTenant(c);
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId));
  };
  // Every mutation goes through runCommand: idempotency key, one transaction, audit and outbox together.
  // The `as never` is the same route-typing bridge theming uses: runCommand's body comes from the route's own schema.
  const cmd = <I>(
    c: Parameters<typeof runCommand>[0],
    permission: Permission,
    input: z.ZodType<I>,
    handler: CommandOptions<I>["handler"],
  ) => runCommand(c, deps, { permission, input, handler }) as never;

  app.openapi(routes.listSuppliers, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listSuppliers(tx, t, q)), 200);
  });
  app.openapi(routes.getSupplier, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await reading(c, (tx, t) => getSupplier(tx, t, id)), 200);
  });
  app.openapi(routes.listPrices, async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listPrices(tx, t, id, q)), 200);
  });
  app.openapi(routes.listPos, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listPos(tx, t, q)), 200);
  });
  app.openapi(routes.getPo, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await reading(c, (tx, t) => getPo(tx, t, id)), 200);
  });

  app.openapi(routes.createSupplier, (c) =>
    cmd(c, "procurement:write", CreateSupplierSchema, (tx, b, ctx) =>
      createSupplierCommand(tx, ctx, b),
    ),
  );
  app.openapi(routes.updateSupplier, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", UpdateSupplierSchema, (tx, b, ctx) =>
      updateSupplierCommand(tx, ctx, id, b),
    );
  });
  app.openapi(routes.archiveSupplier, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", VersionSchema, (tx, b, ctx) =>
      archiveSupplierCommand(tx, ctx, id, b.version),
    );
  });
  app.openapi(routes.upsertPrices, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", UpsertPricesSchema, (tx, b, ctx) =>
      upsertPricesCommand(tx, ctx, id, b.items, ports.refs),
    );
  });

  app.openapi(routes.createPo, (c) =>
    cmd(c, "procurement:write", CreatePoSchema, (tx, b, ctx) =>
      createPoCommand(tx, ctx, b, ports.refs),
    ),
  );
  app.openapi(routes.updatePo, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", UpdatePoSchema, (tx, b, ctx) =>
      updateDraftCommand(tx, ctx, id, b, ports.refs),
    );
  });
  app.openapi(routes.sendPo, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", VersionSchema, (tx, b, ctx) =>
      sendPoCommand(tx, ctx, id, b.version),
    );
  });
  app.openapi(routes.receivePo, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:receive", ReceiveSchema, (tx, b, ctx) =>
      receivePoCommand(tx, ctx, id, b, ports),
    );
  });
  app.openapi(routes.closePo, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", VersionSchema, (tx, b, ctx) =>
      closePoCommand(tx, ctx, id, b.version),
    );
  });
  app.openapi(routes.cancelPo, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", VersionSchema, (tx, b, ctx) =>
      cancelPoCommand(tx, ctx, id, b.version),
    );
  });

  app.openapi(routes.listTransfers, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listTransfers(tx, t, q)), 200);
  });
  app.openapi(routes.getTransfer, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await reading(c, (tx, t) => getTransfer(tx, t, id)), 200);
  });
  app.openapi(routes.createTransfer, (c) =>
    cmd(c, "procurement:write", CreateTransferSchema, (tx, b, ctx) =>
      createTransferCommand(tx, ctx, b, ports),
    ),
  );
  app.openapi(routes.dispatchTransfer, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", DispatchTransferSchema, (tx, b, ctx) =>
      dispatchTransferCommand(tx, ctx, id, b, ports),
    );
  });
  app.openapi(routes.receiveTransfer, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:receive", ReceiveTransferSchema, (tx, b, ctx) =>
      receiveTransferCommand(tx, ctx, id, b, ports),
    );
  });
  app.openapi(routes.cancelTransfer, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", VersionSchema, (tx, b, ctx) =>
      cancelTransferCommand(tx, ctx, id, b.version),
    );
  });
  app.openapi(routes.closeTransfer, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "procurement:write", VersionSchema, (tx, b, ctx) =>
      closeTransferCommand(tx, ctx, id, b.version),
    );
  });
}
