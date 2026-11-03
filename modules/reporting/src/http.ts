import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant, runCommand } from "@wise-biz/module-kit";
import { z } from "zod";

import { rebuild } from "./apply.ts";
import { payments, products, salesSummary, tax, toCsv } from "./queries.ts";
import {
  PaymentsReportSchema,
  ProductsQuerySchema,
  ProductsReportSchema,
  RangeQuerySchema,
  RebuildResultSchema,
  RebuildSchema,
  SalesQuerySchema,
  SalesReportSchema,
  TaxReportSchema,
} from "./schemas.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** authorize runs before validation: an unauthorised caller gets 404 and learns nothing about the request shape. */
const needs =
  (permission: "reporting:read" | "reporting:manage"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };
const read = needs("reporting:read");
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const ok = <T>(schema: T) => ({ 200: { description: "OK", ...json(schema) } });
const tags = ["reporting"];

const routes = {
  sales: createRoute({
    method: "get",
    path: "/v1/reporting/sales",
    tags,
    summary: "Sales by day, branch or terminal (net of voids; voids and returns beside them)",
    middleware: read,
    request: { query: SalesQuerySchema },
    responses: ok(SalesReportSchema),
  }),
  products: createRoute({
    method: "get",
    path: "/v1/reporting/products",
    tags,
    summary: "Best-selling products by revenue, with cost and profit",
    middleware: read,
    request: { query: ProductsQuerySchema },
    responses: ok(ProductsReportSchema),
  }),
  payments: createRoute({
    method: "get",
    path: "/v1/reporting/payments",
    tags,
    summary: "Payments by tender kind",
    middleware: read,
    request: { query: RangeQuerySchema },
    responses: ok(PaymentsReportSchema),
  }),
  tax: createRoute({
    method: "get",
    path: "/v1/reporting/tax",
    tags,
    summary: "Tax collected per day",
    middleware: read,
    request: { query: RangeQuerySchema },
    responses: ok(TaxReportSchema),
  }),
  salesCsv: createRoute({
    method: "get",
    path: "/v1/reporting/sales.csv",
    tags,
    summary: "The sales report as CSV (formula-safe)",
    middleware: read,
    request: { query: SalesQuerySchema },
    responses: { 200: { description: "CSV", content: { "text/csv": { schema: z.string() } } } },
  }),
  rebuild: createRoute({
    method: "post",
    path: "/v1/reporting/rebuild",
    tags,
    summary: "Recompute the rollups of a date range from the stored facts (idempotent)",
    middleware: needs("reporting:manage"),
    request: { body: { required: true, ...json(RebuildSchema) } },
    responses: ok(RebuildResultSchema),
  }),
};

export function mountRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  const reading = <T>(
    c: Parameters<typeof requireTenant>[0],
    fn: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0], tenantId: string) => Promise<T>,
  ) => {
    const tenant = requireTenant(c);
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId));
  };

  app.openapi(routes.sales, async (c) => {
    const { groupBy, ...range } = c.req.valid("query");
    return c.json(
      { groupBy, rows: await reading(c, (tx, t) => salesSummary(tx, t, range, groupBy)) },
      200,
    );
  });
  app.openapi(routes.products, async (c) => {
    const { limit, ...range } = c.req.valid("query");
    return c.json({ rows: await reading(c, (tx, t) => products(tx, t, range, limit)) }, 200);
  });
  app.openapi(routes.payments, async (c) => {
    const range = c.req.valid("query");
    return c.json({ rows: await reading(c, (tx, t) => payments(tx, t, range)) }, 200);
  });
  app.openapi(routes.tax, async (c) => {
    const range = c.req.valid("query");
    return c.json({ rows: await reading(c, (tx, t) => tax(tx, t, range)) }, 200);
  });
  app.openapi(routes.salesCsv, async (c) => {
    const { groupBy, ...range } = c.req.valid("query");
    const rows = await reading(c, (tx, t) => salesSummary(tx, t, range, groupBy));
    const body = toCsv(
      [
        groupBy,
        "currency",
        "sales",
        "subtotal",
        "discounts",
        "fees",
        "tax",
        "paid",
        "voids",
        "void value",
        "returns",
        "returned",
        "net",
      ],
      rows.map((r) => [
        r.key,
        r.currency,
        r.salesCount,
        r.subtotalMinor,
        r.discountMinor,
        r.feeMinor,
        r.taxMinor,
        r.payableMinor,
        r.voidsCount,
        r.voidsPayableMinor,
        r.returnsCount,
        r.returnsMinor,
        r.netMinor,
      ]),
    );
    return c.body(body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sales-${range.from}-${range.to}.csv"`,
      "cache-control": "no-store",
    });
  });
  app.openapi(
    routes.rebuild,
    (c) =>
      runCommand(c, deps, {
        permission: "reporting:manage",
        input: RebuildSchema,
        handler: async (tx, b, ctx) => {
          const result = await rebuild(tx, ctx.tenant.tenantId, b.from, b.to);
          return {
            status: 200,
            body: result,
            audit: [
              {
                action: "reporting.rollups.rebuilt",
                entity: "reporting.rollup",
                entityId: `${b.from}..${b.to}`,
                after: { from: b.from, to: b.to, ...result },
              },
            ],
            noEvents: true,
          };
        },
      }) as never,
  );
}
