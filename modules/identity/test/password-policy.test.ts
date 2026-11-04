import { describe, expect, it } from "vitest";

import { checkPassword } from "../src/password-policy.ts";

describe("checkPassword", () => {
  it("accepts a long mixed password", () => {
    expect(checkPassword("Correct-Horse-Battery-9").ok).toBe(true);
  });

  it("rejects short, single-class, common and email-equal passwords", () => {
    expect(checkPassword("Ab1!").ok).toBe(false);
    expect(checkPassword("aaaaaaaaaaaaaaaa").problems.join(" ")).toMatch(/three of/);
    expect(checkPassword("Password123").ok).toBe(false);
    expect(checkPassword("p@ssw0rd").problems.join(" ")).toMatch(/common/);
    expect(
      checkPassword("alice.smith@example.com", { email: "Alice.Smith@example.com" }).problems.join(
        " ",
      ),
    ).toMatch(/email/);
  });

  it("rejects over-long passwords", () => {
    expect(checkPassword(`Aa1!${"x".repeat(130)}`).problems.join(" ")).toMatch(/at most/);
  });
});
