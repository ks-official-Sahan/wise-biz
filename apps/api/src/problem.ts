import { DomainError, toProblem } from "@wise-biz/errors";

import type { ProblemDetails } from "@wise-biz/errors";
import type { AppEnv } from "@wise-biz/module-kit";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function problemResponse(c: Context<AppEnv>, problem: ProblemDetails): Response {
  return c.body(JSON.stringify(problem), problem.status as ContentfulStatusCode, {
    "content-type": "application/problem+json",
  });
}

export function payloadTooLarge(requestId: string): ProblemDetails {
  return toProblem(
    new DomainError("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit"),
    requestId,
  );
}
