/**
 * Stable error code registry. Clients switch on `code`, never on text.
 *
 * There is deliberately no FORBIDDEN/403: unauthorized access to admin and
 * platform surfaces returns NOT_FOUND (404) so a surface never confirms it exists
 * (AGENTS.md non-negotiable 7).
 */
export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: { status: 422, title: "Validation failed", slug: "validation/failed" },
  NOT_FOUND: { status: 404, title: "Not found", slug: "not-found" },
  UNAUTHENTICATED: { status: 401, title: "Authentication required", slug: "unauthenticated" },
  CONFLICT: { status: 409, title: "Conflict", slug: "conflict" },
  IDEMPOTENCY_MISMATCH: {
    status: 409,
    title: "Idempotency key reused with a different request",
    slug: "idempotency/mismatch",
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    title: "Request with this idempotency key is in progress",
    slug: "idempotency/in-progress",
  },
  STOCK_INSUFFICIENT: { status: 409, title: "Insufficient stock", slug: "stock/insufficient" },
  ENTITLEMENT_REQUIRED: {
    status: 402,
    title: "Plan upgrade required",
    slug: "entitlement-required",
  },
  RATE_LIMITED: { status: 429, title: "Too many requests", slug: "rate-limited" },
  CURRENCY_MISMATCH: { status: 422, title: "Currency mismatch", slug: "money/currency-mismatch" },
  PRECONDITION_FAILED: { status: 412, title: "Precondition failed", slug: "precondition-failed" },
  INTERNAL: { status: 500, title: "Internal error", slug: "internal" },
} as const);

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_TYPE_BASE = "https://errors.wise-biz.dev/";
