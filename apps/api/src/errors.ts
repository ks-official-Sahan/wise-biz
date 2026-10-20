import { DomainError, isDomainError, toProblem } from "@wise-biz/errors";
import { HTTPException } from "hono/http-exception";

import { problemResponse } from "./problem.ts";

import type { FieldError } from "@wise-biz/errors";
import type { AppEnv } from "@wise-biz/module-kit";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { Logger } from "pino";
import type { ZodError } from "zod";

/** zod path -> `lines[2].qty`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${String(seg)}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

export function fieldErrorsOf(error: ZodError, target: string): FieldError[] {
  return error.issues.map((i) => ({
    path: formatPath(i.path) || target,
    message: i.message,
  }));
}

/** @hono/zod-openapi defaultHook: invalid input -> VALIDATION_FAILED (422) with errors[]. */
export function validationHook(result: {
  success: boolean;
  target: string;
  error?: ZodError;
}): void {
  if (!result.success && result.error) {
    throw new DomainError("VALIDATION_FAILED", "Request validation failed", {
      fieldErrors: fieldErrorsOf(result.error, result.target),
    });
  }
}

/** Static messages only: the HTTPException message may hold internals. 405 maps to 404 to avoid route probing. */
function fromHttpException(err: HTTPException): DomainError {
  switch (err.status) {
    case 401:
      return new DomainError("UNAUTHENTICATED", "Authentication required");
    case 404:
    case 405:
      return new DomainError("NOT_FOUND", "Not found");
    case 413:
      return new DomainError("PAYLOAD_TOO_LARGE", "Payload too large");
    default:
      return err.status < 500
        ? new DomainError("VALIDATION_FAILED", "Malformed request")
        : new DomainError("INTERNAL", "Internal error");
  }
}

export function createErrorHandler(rootLogger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    const requestId = c.get("requestId");
    const log = (c.get("logger") as Logger | undefined) ?? rootLogger;
    const cause: unknown = err instanceof HTTPException ? fromHttpException(err) : err;
    if (!isDomainError(cause) || cause.code === "INTERNAL") {
      log.error({ err }, "unhandled error");
    }
    return problemResponse(c, toProblem(cause, requestId));
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  problemResponse(c, toProblem(new DomainError("NOT_FOUND", "Not found"), c.get("requestId")));
