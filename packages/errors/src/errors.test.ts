import { describe, expect, it } from "vitest";

import { DomainError, ERROR_CODES, isDomainError, toProblem } from "./index.ts";

import type { ErrorCode } from "./index.ts";

describe("ERROR_CODES", () => {
  it("is frozen with unique slugs and valid statuses", () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    const slugs = Object.values(ERROR_CODES).map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of Object.values(ERROR_CODES)) expect(c.status).toBeGreaterThanOrEqual(400);
  });

  it("has no 403 except the CSRF origin guard", () => {
    const codes = Object.entries(ERROR_CODES)
      .filter(([, c]) => (c.status as number) === 403)
      .map(([k]) => k);
    expect(codes).toEqual(["ORIGIN_REJECTED"]);
  });

  it.each<[ErrorCode, number]>([
    ["VALIDATION_FAILED", 422],
    ["NOT_FOUND", 404],
    ["UNAUTHENTICATED", 401],
    ["CONFLICT", 409],
    ["IDEMPOTENCY_MISMATCH", 422],
    ["IDEMPOTENCY_IN_PROGRESS", 409],
    ["STOCK_INSUFFICIENT", 409],
    ["ENTITLEMENT_REQUIRED", 402],
    ["RATE_LIMITED", 429],
    ["RATE_LIMIT_UNAVAILABLE", 503],
    ["ORIGIN_REJECTED", 403],
    ["CURRENCY_MISMATCH", 422],
    ["PRECONDITION_FAILED", 412],
    ["INTERNAL", 500],
  ])("%s -> %i", (code, status) => {
    expect(new DomainError(code, "m").httpStatus).toBe(status);
  });
});

describe("DomainError", () => {
  it("carries code, details, fieldErrors, cause", () => {
    const cause = new Error("root");
    const e = new DomainError("CONFLICT", "dup", {
      details: { id: 1 },
      fieldErrors: [{ path: "a", message: "b" }],
      cause,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("DomainError");
    expect(e.code).toBe("CONFLICT");
    expect(e.details).toEqual({ id: 1 });
    expect(e.fieldErrors).toEqual([{ path: "a", message: "b" }]);
    expect(e.cause).toBe(cause);
    expect(isDomainError(e)).toBe(true);
    expect(isDomainError(new Error("x"))).toBe(false);
    expect(isDomainError({ code: "CONFLICT" })).toBe(false);
  });

  it("omits optional fields when absent", () => {
    const e = new DomainError("NOT_FOUND", "gone");
    expect(e.details).toBeUndefined();
    expect(e.fieldErrors).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });
});

describe("toProblem", () => {
  it("maps a domain error to RFC 9457 fields", () => {
    const p = toProblem(new DomainError("STOCK_INSUFFICIENT", "Only 2 left"), "req-1");
    expect(p).toEqual({
      type: "https://errors.wise-biz.dev/stock/insufficient",
      title: "Insufficient stock",
      status: 409,
      code: "STOCK_INSUFFICIENT",
      detail: "Only 2 left",
      requestId: "req-1",
    });
  });

  it("includes fieldErrors as errors but never details", () => {
    const p = toProblem(
      new DomainError("VALIDATION_FAILED", "bad", {
        details: { sql: "select secret" },
        fieldErrors: [{ path: "lines[2].qty", message: "must be > 0" }],
      }),
      "r",
    );
    expect(p.errors).toEqual([{ path: "lines[2].qty", message: "must be > 0" }]);
    expect(JSON.stringify(p)).not.toContain("secret");
    expect("details" in p).toBe(false);
  });

  it("omits errors when fieldErrors is empty", () => {
    const p = toProblem(new DomainError("VALIDATION_FAILED", "bad", { fieldErrors: [] }), "r");
    expect("errors" in p).toBe(false);
  });

  it.each([new Error("db password=hunter2"), "boom", null, undefined, { code: "NOT_FOUND" }])(
    "non-domain error %# -> generic INTERNAL",
    (err) => {
      const p = toProblem(err, "req-9");
      expect(p).toEqual({
        type: "https://errors.wise-biz.dev/internal",
        title: "Internal error",
        status: 500,
        code: "INTERNAL",
        detail: "Internal error",
        requestId: "req-9",
      });
    },
  );
});
