import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** Emitted in the same transaction as the item insert (outbox). */
export const TemplateItemCreatedV1 = defineEvent(
  "template.item.created",
  1,
  z.object({ itemId: z.string(), name: z.string(), childCount: z.number().int().min(0) }),
);

export const TEMPLATE_ITEM_TOPIC = "template.item";
