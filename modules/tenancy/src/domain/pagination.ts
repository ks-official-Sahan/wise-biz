import { DomainError } from "@wise-biz/errors";

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

/** Clamp a client-supplied page size. Anything that is not an integer in range is a validation error. */
export function pageSize(raw: number | undefined): number {
  if (raw === undefined) return PAGE_DEFAULT;
  if (!Number.isInteger(raw) || raw < 1 || raw > PAGE_MAX) {
    throw new DomainError("VALIDATION_FAILED", "limit: out of range", {
      fieldErrors: [{ path: "limit", message: `must be an integer 1-${String(PAGE_MAX)}` }],
    });
  }
  return raw;
}
