import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant, runCommand } from "@wise-biz/module-kit";

import {
  listVersions,
  loadTemplates,
  loadTheme,
  raced,
  publishCommand,
  restoreCommand,
  saveDraftCommand,
  saveTemplateCommand,
} from "./application.ts";
import {
  PublishSchema,
  ReceiptQuerySchema,
  ReceiptTemplateSchema,
  ReceiptTemplatesSchema,
  RestoreSchema,
  SaveDraftSchema,
  SaveReceiptTemplateSchema,
  ThemeStateSchema,
  ThemeVersionSchema,
  VersionsSchema,
} from "./schemas.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** authorize runs as route middleware, i.e. BEFORE validation: an unauthorised caller gets 404 and learns nothing. */
const needs =
  (permission: "theming:read" | "theming:write"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };
const read = needs("theming:read");
const write = needs("theming:write");
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const ok = <T>(schema: T) => ({ 200: { description: "OK", ...json(schema) } });
const tags = ["theming"];

const routes = {
  state: createRoute({
    method: "get",
    path: "/v1/theming/theme",
    tags,
    summary: "The published theme and the draft being edited",
    middleware: read,
    responses: ok(ThemeStateSchema),
  }),
  saveDraft: createRoute({
    method: "put",
    path: "/v1/theming/theme/draft",
    tags,
    summary: "Save the draft (any theme the schema accepts; contrast is checked on publish)",
    middleware: write,
    request: body(SaveDraftSchema),
    responses: ok(ThemeVersionSchema),
  }),
  publish: createRoute({
    method: "post",
    path: "/v1/theming/theme/publish",
    tags,
    summary: "Publish the draft as the next version; 422 while a colour pair fails contrast",
    middleware: write,
    request: body(PublishSchema),
    responses: ok(ThemeVersionSchema),
  }),
  versions: createRoute({
    method: "get",
    path: "/v1/theming/theme/versions",
    tags,
    summary: "Published and archived versions, newest first",
    middleware: read,
    responses: ok(VersionsSchema),
  }),
  restore: createRoute({
    method: "post",
    path: "/v1/theming/theme/restore",
    tags,
    summary: "Copy an older version into the draft (publish it to roll back)",
    middleware: write,
    request: body(RestoreSchema),
    responses: ok(ThemeVersionSchema),
  }),
  templates: createRoute({
    method: "get",
    path: "/v1/theming/receipt-templates",
    tags,
    summary: "The business receipt template and, with branchId, that branch's override",
    middleware: read,
    request: { query: ReceiptQuerySchema },
    responses: ok(ReceiptTemplatesSchema),
  }),
  saveTemplate: createRoute({
    method: "put",
    path: "/v1/theming/receipt-templates",
    tags,
    summary: "Create or replace the template of the business or of one branch (optimistic version)",
    middleware: write,
    request: body(SaveReceiptTemplateSchema),
    responses: ok(ReceiptTemplateSchema),
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

  app.openapi(routes.state, async (c) => c.json(await reading(c, loadTheme), 200));
  app.openapi(routes.versions, async (c) => c.json(await reading(c, listVersions), 200));
  app.openapi(routes.templates, async (c) => {
    const { branchId } = c.req.valid("query");
    return c.json(await reading(c, (tx, t) => loadTemplates(tx, t, branchId)), 200);
  });

  app.openapi(
    routes.saveDraft,
    (c) =>
      runCommand(c, deps, {
        permission: "theming:write",
        input: SaveDraftSchema,
        handler: (tx, b, ctx) => raced(() => saveDraftCommand(tx, ctx, b)),
      }) as never,
  );
  app.openapi(
    routes.publish,
    (c) =>
      runCommand(c, deps, {
        permission: "theming:write",
        input: PublishSchema,
        handler: (tx, _b, ctx) => publishCommand(tx, ctx),
      }) as never,
  );
  app.openapi(
    routes.restore,
    (c) =>
      runCommand(c, deps, {
        permission: "theming:write",
        input: RestoreSchema,
        handler: (tx, b, ctx) => restoreCommand(tx, ctx, b),
      }) as never,
  );
  app.openapi(
    routes.saveTemplate,
    (c) =>
      runCommand(c, deps, {
        permission: "theming:write",
        input: SaveReceiptTemplateSchema,
        handler: (tx, b, ctx) => raced(() => saveTemplateCommand(tx, ctx, b)),
      }) as never,
  );
}
