// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";

import { add, allocate, format, money, parse, taxFromInclusive } from "../src/index.ts";

describe("edge runtime smoke", () => {
  it("add / allocate / tax / format / parse work without Node built-ins", () => {
    const usd = (n: number) => money(n, "USD");
    expect(add(usd(1), usd(2)).minor).toBe(3);
    expect(allocate(usd(100), [1, 1, 1]).map((m) => m.minor)).toEqual([34, 33, 33]);
    expect(taxFromInclusive(usd(1150), 1500).tax.minor).toBe(150);
    expect(format(usd(123456), "en-US")).toBe("$1,234.56");
    expect(parse("1,234.56", "USD").minor).toBe(123456);
  });
});
