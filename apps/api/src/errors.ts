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

export function createErrorHandler(rootLogger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    const requestId = c.get("requestId");
    const log = (c.get("logger") as Logger | undefined) ?? rootLogger;
    let cause: unknown = err;
    if (err instanceof HTTPException && err.status < 500) {
      cause = new DomainError("VALIDATION_FAILED", "Malformed request");
    }
    if (!isDomainError(cause) || cause.code === "INTERNAL") {
      log.error({ err }, "unhandled error");
    }
    return problemResponse(c, toProblem(cause, requestId));
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  problemResponse(c, toProblem(new DomainError("NOT_FOUND", "Not found"), c.get("requestId")));
