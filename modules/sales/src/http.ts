import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { authorize, permits, requireTenant } from "@wise-biz/module-kit";

import { getSale, getShift, listSales, listShifts, parseIncludes } from "./application/queries.ts";
import { ZReport } from "./events.ts";
import {
  IdParam,
  SalePageSchema,
  SalesQuerySchema,
  SaleSchema,
  ShiftPageSchema,
  ShiftsQuerySchema,
  ShiftSchema,
} from "./schemas.ts";

import type { BranchScope } from "./application/queries.ts";
import type { OpenAPIHono, z } from "@hono/zod-openapi";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { Context, MiddlewareHandler } from "hono";

/** What the caller may read, decided by the route middleware (before validation) and handed to the handler. */
const scopes = new WeakMap<Request, BranchScope>();

/**
 * authorize runs BEFORE validation, so an unauthorized caller gets 404 without learning the request shape. A member
 * limited to some branches is checked per branch (the policy denies a branch-less check for them): they see the
 * branches where they hold sales:read, and nothing (404) when there is none.
 */
const read: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (auth.kind === "user" && auth.branchScope !== "all") {
    const allowed = auth.branchScope.filter((branchId) => permits(c, "sales:read", { branchId }));
    if (allowed.length === 0) throw new DomainError("NOT_FOUND", "Not found");
    scopes.set(c.req.raw, allowed);
  } else {
    authorize(c, "sales:read");
    scopes.set(c.req.raw, "all");
  }
  await next();
};
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const ok = <T extends z.ZodType>(schema: T) => ({ 200: { description: "OK", ...json(schema) } });
const tags = ["sales"];

const routes = {
  sales: createRoute({
    method: "get",
    path: "/v1/sales/sales",
    tags,
    summary:
      "Sales, newest first (keyset). Filters: branch, shift, customer, status, business dates, flagged. include=lines,tenders,returns,void adds each with one query for the page",
    middleware: read,
    request: { query: SalesQuerySchema },
    responses: ok(SalePageSchema),
  }),
  sale: createRoute({
    method: "get",
    path: "/v1/sales/sales/{id}",
    tags,
    summary: "One sale; lines, tenders, returns and void come with ?include=",
    middleware: read,
    request: { params: IdParam, query: SalesQuerySchema.pick({ include: true }) },
    responses: ok(SaleSchema),
  }),
  shifts: createRoute({
    method: "get",
    path: "/v1/sales/shifts",
    tags,
    summary: "Shifts, newest first (keyset)",
    middleware: read,
    request: { query: ShiftsQuerySchema },
    responses: ok(ShiftPageSchema),
  }),
  shift: createRoute({
    method: "get",
    path: "/v1/sales/shifts/{id}",
    tags,
    summary: "One shift with its Z-report (frozen at close, null while open)",
    middleware: read,
    request: { params: IdParam },
    responses: ok(ShiftSchema),
  }),
  zReport: createRoute({
    method: "get",
    path: "/v1/sales/shifts/{id}/z-report",
    tags,
    summary: "The Z-report of a closed shift (404 while it is open)",
    middleware: read,
    request: { params: IdParam },
    responses: ok(ZReport),
  }),
};

const notFound = (): never => {
  throw new DomainError("NOT_FOUND", "Not found");
};

export function mountRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  const reading = <T>(
    c: Context<AppEnv>,
    fn: (tx: TxHandle, tenantId: string, scope: BranchScope) => Promise<T>,
  ) => {
    const tenant = requireTenant(c);
    const scope = scopes.get(c.req.raw) ?? [];
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId, scope));
  };
  const includes = (raw: string | undefined) =>
    parseIncludes(raw) ??
    (() => {
      throw new DomainError("VALIDATION_FAILED", "Unknown include.", {
        fieldErrors: [{ path: "include", message: "Use lines, tenders, returns, void." }],
      });
    })();

  app.openapi(routes.sales, async (c) => {
    const q = c.req.valid("query");
    const include = includes(q.include);
    return c.json(await reading(c, (tx, t, s) => listSales(tx, t, s, q, include)), 200);
  });
  app.openapi(routes.sale, async (c) => {
    const { id } = c.req.valid("param");
    const include = includes(c.req.valid("query").include);
    const sale = await reading(c, (tx, t, s) => getSale(tx, t, s, id, include));
    return c.json(sale ?? notFound(), 200);
  });
  app.openapi(routes.shifts, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t, s) => listShifts(tx, t, s, q)), 200);
  });
  app.openapi(routes.shift, async (c) => {
    const { id } = c.req.valid("param");
    const shift = await reading(c, (tx, t, s) => getShift(tx, t, s, id));
    return c.json(shift ?? notFound(), 200);
  });
  app.openapi(routes.zReport, async (c) => {
    const { id } = c.req.valid("param");
    const shift = await reading(c, (tx, t, s) => getShift(tx, t, s, id));
    return c.json(shift?.zReport ?? notFound(), 200);
  });
}
