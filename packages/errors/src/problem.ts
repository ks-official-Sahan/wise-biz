import { ERROR_CODES, ERROR_TYPE_BASE } from "./codes.ts";
import { isDomainError } from "./domain-error.ts";

import type { ErrorCode } from "./codes.ts";
import type { FieldError } from "./domain-error.ts";

/** RFC 9457 problem details. Mirrors `Problem` in @wise-biz/contracts. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  requestId: string;
  errors?: FieldError[];
}

/**
 * Safe for the wire: non-domain errors collapse to INTERNAL with a generic detail,
 * and domain `details` are never copied (they may hold internals).
 */
export function toProblem(err: unknown, requestId: string): ProblemDetails {
  if (!isDomainError(err)) return build("INTERNAL", "Internal error", requestId);
  const problem = build(err.code, err.message, requestId);
  if (err.fieldErrors && err.fieldErrors.length > 0) {
    problem.errors = err.fieldErrors.map(({ path, message }) => ({ path, message }));
  }
  return problem;
}

function build(code: ErrorCode, detail: string, requestId: string): ProblemDetails {
  const { status, title, slug } = ERROR_CODES[code];
  return { type: `${ERROR_TYPE_BASE}${slug}`, title, status, code, detail, requestId };
}
