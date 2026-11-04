import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** One topic keyed by tenant: a publish and the receipt change that follows arrive in order. */
export const THEMING_TOPIC = "theming";

/** The sync feed and live terminals pick this up: the theme document itself rides in `input`. */
export const ThemePublishedV1 = defineEvent(
  "theming.theme.published",
  1,
  z.object({
    themeId: z.string(),
    version: z.number().int().min(1),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
);

export const ReceiptTemplateChangedV1 = defineEvent(
  "theming.receipt_template.changed",
  1,
  z.object({
    templateId: z.string(),
    branchId: z.string().nullable(),
    version: z.number().int().min(1),
  }),
);

export const THEMING_EVENTS = [ThemePublishedV1, ReceiptTemplateChangedV1] as const;
