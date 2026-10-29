import { join } from "node:path";

import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, defineModule, requireTenant } from "@wise-biz/module-kit";

import { searchVariants } from "./query.ts";

import type { AppEnv, WbModule } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

export { createSearchProjectionConsumer, SEARCH_PROJECTION_CONSUMER } from "./projection.ts";
export type { SearchProjectionConsumer } from "./projection.ts";

const HitSchema = z
  .object({
    variantId: z.string(),
    productId: z.string(),
    title: z.string(),
    sku: z.string(),
    barcodes: z.array(z.string()),
    score: z.number(),
  })
  .openapi("SearchHit");

/** Catalog search reads catalog data, so it needs catalog:read (checked before validation: 404 otherwise). */
const canRead: MiddlewareHandler<AppEnv> = async (c, next) => {
  authorize(c, "catalog:read");
  await next();
};

const searchRoute = createRoute({
  method: "get",
  path: "/v1/search/variants",
  tags: ["search"],
  summary:
    "Hybrid search (full text + typo-tolerant trigram, reciprocal rank fusion) over sellable variants",
  middleware: canRead,
  request: {
    query: z.object({
      q: z.string().trim().min(1).max(100),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: { description: "Best matches first", ...json(z.object({ hits: z.array(HitSchema) })) },
  },
});

function json<T>(schema: T) {
  return { content: { "application/json": { schema } } };
}

/** Search projection (ADR 0007): read side here, write side in the workers (createSearchProjectionConsumer). */
export function createSearchModule(): WbModule {
  return defineModule({
    name: "search",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: [],
    events: [],
    routes: (app, deps) => {
      app.openapi(searchRoute, async (c) => {
        const tenant = requireTenant(c);
        const { q, limit } = c.req.valid("query");
        const hits = await withTenantTx(deps.pool, tenant, (tx) =>
          searchVariants(tx, tenant.tenantId, q, limit ?? 20),
        );
        return c.json({ hits }, 200);
      });
    },
  });
}
