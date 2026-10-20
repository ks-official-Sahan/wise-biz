import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant } from "@wise-biz/module-kit";

import { createItem, listItems } from "../../application/items.ts";
import { CreateItemSchema, ItemPageSchema, ItemSchema, ListItemsQuery } from "../../schemas.ts";
import { drizzleItemRepository } from "../db/item-repository.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** authorize runs as route middleware, i.e. BEFORE zod validation (authorize -> validate). */
const needs =
  (permission: "template:read" | "template:write"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };

const listRoute = createRoute({
  method: "get",
  path: "/v1/template/items",
  tags: ["template"],
  summary: "List items (keyset). ?include=children expands children in one batched query.",
  middleware: [needs("template:read")] as const,
  request: { query: ListItemsQuery },
  responses: {
    200: {
      description: "Page of items",
      content: { "application/json": { schema: ItemPageSchema } },
    },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/v1/template/items",
  tags: ["template"],
  summary: "Create an item with optional children",
  middleware: [needs("template:write")] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: CreateItemSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ItemSchema } } },
  },
});

export function mountRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  const repo = drizzleItemRepository;

  app.openapi(listRoute, async (c) => {
    const tenant = requireTenant(c);
    const q = c.req.valid("query");
    const page = await withTenantTx(deps.pool, tenant, (tx) =>
      listItems({ repo }, tx, tenant.tenantId, q),
    );
    return c.json(page, 200);
  });

  app.openapi(createRoute_, async (c) => {
    const tenant = requireTenant(c);
    const body = c.req.valid("json");
    const created = await withTenantTx(deps.pool, tenant, (tx) =>
      createItem({ repo, clock: deps.clock, ids: deps.ids }, tx, tenant.tenantId, body),
    );
    return c.json(created, 201);
  });
}
