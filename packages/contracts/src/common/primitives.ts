import { isUuidv7 } from "@wise-biz/ids";
import { isCurrency, money } from "@wise-biz/money";
import { z } from "zod";

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Lowercase canonical UUIDv7. Output type is the branded `Uuid7`; JSON Schema keeps pattern. */
export const Uuid7 = z
  .string()
  .regex(UUID7, "must be a lowercase UUIDv7")
  .refine(isUuidv7, "must be a lowercase UUIDv7")
  .meta({ id: "Uuid7", format: "uuid" });

export const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code")
  .refine(isCurrency, "unknown currency")
  .meta({ id: "Currency" });

/**
 * Integer minor units (safe integer) + ISO 4217 code. Output is branded, frozen `Money`.
 * Transforms are not representable as output JSON Schema, so generate with `io: "input"`.
 */
export const Money = z
  .strictObject({ minor: z.int(), currency: Currency })
  .transform((v) => money(v.minor, v.currency))
  .meta({ id: "Money" });

/** ISO 8601 UTC with `Z`. */
export const Timestamp = z.iso.datetime().meta({ id: "Timestamp" });

/** Opaque keyset cursor. */
export const Cursor = z.string().min(1).max(512).regex(BASE64URL).meta({ id: "Cursor" });
