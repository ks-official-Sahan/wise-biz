import { describe, expect, it } from "vitest";

import {
  buildAdjust,
  buildReceive,
  daysUntil,
  expiryCutoff,
  isQtyError,
  parseQty,
} from "./inventory.ts";
import { barRuns, ean13Modules, isEan13, sheetCount, toEan13, toZpl, zplText } from "./labels.ts";

describe("quantities", () => {
  it("accepts plain and decimal quantities and refuses the rest", () => {
    expect(parseQty("12")).toBe("12");
    expect(parseQty(" 2.5 ")).toBe("2.5");
    expect(isQtyError(parseQty("0"))).toBe(true);
    expect(isQtyError(parseQty("-3"))).toBe(true);
    expect(isQtyError(parseQty("1.23456"))).toBe(true);
    expect(isQtyError(parseQty("abc"))).toBe(true);
    expect(parseQty("-3", { signed: true })).toBe("-3");
    expect(parseQty("+4", { signed: true })).toBe("4");
    expect(isQtyError(parseQty("0.0", { signed: true }))).toBe(true);
  });

  it("computes expiry windows from dates only", () => {
    expect(expiryCutoff(30, new Date(2026, 10, 3, 23, 59))).toBe("2026-12-03");
    expect(daysUntil("2026-11-10", new Date(2026, 10, 3, 23, 59))).toBe(7);
    expect(daysUntil("2026-11-01", new Date(2026, 10, 3, 0, 0))).toBe(-2);
  });
});

describe("receive form", () => {
  const line = {
    key: "a",
    variantId: "v1",
    qty: "10",
    cost: "2.50",
    lot: "",
    expiresOn: "",
    salePrice: "",
  };

  it("builds lines with minor-unit costs and optional batch fields", () => {
    const r = buildReceive(
      [{ ...line, lot: "L1", expiresOn: "2027-01-31", salePrice: "4" }],
      "USD",
      new Set(),
    );
    expect(r).toEqual({
      ok: true,
      lines: [
        {
          variantId: "v1",
          qty: "10",
          unitCostMinor: 250,
          lotCode: "L1",
          expiresOn: "2027-01-31",
          salePriceMinor: 400,
        },
      ],
    });
  });

  it("keys each problem to its input and needs a lot or expiry for batch-tracked products", () => {
    const r = buildReceive(
      [
        { ...line, qty: "0", cost: "x" },
        { ...line, key: "b", variantId: "v2" },
      ],
      "USD",
      new Set(["v2"]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([...r.errors.keys()].sort()).toEqual(["a.cost", "a.qty", "b.lot"]);
    expect(buildReceive([], "USD", new Set())).toMatchObject({ ok: false });
    // A blank cost is not silently zero: stock valuation depends on it.
    const blank = buildReceive([{ ...line, cost: "" }], "USD", new Set());
    expect(blank.ok).toBe(false);
  });
});

describe("adjust form", () => {
  it("needs a note for other, a signed quantity and one line per variant and batch", () => {
    const ok = buildAdjust([{ key: "a", variantId: "v", batchId: null, qty: "-2" }], "damage", "");
    expect(ok).toEqual({ ok: true, lines: [{ variantId: "v", batchId: null, qty: "-2" }] });
    const bad = buildAdjust(
      [
        { key: "a", variantId: "v", batchId: null, qty: "1" },
        { key: "b", variantId: "v", batchId: null, qty: "0" },
        { key: "c", variantId: "v", batchId: null, qty: "2" },
      ],
      "other",
      " ",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect([...bad.errors.keys()].sort()).toEqual(["b.qty", "c.qty", "note"]);
  });
});

describe("labels", () => {
  it("validates EAN-13 and promotes UPC-A", () => {
    expect(isEan13("4006381333931")).toBe(true);
    expect(isEan13("4006381333932")).toBe(false);
    expect(toEan13("036000291452")).toBe("0036000291452");
    expect(toEan13("12345")).toBeNull();
  });

  it("draws 95 modules with guards and the right digits", () => {
    const m = ean13Modules("4006381333931");
    expect(m).toHaveLength(95);
    expect(m?.startsWith("101")).toBe(true);
    expect(m?.endsWith("101")).toBe(true);
    expect(m?.slice(45, 50)).toBe("01010");
    // Right half of 4006381333931 starts with 3 → R[3] = complement of 0111101.
    expect(m?.slice(50, 57)).toBe("1000010");
    expect(ean13Modules("nope")).toBeNull();
  });

  it("merges neighbouring bars", () => {
    expect(barRuns("0110100111")).toEqual([
      { x: 1, w: 2 },
      { x: 4, w: 1 },
      { x: 7, w: 3 },
    ]);
  });

  it("writes ZPL that cannot be broken by a product name", () => {
    expect(zplText("Tea ^XZ ~DG é")).toBe("Tea ?XZ ?DG ?");
    const zpl = toZpl([
      {
        variantId: "v",
        name: "Green^Tea",
        sku: "T-1",
        code: "4006381333931",
        price: "$4.00",
        copies: 3,
      },
      { variantId: "w", name: "Skipped", sku: "S", code: null, price: "", copies: 0 },
    ]);
    expect(zpl).toContain("^BEN,70,Y,N^FD400638133393^FS");
    expect(zpl).toContain("^PQ3,0,1,N");
    expect(zpl).toContain("Green?Tea");
    expect(zpl).not.toContain("Skipped");
    expect((zpl.match(/\^XA/g) ?? []).length).toBe(1);
  });

  it("falls back to Code 128 for other codes and counts sheets", () => {
    expect(
      toZpl([{ variantId: "v", name: "A", sku: "S", code: "ABC-1", price: "", copies: 1 }]),
    ).toContain("^BCN");
    expect(
      sheetCount([{ variantId: "v", name: "A", sku: "S", code: null, price: "", copies: 30 }], 24),
    ).toEqual({ labels: 30, sheets: 2 });
  });
});
