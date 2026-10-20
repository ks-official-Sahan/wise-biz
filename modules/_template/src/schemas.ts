import { PageQuery, Timestamp, Uuid7, pageOf } from "@wise-biz/contracts";
import { z } from "zod";

/** `?include=` allowlist. Anything else is a 422. */
export const INCLUDES = ["children"] as const;

export const ChildSchema = z
  .object({ id: Uuid7, label: z.string(), createdAt: Timestamp })
  .meta({ id: "TemplateChild" });

export const ItemSchema = z
  .object({
    id: Uuid7,
    name: z.string(),
    createdAt: Timestamp,
    children: z.array(ChildSchema).optional(),
  })
  .meta({ id: "TemplateItem" });

export const ItemPageSchema = pageOf(ItemSchema);

/** Domain trims and enforces 1-200; zod only bounds the payload. */
export const CreateItemSchema = z
  .object({
    name: z.string().max(1000),
    children: z.array(z.string().max(1000)).max(20).optional(),
  })
  .meta({ id: "TemplateCreateItem" });

export const ListItemsQuery = PageQuery.extend({
  include: z
    .string()
    .transform((s) => s.split(",").filter((p) => p !== ""))
    .pipe(z.array(z.enum(INCLUDES)))
    .optional(),
});

export type ItemDto = z.infer<typeof ItemSchema>;
