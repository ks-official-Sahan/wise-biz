import { uuidv7 } from "@wise-biz/ids";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Accept an inbound id only when it is log-safe; otherwise mint a UUIDv7. Always echoed. */
export function requestId(newId: () => string = uuidv7): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inbound = c.req.header(REQUEST_ID_HEADER);
    const id = inbound !== undefined && SAFE_ID.test(inbound) ? inbound : newId();
    c.set("requestId", id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, id);
  };
}
