import { z } from "zod";

import { KIND_IDS } from "./kinds.ts";

export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

export const ListQuerySchema = z.object({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  after: z.string().max(60).optional(),
});

export const ListSchema = z.object({
  notifications: z.array(NotificationSchema),
  next: z.string().nullable(),
});

export const UnreadSchema = z.object({ unread: z.number().int() });

export const MarkReadSchema = z
  .object({
    ids: z
      .array(
        z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "UUID"),
      )
      .min(1)
      .max(100)
      .optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.ids === undefined) !== (b.all === undefined), "Give ids or all, not both.");

export const MarkedSchema = z.object({ marked: z.number().int() });

export const PreferenceSchema = z.object({
  kind: z.enum(KIND_IDS),
  inApp: z.boolean(),
  email: z.boolean(),
});

export const PreferencesSchema = z.object({
  preferences: z.array(PreferenceSchema.extend({ label: z.string() })),
});

export const SetPreferencesSchema = z.object({
  preferences: z.array(PreferenceSchema).min(1).max(KIND_IDS.length),
});

export const PushTokenSchema = z.object({
  token: z.string().min(10).max(200),
  platform: z.enum(["ios", "android"]),
});

export const OkSchema = z.object({ ok: z.literal(true) });
