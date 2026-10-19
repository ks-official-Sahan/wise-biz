import { ERROR_CODES } from "./codes.ts";

import type { ErrorCode } from "./codes.ts";

export interface FieldError {
  path: string;
  message: string;
}

export interface DomainErrorOptions {
  /** Internal context for logs. Never copied into the HTTP problem. */
  details?: unknown;
  fieldErrors?: FieldError[];
  cause?: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly fieldErrors?: FieldError[];

  constructor(code: ErrorCode, message: string, opts: DomainErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "DomainError";
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.fieldErrors !== undefined) this.fieldErrors = opts.fieldErrors;
  }

  get httpStatus(): number {
    return ERROR_CODES[this.code].status;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
