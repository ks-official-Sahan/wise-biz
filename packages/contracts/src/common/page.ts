import { z } from "zod";

import { Cursor } from "./primitives.ts";

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: Cursor.nullable() });
}

export const PageQuery = z
  .object({
    // Only numeric strings are coerced; `true`, "", " 5", "1e1" are rejected.
    limit: z
      .union([
        z.number(),
        z
          .string()
          .regex(/^\d{1,6}$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1).max(200))
      .default(50),
    after: Cursor.optional(),
  })
  .meta({ id: "PageQuery" });
