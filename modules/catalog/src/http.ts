import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireTenant, requireTerminal, runCommand } from "@wise-biz/module-kit";

import {
  addVariantCommand,
  createProductCommand,
  setBarcodesCommand,
  updateProductCommand,
  updateVariantCommand,
} from "./application/products.ts";
import { getProduct, listProducts, lookupBarcode, parseInclude } from "./application/queries.ts";
import { notFound, pgErrors } from "./application/shared.ts";
import {
  createCategoryCommand,
  createTagCommand,
  createUnitCommand,
  createUnitConversionCommand,
  listCategories,
  listTags,
  listUnits,
  updateCategoryCommand,
} from "./application/taxonomy.ts";
import {
  BarcodeLookupSchema,
  BarcodeSchema,
  CategorySchema,
  CreateCategorySchema,
  CreateProductSchema,
  CreateTagSchema,
  CreateUnitConversionSchema,
  CreateUnitSchema,
  ListProductsQuerySchema,
  ProductPageSchema,
  ProductSchema,
  SetBarcodesSchema,
  TagSchema,
  UnitConversionSchema,
  UnitSchema,
  UpdateCategorySchema,
  UpdateProductSchema,
  UpdateVariantSchema,
  uuid7,
  VariantInputSchema,
  VariantSchema,
} from "./schemas.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, CommandOptions, ModuleDeps } from "@wise-biz/module-kit";
import type { Context, MiddlewareHandler } from "hono";

/** authorize runs BEFORE validation, so an unauthorized caller gets 404 without learning the request shape. */
const needs =
  (permission: "catalog:read" | "catalog:write"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };
const read = needs("catalog:read");
/** A signed request is a terminal (must be active); otherwise a signed-in user with catalog:read. Before validation. */
const terminalOrRead: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("device") === undefined) authorize(c, "catalog:read");
  else requireTerminal(c);
  await next();
};
const write = needs("catalog:write");
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const Id = z.object({ id: uuid7 });
const tags = ["catalog"];

const routes = {
  listProducts: createRoute({
    method: "get",
    path: "/v1/catalog/products",
    tags,
    summary:
      "List products (keyset pages); include=variants,barcodes,media adds one query per relation",
    middleware: read,
    request: { query: ListProductsQuerySchema },
    responses: { 200: { description: "Page", ...json(ProductPageSchema) } },
  }),
  getProduct: createRoute({
    method: "get",
    path: "/v1/catalog/products/{id}",
    tags,
    summary: "One product",
    middleware: read,
    request: { params: Id, query: ListProductsQuerySchema.pick({ include: true }) },
    responses: { 200: { description: "Product", ...json(ProductSchema) } },
  }),
  createProduct: createRoute({
    method: "post",
    path: "/v1/catalog/products",
    tags,
    summary: "Create a product with its variants and barcodes",
    middleware: write,
    request: body(CreateProductSchema),
    responses: { 201: { description: "Created", ...json(ProductSchema) } },
  }),
  updateProduct: createRoute({
    method: "patch",
    path: "/v1/catalog/products/{id}",
    tags,
    summary: "Edit, archive or restore a product (optimistic lock on version)",
    middleware: write,
    request: { params: Id, ...body(UpdateProductSchema) },
    responses: { 200: { description: "Updated", ...json(ProductSchema) } },
  }),
  addVariant: createRoute({
    method: "post",
    path: "/v1/catalog/products/{id}/variants",
    tags,
    summary: "Add a variant to a product",
    middleware: write,
    request: { params: Id, ...body(VariantInputSchema) },
    responses: { 201: { description: "Created", ...json(VariantSchema) } },
  }),
  updateVariant: createRoute({
    method: "patch",
    path: "/v1/catalog/variants/{id}",
    tags,
    summary: "Edit, archive or restore a variant (optimistic lock on version)",
    middleware: write,
    request: { params: Id, ...body(UpdateVariantSchema) },
    responses: { 200: { description: "Updated", ...json(VariantSchema) } },
  }),
  setBarcodes: createRoute({
    method: "put",
    path: "/v1/catalog/variants/{id}/barcodes",
    tags,
    summary: "Replace a variant's barcodes (unique per business, archived variants included)",
    middleware: write,
    request: { params: Id, ...body(SetBarcodesSchema) },
    responses: {
      200: {
        description: "Barcodes",
        ...json(z.object({ variantId: z.string(), barcodes: z.array(BarcodeSchema) })),
      },
    },
  }),
  lookupBarcode: createRoute({
    method: "get",
    path: "/v1/catalog/barcodes/{code}",
    tags,
    summary: "Exact barcode lookup for an active terminal (signed) or a user with catalog:read",
    middleware: terminalOrRead,
    request: { params: z.object({ code: z.string().min(1).max(64) }) },
    responses: { 200: { description: "Sellable variant", ...json(BarcodeLookupSchema) } },
  }),
  listCategories: createRoute({
    method: "get",
    path: "/v1/catalog/categories",
    tags,
    summary: "The category tree, flat, ordered by path",
    middleware: read,
    responses: {
      200: {
        description: "Categories",
        ...json(z.object({ categories: z.array(CategorySchema) })),
      },
    },
  }),
  createCategory: createRoute({
    method: "post",
    path: "/v1/catalog/categories",
    tags,
    summary: "Create a category",
    middleware: write,
    request: body(CreateCategorySchema),
    responses: { 201: { description: "Created", ...json(CategorySchema) } },
  }),
  updateCategory: createRoute({
    method: "patch",
    path: "/v1/catalog/categories/{id}",
    tags,
    summary: "Rename or move a category (its subtree moves with it)",
    middleware: write,
    request: { params: Id, ...body(UpdateCategorySchema) },
    responses: { 200: { description: "Updated", ...json(CategorySchema) } },
  }),
  listTags: createRoute({
    method: "get",
    path: "/v1/catalog/tags",
    tags,
    summary: "Tags",
    middleware: read,
    responses: { 200: { description: "Tags", ...json(z.object({ tags: z.array(TagSchema) })) } },
  }),
  createTag: createRoute({
    method: "post",
    path: "/v1/catalog/tags",
    tags,
    summary: "Create a tag",
    middleware: write,
    request: body(CreateTagSchema),
    responses: { 201: { description: "Created", ...json(TagSchema) } },
  }),
  listUnits: createRoute({
    method: "get",
    path: "/v1/catalog/units",
    tags,
    summary: "Units and conversions (no unit = each)",
    middleware: read,
    responses: {
      200: {
        description: "Units",
        ...json(
          z.object({ units: z.array(UnitSchema), conversions: z.array(UnitConversionSchema) }),
        ),
      },
    },
  }),
  createUnit: createRoute({
    method: "post",
    path: "/v1/catalog/units",
    tags,
    summary: "Create a unit",
    middleware: write,
    request: body(CreateUnitSchema),
    responses: { 201: { description: "Created", ...json(UnitSchema) } },
  }),
  createUnitConversion: createRoute({
    method: "post",
    path: "/v1/catalog/unit-conversions",
    tags,
    summary: "Create a unit conversion (1 from = factor to)",
    middleware: write,
    request: body(CreateUnitConversionSchema),
    responses: { 201: { description: "Created", ...json(UnitConversionSchema) } },
  }),
};

export function mountRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  // Every catalog mutation: catalog:write, idempotency required, constraint violations mapped to 409/422.
  const command = <I>(
    c: Context<AppEnv>,
    input: CommandOptions<I>["input"],
    handler: CommandOptions<I>["handler"],
  ) =>
    runCommand<I>(c, deps, {
      permission: "catalog:write",
      input,
      handler: (tx, b, ctx) => pgErrors(() => handler(tx, b, ctx)),
    }) as never;

  app.openapi(routes.listProducts, async (c) => {
    const tenant = requireTenant(c);
    const q = c.req.valid("query");
    const page = await withTenantTx(deps.pool, tenant, (tx) =>
      listProducts(tx, tenant.tenantId, q),
    );
    return c.json(page, 200);
  });
  app.openapi(routes.getProduct, async (c) => {
    const tenant = requireTenant(c);
    const { id } = c.req.valid("param");
    const { include } = c.req.valid("query");
    const p = await withTenantTx(deps.pool, tenant, (tx) =>
      getProduct(tx, tenant.tenantId, id, parseInclude(include)),
    );
    return c.json(p ?? notFound(), 200);
  });
  app.openapi(routes.createProduct, (c) =>
    command(c, CreateProductSchema, (tx, b, ctx) => createProductCommand(tx, ctx, b)),
  );
  app.openapi(routes.updateProduct, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdateProductSchema, (tx, b, ctx) => updateProductCommand(tx, ctx, id, b));
  });
  app.openapi(routes.addVariant, (c) => {
    const { id } = c.req.valid("param");
    return command(c, VariantInputSchema, (tx, b, ctx) => addVariantCommand(tx, ctx, id, b));
  });
  app.openapi(routes.updateVariant, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdateVariantSchema, (tx, b, ctx) => updateVariantCommand(tx, ctx, id, b));
  });
  app.openapi(routes.setBarcodes, (c) => {
    const { id } = c.req.valid("param");
    return command(c, SetBarcodesSchema, (tx, b, ctx) => setBarcodesCommand(tx, ctx, id, b));
  });

  app.openapi(routes.lookupBarcode, async (c) => {
    const device = c.get("device");
    const scope =
      device === undefined
        ? requireTenant(c)
        : { tenantId: device.tenantId, requestId: c.get("requestId") };
    const { code } = c.req.valid("param");
    const hit = await withTenantTx(deps.pool, scope, (tx) =>
      lookupBarcode(tx, scope.tenantId, code.trim()),
    );
    return c.json(hit ?? notFound(), 200);
  });

  app.openapi(routes.listCategories, async (c) => {
    const tenant = requireTenant(c);
    const categories = await withTenantTx(deps.pool, tenant, (tx) =>
      listCategories(tx, tenant.tenantId),
    );
    return c.json({ categories }, 200);
  });
  app.openapi(routes.createCategory, (c) =>
    command(c, CreateCategorySchema, (tx, b, ctx) => createCategoryCommand(tx, ctx, b)),
  );
  app.openapi(routes.updateCategory, (c) => {
    const { id } = c.req.valid("param");
    return command(c, UpdateCategorySchema, (tx, b, ctx) => updateCategoryCommand(tx, ctx, id, b));
  });
  app.openapi(routes.listTags, async (c) => {
    const tenant = requireTenant(c);
    const list = await withTenantTx(deps.pool, tenant, (tx) => listTags(tx, tenant.tenantId));
    return c.json({ tags: list }, 200);
  });
  app.openapi(routes.createTag, (c) =>
    command(c, CreateTagSchema, (tx, b, ctx) => createTagCommand(tx, ctx, b)),
  );
  app.openapi(routes.listUnits, async (c) => {
    const tenant = requireTenant(c);
    const units = await withTenantTx(deps.pool, tenant, (tx) => listUnits(tx, tenant.tenantId));
    return c.json(units, 200);
  });
  app.openapi(routes.createUnit, (c) =>
    command(c, CreateUnitSchema, (tx, b, ctx) => createUnitCommand(tx, ctx, b)),
  );
  app.openapi(routes.createUnitConversion, (c) =>
    command(c, CreateUnitConversionSchema, (tx, b, ctx) => createUnitConversionCommand(tx, ctx, b)),
  );
}
