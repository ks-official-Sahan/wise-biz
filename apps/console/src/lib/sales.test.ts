import { describe, expect, it } from "vitest";

import { operatorLabel, operatorNames, shortId } from "./sales.ts";

const ME = "0190f3a2-1111-7000-8000-000000000001";
const OTHER = "0190f3a2-2222-7000-8000-000000000002";

describe("operator labels", () => {
  it("shows You for the signed-in member and a short id for the others", () => {
    const names = operatorNames([{ userId: ME }, { userId: OTHER }], ME);
    expect(operatorLabel(ME, names)).toBe("You");
    expect(operatorLabel(OTHER, names)).toBe(shortId(OTHER));
  });
  it("falls back to a short id for someone who is no longer a member", () => {
    expect(operatorLabel(OTHER, operatorNames([{ userId: ME }], ME))).toBe(shortId(OTHER));
    expect(shortId(OTHER)).toHaveLength(9);
  });
});
