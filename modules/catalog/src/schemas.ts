import { z } from "@hono/zod-openapi";

import { BARCODE_FORMATS } from "./domain/barcode.ts";

export const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");
const name = (max: number) => z.string().trim().min(1).max(max);
const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, "1-64 letters, digits, . _ / -");
const taxCategory = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const attributes = z
  .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((a) => Object.keys(a).length <= 30, "At most 30 attributes");

export const BarcodeInputSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    /** Inferred from the code when absent (13 digits = EAN-13, 8 = EAN-8, 12 = UPC-A, else Code 128). */
    format: z.enum(BARCODE_FORMATS).optional(),
  })
  .strict()
  .openapi("BarcodeInput");

export const VariantInputSchema = z
  .object({
    /** Client-generated UUIDv7 (offline-created records); the server generates one when absent. */
    id: uuid7.optional(),
    sku,
    name: name(200),
    /** null = the implicit base unit "each". */
    unitId: uuid7.nullable().optional(),
    tracksBatches: z.boolean().optional(),
    taxCategory: taxCategory.optional(),
    attributes: attributes.optional(),
    barcodes: z.array(BarcodeInputSchema).max(20).optional(),
  })
  .strict()
  .openapi("VariantInput");
export type VariantInput = z.infer<typeof VariantInputSchema>;

export const CreateProductSchema = z
  .object({
    id: uuid7.optional(),
    name: name(200),
    description: z.string().max(4000).optional(),
    categoryId: uuid7.nullable().optional(),
    tagIds: z.array(uuid7).max(50).optional(),
    variants: z.array(VariantInputSchema).min(1).max(100),
  })
  .strict()
  .openapi("CreateProduct");
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z
  .object({
    /** Optimistic lock: the version you read. A stale version gets 409. */
    version: z.number().int().min(1),
    name: name(200).optional(),
    description: z.string().max(4000).nullable().optional(),
    categoryId: uuid7.nullable().optional(),
    tagIds: z.array(uuid7).max(50).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .openapi("UpdateProduct");
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

export const UpdateVariantSchema = z
  .object({
    version: z.number().int().min(1),
    sku: sku.optional(),
    name: name(200).optional(),
    unitId: uuid7.nullable().optional(),
    tracksBatches: z.boolean().optional(),
    taxCategory: taxCategory.optional(),
    attributes: attributes.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .openapi("UpdateVariant");
export type UpdateVariantInput = z.infer<typeof UpdateVariantSchema>;

export const SetBarcodesSchema = z
  .object({ barcodes: z.array(BarcodeInputSchema).max(20) })
  .strict()
  .openapi("SetBarcodes");

export const CreateCategorySchema = z
  .object({ id: uuid7.optional(), name: name(120), parentId: uuid7.nullable().optional() })
  .strict()
  .openapi("CreateCategory");
export const UpdateCategorySchema = z
  .object({ name: name(120).optional(), parentId: uuid7.nullable().optional() })
  .strict()
  .openapi("UpdateCategory");
export const CreateTagSchema = z
  .object({ id: uuid7.optional(), name: name(60) })
  .strict()
  .openapi("CreateTag");
export const CreateUnitSchema = z
  .object({
    id: uuid7.optional(),
    code: z.string().regex(/^[a-z0-9_.-]{1,16}$/),
    name: name(60),
    decimals: z.number().int().min(0).max(4).optional(),
  })
  .strict()
  .openapi("CreateUnit");
export const CreateUnitConversionSchema = z
  .object({
    fromUnitId: uuid7,
    toUnitId: uuid7,
    /** Decimal string (no floats for quantities): 1 from = factor to. */
    factor: z
      .string()
      .regex(/^(?!0+(\.0+)?$)\d{1,12}(\.\d{1,6})?$/, "Positive decimal, up to 6 places"),
  })
  .strict()
  .openapi("CreateUnitConversion");

// ---- responses ----

export const BarcodeSchema = z.object({ code: z.string(), format: z.string() }).openapi("Barcode");
export const MediaSchema = z
  .object({
    id: z.string(),
    variantId: z.string().nullable(),
    assetKey: z.string(),
    position: z.number(),
    alt: z.string().nullable(),
  })
  .openapi("ProductMedia");
export const VariantSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    sku: z.string(),
    name: z.string(),
    unitId: z.string().nullable(),
    tracksBatches: z.boolean(),
    taxCategory: z.string(),
    attributes: z.record(z.string(), z.unknown()),
    version: z.number(),
    archived: z.boolean(),
    updatedAt: z.string(),
    barcodes: z.array(BarcodeSchema).optional(),
  })
  .openapi("Variant");
export type VariantDto = z.infer<typeof VariantSchema>;
export const ProductSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    categoryId: z.string().nullable(),
    tagIds: z.array(z.string()),
    version: z.number(),
    archived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    variants: z.array(VariantSchema).optional(),
    media: z.array(MediaSchema).optional(),
  })
  .openapi("Product");
export type ProductDto = z.infer<typeof ProductSchema>;
export const ProductPageSchema = z
  .object({ products: z.array(ProductSchema), next: z.string().nullable() })
  .openapi("ProductPage");

export const INCLUDES = ["variants", "barcodes", "media"] as const;
export type Include = (typeof INCLUDES)[number];

export const ListProductsQuerySchema = z.object({
  after: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  categoryId: uuid7.optional().openapi({ description: "Includes the whole subtree" }),
  tagId: uuid7.optional(),
  archived: z.enum(["false", "true", "all"]).optional(),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  include: z
    .string()
    .regex(/^(variants|barcodes|media)(,(variants|barcodes|media))*$/)
    .optional()
    .openapi({ description: "Comma list: variants, barcodes (implies variants), media" }),
});
export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;

export const BarcodeLookupSchema = z
  .object({
    code: z.string(),
    format: z.string(),
    variant: VariantSchema,
    product: z.object({ id: z.string(), name: z.string(), categoryId: z.string().nullable() }),
  })
  .openapi("BarcodeLookup");

export const CategorySchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    path: z.array(z.string()),
  })
  .openapi("Category");
export const TagSchema = z.object({ id: z.string(), name: z.string() }).openapi("Tag");
export const UnitSchema = z
  .object({ id: z.string(), code: z.string(), name: z.string(), decimals: z.number() })
  .openapi("Unit");
export const UnitConversionSchema = z
  .object({ id: z.string(), fromUnitId: z.string(), toUnitId: z.string(), factor: z.string() })
  .openapi("UnitConversion");
