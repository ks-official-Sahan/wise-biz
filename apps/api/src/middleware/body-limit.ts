import { bodyLimit as honoBodyLimit } from "hono/body-limit";

import { payloadTooLarge, problemResponse } from "../problem.ts";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function bodyLimit(maxSize = DEFAULT_BODY_LIMIT): MiddlewareHandler<AppEnv> {
  return honoBodyLimit({
    maxSize,
    onError: (c) => problemResponse(c as never, payloadTooLarge(c.get("requestId") as string)),
  });
}
