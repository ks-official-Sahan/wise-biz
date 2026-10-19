import { ERROR_CODES } from "@wise-biz/errors";
import { z } from "zod";

import type { ErrorCode } from "@wise-biz/errors";

/** RFC 9457 problem details; must match `toProblem` in @wise-biz/errors. */
export const Problem = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]),
    detail: z.string(),
    requestId: z.string(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .readonly()
      .optional(),
  })
  .meta({ id: "Problem" });
