import { createRoute, z } from "@hono/zod-openapi";
import { DomainError } from "@wise-biz/errors";
import { authorize, runCommand } from "@wise-biz/module-kit";
import { tenantKey } from "@wise-biz/storage";

import { notFound } from "./application/shared.ts";
import { uuid7 } from "./schemas.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv, CommandContext, ModuleDeps } from "@wise-biz/module-kit";
import type { ObjectStore } from "@wise-biz/storage";
import type { MiddlewareHandler } from "hono";

/** Widths the POS caches (list thumbnail, tile, detail). The client makes them; the server only signs the uploads. */
export const MEDIA_WIDTHS = ["128", "512", "1024"] as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" } as const;
type ContentType = keyof typeof EXT;
const SIZE_KEYS = ["original", ...MEDIA_WIDTHS] as const;

const CreateMediaSchema = z
  .object({
    variantId: uuid7.optional(),
    contentType: z.enum(["image/webp", "image/jpeg", "image/png"]),
    /** Byte length per size; "original" is required, the widths are optional. */
    sizes: z
      .partialRecord(z.enum(SIZE_KEYS), z.number().int().min(1).max(MAX_IMAGE_BYTES))
      .refine((s) => s.original !== undefined, "original is required"),
    alt: z.string().trim().max(200).optional(),
  })
  .strict()
  .openapi("CreateProductMedia");

const UploadSchema = z.object({
  size: z.string(),
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});
const CreatedMediaSchema = z
  .object({ id: z.string(), assetKey: z.string(), uploads: z.array(UploadSchema) })
  .openapi("ProductMediaUploads");

/** "<asset_key>/<size>.<ext>": the object for one size. */
export const mediaObjectKey = (assetKey: string, size: string, contentType: ContentType): string =>
  `${assetKey}/${size}.${EXT[contentType]}`;

const canWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  authorize(c, "catalog:write");
  await next();
};
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const createMediaRoute = createRoute({
  method: "post",
  path: "/v1/catalog/products/{id}/media",
  tags: ["catalog"],
  summary: "Add an image: returns one presigned PUT per size; confirm after uploading",
  middleware: canWrite,
  request: {
    params: z.object({ id: uuid7 }),
    body: { required: true, ...json(CreateMediaSchema) },
  },
  responses: { 201: { description: "Upload URLs", ...json(CreatedMediaSchema) } },
});
const confirmRoute = createRoute({
  method: "post",
  path: "/v1/catalog/media/{id}/confirm",
  tags: ["catalog"],
  summary: "Make an uploaded image visible (include=media lists only confirmed images)",
  middleware: canWrite,
  request: { params: z.object({ id: uuid7 }) },
  responses: {
    200: {
      description: "Confirmed",
      ...json(z.object({ id: z.string(), confirmed: z.boolean() })),
    },
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/catalog/media/{id}",
  tags: ["catalog"],
  summary: "Remove an image from its product (objects are swept by storage lifecycle rules)",
  middleware: canWrite,
  request: { params: z.object({ id: uuid7 }) },
  responses: {
    200: { description: "Removed", ...json(z.object({ id: z.string(), removed: z.boolean() })) },
  },
});

async function mediaRow(tx: TxHandle, tenantId: string, id: string) {
  const r = await tx.query<{ product_id: string; asset_key: string; uploaded: boolean }>(
    `select product_id, asset_key, uploaded_at is not null as uploaded from catalog.product_media
     where tenant_id = $1 and id = $2 for update`,
    [tenantId, id],
  );
  return r.rows[0] ?? notFound();
}

const touch = (tx: TxHandle, ctx: CommandContext, productId: string) =>
  tx.query(
    "update catalog.products set updated_at = $3, updated_by = $4 where tenant_id = $1 and id = $2",
    [ctx.tenant.tenantId, productId, ctx.now, ctx.userId],
  );

export function mountMediaRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  store: ObjectStore,
): void {
  app.openapi(createMediaRoute, async (c) => {
    const { id: productId } = c.req.valid("param");
    const res = await runCommand(c, deps, {
      permission: "catalog:write",
      input: CreateMediaSchema,
      handler: async (tx, b, ctx) => {
        const tenantId = ctx.tenant.tenantId;
        const p = await tx.query(
          `select 1 from catalog.products where tenant_id = $1 and id = $2
           and ($3::uuid is null or exists (select 1 from catalog.variants v
                where v.tenant_id = $1 and v.id = $3 and v.product_id = $2))`,
          [tenantId, productId, b.variantId ?? null],
        );
        if (p.rowCount !== 1) notFound();
        const id = ctx.ids.uuidv7();
        const assetKey = tenantKey(tenantId, "media", id);
        const sizes = SIZE_KEYS.filter((s) => b.sizes[s] !== undefined);
        const pos = await tx.query<{ n: number }>(
          "select coalesce(max(position) + 1, 0)::int as n from catalog.product_media where tenant_id = $1 and product_id = $2",
          [tenantId, productId],
        );
        const position = pos.rows[0]?.n ?? 0;
        if (position > 99) throw new DomainError("CONFLICT", "A product holds at most 100 images.");
        await tx.query(
          `insert into catalog.product_media (id, tenant_id, product_id, variant_id, asset_key, position, alt,
             content_type, sizes, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            tenantId,
            productId,
            b.variantId ?? null,
            assetKey,
            position,
            b.alt ?? null,
            b.contentType,
            sizes,
            ctx.now,
          ],
        );
        const uploads = sizes.map((size) => {
          const length = b.sizes[size] ?? 0;
          return {
            size,
            method: "PUT" as const,
            url: store.presignPut(mediaObjectKey(assetKey, size, b.contentType), {
              contentType: b.contentType,
              contentLength: length,
              expiresSeconds: UPLOAD_TTL_SECONDS,
            }),
            headers: { "content-type": b.contentType, "content-length": String(length) },
          };
        });
        return {
          status: 201,
          body: { id, assetKey, uploads },
          audit: [
            {
              action: "catalog.media.created",
              entity: "catalog.product_media",
              entityId: id,
              after: { productId, sizes, contentType: b.contentType },
            },
          ],
          // Not visible yet: the product (and its events) change on confirm.
          noEvents: true,
        };
      },
    });
    return res as never;
  });

  app.openapi(confirmRoute, async (c) => {
    const { id } = c.req.valid("param");
    const res = await runCommand(c, deps, {
      permission: "catalog:write",
      input: z.object({}).strict(),
      idempotency: "optional",
      handler: async (tx, _b, ctx) => {
        const m = await mediaRow(tx, ctx.tenant.tenantId, id);
        if (!m.uploaded) {
          await tx.query(
            "update catalog.product_media set uploaded_at = $3 where tenant_id = $1 and id = $2",
            [ctx.tenant.tenantId, id, ctx.now],
          );
          await touch(tx, ctx, m.product_id);
        }
        return {
          status: 200,
          body: { id, confirmed: true },
          audit: [
            { action: "catalog.media.confirmed", entity: "catalog.product_media", entityId: id },
          ],
          // POS caches pick media up through the product's updated_at (sync feed, P1-06); search ignores images.
          noEvents: true,
        };
      },
    });
    return res as never;
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid("param");
    const res = await runCommand(c, deps, {
      permission: "catalog:write",
      input: z.object({}).strict(),
      idempotency: "optional",
      handler: async (tx, _b, ctx) => {
        const m = await mediaRow(tx, ctx.tenant.tenantId, id);
        await tx.query("delete from catalog.product_media where tenant_id = $1 and id = $2", [
          ctx.tenant.tenantId,
          id,
        ]);
        await touch(tx, ctx, m.product_id);
        return {
          status: 200,
          body: { id, removed: true },
          audit: [
            {
              action: "catalog.media.removed",
              entity: "catalog.product_media",
              entityId: id,
              before: { productId: m.product_id, assetKey: m.asset_key },
            },
          ],
          noEvents: true,
        };
      },
    });
    return res as never;
  });
}
