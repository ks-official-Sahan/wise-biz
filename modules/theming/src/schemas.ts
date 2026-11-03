import { ThemeInputSchema } from "@wise-biz/theme";
import { z } from "zod";

const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");

export const ThemeVersionSchema = z
  .object({
    id: z.string(),
    version: z.number().int().nullable(),
    status: z.enum(["draft", "published", "archived"]),
    name: z.string(),
    input: ThemeInputSchema,
    createdAt: z.string(),
    publishedAt: z.string().nullable(),
  })
  .meta({ id: "ThemeVersion" });

export const ThemeStateSchema = z
  .object({ published: ThemeVersionSchema.nullable(), draft: ThemeVersionSchema.nullable() })
  .meta({ id: "ThemeState" });

export const SaveDraftSchema = z.object({ input: ThemeInputSchema }).meta({ id: "SaveThemeDraft" });

/** Publishing takes the stored draft, so the body is empty. */
export const PublishSchema = z.object({}).meta({ id: "PublishTheme" });

export const VersionsSchema = z
  .object({ versions: z.array(ThemeVersionSchema) })
  .meta({ id: "ThemeVersions" });

export const RestoreSchema = z
  .object({ version: z.number().int().min(1) })
  .meta({ id: "RestoreThemeVersion" });

// --- Receipt template ---

/** The blocks a receipt is made of. The order in the array is the order on the paper. */
export const BLOCK_TYPES = [
  "logo",
  "business",
  "sale-info",
  "lines",
  "totals",
  "payments",
  "text",
  "qr",
  "barcode",
] as const;

export const ReceiptBlockSchema = z.strictObject({
  type: z.enum(BLOCK_TYPES),
  /** Free text for a `text` block. */
  text: z.string().max(200).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

export const ReceiptTemplateSchema = z
  .object({
    id: z.string(),
    branchId: z.string().nullable(),
    version: z.number().int(),
    paper: z.enum(["58", "80"]),
    invoicePrefix: z.string(),
    footerText: z.string(),
    blocks: z.array(ReceiptBlockSchema),
    updatedAt: z.string(),
  })
  .meta({ id: "ReceiptTemplate" });

export const SaveReceiptTemplateSchema = z
  .object({
    branchId: uuid7.nullable().optional(),
    /** The version the editor loaded; a different stored version means someone else saved first. */
    version: z.number().int().min(1).optional(),
    paper: z.enum(["58", "80"]),
    invoicePrefix: z
      .string()
      .regex(/^[A-Z0-9-]{0,8}$/, "Up to 8 capital letters, digits or dashes."),
    footerText: z.string().max(200),
    blocks: z
      .array(ReceiptBlockSchema)
      .min(1)
      .max(30)
      .refine((b) => b.some((x) => x.type === "lines"), "A receipt needs the items block.")
      .refine((b) => b.some((x) => x.type === "totals"), "A receipt needs the totals block."),
  })
  .meta({ id: "SaveReceiptTemplate" });

export const ReceiptQuerySchema = z.object({ branchId: uuid7.optional() });

export const ReceiptTemplatesSchema = z
  .object({ templates: z.array(ReceiptTemplateSchema) })
  .meta({ id: "ReceiptTemplates" });
