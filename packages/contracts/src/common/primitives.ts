import { isCurrency } from "@wise-biz/money";
import { z } from "zod";

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const Uuid7 = z.string().regex(UUID7, "must be a lowercase UUIDv7").meta({ id: "Uuid7" });

export const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code")
  .refine(isCurrency, "unknown currency")
  .meta({ id: "Currency" });

/** Integer minor units (safe integer) + ISO 4217 code. */
export const Money = z
  .object({ minor: z.number().int(), currency: Currency })
  .meta({ id: "Money" });

/** ISO 8601 UTC with `Z`. */
export const Timestamp = z.iso.datetime().meta({ id: "Timestamp" });

/** Opaque keyset cursor. */
export const Cursor = z.string().min(1).max(512).regex(BASE64URL).meta({ id: "Cursor" });
