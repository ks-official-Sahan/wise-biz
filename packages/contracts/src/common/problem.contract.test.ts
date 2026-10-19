import { DomainError, toProblem } from "@wise-biz/errors";
import { describe, expect, it } from "vitest";

import { Problem } from "./problem.ts";

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
