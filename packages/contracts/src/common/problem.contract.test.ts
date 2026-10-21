import { DomainError, toProblem } from "@wise-biz/errors";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Problem } from "./problem.ts";

import type { ProblemDetails } from "@wise-biz/errors";
import type { z } from "zod";

describe("Problem ↔ @wise-biz/errors toProblem", () => {
  it("accepts every problem toProblem produces", () => {
    const domain = new DomainError("STOCK_INSUFFICIENT", "Not enough stock", {
      fieldErrors: [{ path: "lines[0].qty", message: "exceeds on-hand" }],
    });
    expect(Problem.safeParse(toProblem(domain, "req-1")).success).toBe(true);
    expect(Problem.safeParse(toProblem(new Error("boom"), "req-2")).success).toBe(true);
  });

  it("rejects codes outside the registry", () => {
    const problem = toProblem(new DomainError("NOT_FOUND", "x"), "req-3");
    expect(Problem.safeParse({ ...problem, code: "MADE_UP" }).success).toBe(false);
  });
});

describe("Problem type link", () => {
  it("z.output<Problem> and ProblemDetails are mutually assignable", () => {
    expectTypeOf<z.output<typeof Problem>>().toExtend<ProblemDetails>();
    expectTypeOf<ProblemDetails>().toExtend<z.output<typeof Problem>>();
  });
});
