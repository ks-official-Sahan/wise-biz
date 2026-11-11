import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { asRouteResponse, authorize, requireTenant, runCommand } from "@wise-biz/module-kit";

import { addMessageCommand, changeStatusCommand } from "./application/replies.ts";
import { createTicketCommand, getTicket, listTickets } from "./application/tickets.ts";
import {
  AddMessageSchema,
  ChangeStatusSchema,
  CreateTicketSchema,
  IdParam,
  MessageSchema,
  TicketDetailSchema,
  TicketListQuery,
  TicketPageSchema,
  TicketSummarySchema,
} from "./schemas.ts";

import type { SupportDeps } from "./port.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, CommandOptions, ModuleDeps } from "@wise-biz/module-kit";
import type { Permission } from "@wise-biz/policy";
import type { MiddlewareHandler } from "hono";
import type { z } from "zod";

/** authorize runs as route middleware, BEFORE validation: an unauthorised caller gets 404 and learns nothing. */
const needs =
  (permission: Permission): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };
const read = needs("support:read");
const create = needs("support:create");

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const params = { params: IdParam };
const ok = <T>(schema: T) => ({ 200: { description: "OK", ...json(schema) } });
const created = <T>(schema: T) => ({ 201: { description: "Created", ...json(schema) } });
const tags = ["support"];

const routes = {
  listTickets: createRoute({
    method: "get",
    path: "/v1/support/tickets",
    tags,
    summary: "The tenant's tickets, newest first, keyset-paged; optionally by status",
    middleware: read,
    request: { query: TicketListQuery },
    responses: ok(TicketPageSchema),
  }),
  createTicket: createRoute({
    method: "post",
    path: "/v1/support/tickets",
    tags,
    summary: "Open a ticket with its first message and an optional diagnostic bundle (sanitised)",
    middleware: create,
    request: body(CreateTicketSchema),
    responses: created(TicketDetailSchema),
  }),
  getTicket: createRoute({
    method: "get",
    path: "/v1/support/tickets/{id}",
    tags,
    summary: "One ticket with its thread (internal notes are never included)",
    middleware: read,
    request: params,
    responses: ok(TicketDetailSchema),
  }),
  addMessage: createRoute({
    method: "post",
    path: "/v1/support/tickets/{id}/messages",
    tags,
    summary: "Reply on a ticket: reopens a pending or solved ticket (solved only within 14 days)",
    middleware: create,
    request: { ...params, ...body(AddMessageSchema) },
    responses: created(MessageSchema),
  }),
  changeStatus: createRoute({
    method: "post",
    path: "/v1/support/tickets/{id}/status",
    tags,
    summary: "Mark a ticket solved or closed, or reopen a solved one within 14 days",
    middleware: create,
    request: { ...params, ...body(ChangeStatusSchema) },
    responses: ok(TicketSummarySchema),
  }),
};

export function mountRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps, ports: SupportDeps): void {
  const reading = <T>(
    c: Parameters<typeof requireTenant>[0],
    fn: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0], tenantId: string) => Promise<T>,
  ) => {
    const tenant = requireTenant(c);
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId));
  };
  // Every mutation goes through runCommand: idempotency key, one transaction, audit and outbox together.
  const cmd = <I>(
    c: Parameters<typeof runCommand>[0],
    permission: Permission,
    input: z.ZodType<I>,
    handler: CommandOptions<I>["handler"],
  ) => runCommand(c, deps, { permission, input, handler }).then(asRouteResponse);

  app.openapi(routes.listTickets, async (c) => {
    const q = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => listTickets(tx, t, q)), 200);
  });
  app.openapi(routes.getTicket, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await reading(c, (tx, t) => getTicket(tx, t, id, "tenant")), 200);
  });
  app.openapi(routes.createTicket, (c) =>
    cmd(c, "support:create", CreateTicketSchema, (tx, b, ctx) =>
      createTicketCommand(tx, ctx, b, ports),
    ),
  );
  app.openapi(routes.addMessage, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "support:create", AddMessageSchema, (tx, b, ctx) =>
      addMessageCommand(tx, ctx, id, { body: b.body, author: "tenant", internal: false }),
    );
  });
  app.openapi(routes.changeStatus, (c) => {
    const { id } = c.req.valid("param");
    return cmd(c, "support:create", ChangeStatusSchema, (tx, b, ctx) =>
      changeStatusCommand(tx, ctx, id, b.status, "tenant"),
    );
  });
}
