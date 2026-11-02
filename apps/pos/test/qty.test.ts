import { describe, expect, it } from "vitest";

import { addQty, fromQty4, isWhole, toQty4 } from "../src/features/sell/model/qty.ts";

describe("quantities", () => {
  it("parses and prints decimals exactly", () => {
    expect(toQty4("1.25")).toBe(12_500);
    expect(toQty4("0.0001")).toBe(1);
    expect(toQty4("1.23456")).toBeUndefined();
    expect(toQty4("-1")).toBeUndefined();
    expect(toQty4("")).toBeUndefined();
    expect(fromQty4(12_500)).toBe("1.25");
    expect(fromQty4(20_000)).toBe("2");
    expect(fromQty4(1)).toBe("0.0001");
  });

  it("adds without float drift and refuses junk or overflow", () => {
    expect(addQty("0.1", "0.2")).toBe("0.3");
    expect(addQty("1", "1")).toBe("2");
    expect(addQty("x", "1")).toBeUndefined();
    expect(addQty("999999999", "1")).toBeUndefined();
  });

  it("knows whole quantities", () => {
    expect(isWhole("3")).toBe(true);
    expect(isWhole("3.5")).toBe(false);
    expect(isWhole("n")).toBe(false);
  });
});
