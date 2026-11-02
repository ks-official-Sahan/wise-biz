import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RULES,
  checkDigit,
  createWedgeDetector,
  decode,
  isValidGtin,
  parseCustom,
  parseGs1,
  parseRetail,
  upcEToUpcA,
  validateRule,
} from "../src/index.ts";

const withCheck = (body: string) => `${body}${String(checkDigit(body))}`;

describe("retail codes", () => {
  it("validates check digits of real codes", () => {
    expect(isValidGtin("4006381333931")).toBe(true);
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("036000291452")).toBe(true);
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("123")).toBe(false);
    expect(isValidGtin("40063813339X1")).toBe(false);
  });

  it("canonicalises UPC-A and UPC-E to GTIN-13 so scans match stored codes", () => {
    expect(parseRetail("036000291452")).toEqual({
      kind: "upca",
      raw: "036000291452",
      canonical: "0036000291452",
    });
    expect(upcEToUpcA("04252614")).toBe("042100005264");
    expect(parseRetail("04252614")?.canonical).toBe("0042100005264");
    expect(parseRetail("96385074")?.kind).toBe("ean8");
    expect(parseRetail("4006381333931")?.canonical).toBe("4006381333931");
    expect(parseRetail("4006381333932")).toBeUndefined();
    expect(parseRetail("12345")).toBeUndefined();
    expect(parseRetail("abc")).toBeUndefined();
  });

  it("expands every UPC-E ending", () => {
    for (const last of ["0", "1", "2", "3", "4", "5", "9"]) {
      // Find a check digit that makes the expansion valid.
      const found = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].some(
        (c) => upcEToUpcA(`012345${last}${String(c)}`.slice(0, 8)) !== undefined,
      );
      expect(found).toBe(true);
    }
    expect(upcEToUpcA("22345678")).toBeUndefined();
  });

  it("accepts a GTIN-14", () => {
    expect(parseRetail(withCheck("1400638133393"))?.kind).toBe("gtin14");
  });

  it("any 12 digits plus its check digit is a valid EAN-13", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{12}$/), (body) => isValidGtin(withCheck(body))),
    );
  });
});

describe("variable-measure labels", () => {
  it("splits weight and price labels", () => {
    const w = parseCustom(withCheck("200123401250"));
    expect(w).toMatchObject({ item: "01234", kind: "weight_g", value: 1250 });
    const p = parseCustom(withCheck("210123400995"));
    expect(p).toMatchObject({ item: "01234", kind: "price_minor", value: 995 });
  });

  it("refuses a bad check digit, an unknown prefix or a bad rule", () => {
    expect(parseCustom("2001234012509")).toBeUndefined();
    expect(parseCustom(withCheck("225123401250"))).toBeUndefined();
    expect(parseCustom("12")).toBeUndefined();
    expect(validateRule({ prefix: "30", itemDigits: 5, valueDigits: 5, kind: "qty" })).toMatch(
      /prefix/,
    );
    expect(validateRule({ prefix: "22", itemDigits: 0, valueDigits: 10, kind: "qty" })).toMatch(
      /itemDigits/,
    );
    expect(validateRule({ prefix: "22", itemDigits: 5, valueDigits: 0, kind: "qty" })).toMatch(
      /valueDigits/,
    );
    expect(validateRule({ prefix: "22", itemDigits: 4, valueDigits: 5, kind: "qty" })).toMatch(
      /12 digits/,
    );
    expect(validateRule(DEFAULT_RULES[0] as never)).toBeUndefined();
  });

  it("honours a tenant rule", () => {
    const rules = [{ prefix: "22", itemDigits: 4, valueDigits: 6, kind: "price_minor" as const }];
    expect(parseCustom(withCheck("220042001999"), rules)).toMatchObject({
      item: "0042",
      value: 1999,
    });
  });
});

describe("GS1", () => {
  it("parses the human form with batch, expiry and weight", () => {
    const r = parseGs1("(01)09506000134352(17)261231(10)LOT42(3103)001250");
    expect(r).toMatchObject({
      ok: true,
      fields: { gtin: "09506000134352", expiry: "2026-12-31", batch: "LOT42", netWeightG: 1250 },
    });
  });

  it("parses raw data with FNC1 separators after variable fields", () => {
    const r = parseGs1("0109506000134352\u001d10AB12\u001d17270200");
    expect(r).toMatchObject({ ok: true, fields: { batch: "AB12", expiry: "2027-02-28" } });
    expect(parseGs1("010950600013435210AB12")).toMatchObject({
      ok: true,
      fields: { batch: "AB12" },
    });
  });

  it("covers dates, serial, count and kg decimals", () => {
    expect(parseGs1("(11)990101(13)240229(15)250200(21)S1(37)12(3101)000125")).toMatchObject({
      ok: true,
      fields: {
        productionDate: "1999-01-01",
        bestBefore: "2025-02-28",
        serial: "S1",
        count: 12,
        netWeightG: 12500,
      },
    });
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [
      "",
      "(01)123",
      "(17)261399",
      "(17)abc",
      "99zz",
      "(3103)12ab34",
      "(37)xx",
      "(10)",
      "(01)12345678901234x",
      "0109506000134352\u001d17",
    ]) {
      const r = parseGs1(bad);
      if (r.ok) expect(bad).toBe("never");
    }
    expect(parseGs1("(01)1234567890123x")).toMatchObject({ ok: false });
    expect(parseGs1("(17)261399")).toMatchObject({ ok: false });
    expect(parseGs1("(10)")).toMatchObject({ ok: false });
  });

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => typeof parseGs1(s).ok === "boolean"),
    );
  });
});

describe("decode", () => {
  it("routes by shape", () => {
    expect(decode("4006381333931")?.type).toBe("retail");
    expect(decode(withCheck("200123401250"))?.type).toBe("custom");
    expect(decode("(01)09506000134352(10)A")?.type).toBe("gs1");
    expect(decode("  SKU-77 ")).toEqual({ type: "plain", text: "SKU-77" });
    expect(decode("   ")).toBeUndefined();
    expect(decode("(01)bad")?.type).toBe("plain");
  });
});

describe("wedge detector", () => {
  const feed = (
    d: ReturnType<typeof createWedgeDetector>,
    keys: string[],
    start: number,
    gap: number,
  ) => keys.map((k, i) => d.push(k, start + i * gap));

  it("reports a fast burst ended by Enter as a scan and swallows it", () => {
    const d = createWedgeDetector();
    const out = feed(d, [..."4006381333931", "Enter"], 1000, 8);
    expect(out[0]).toEqual({ type: "pass" });
    expect(out[1]).toEqual({ type: "capturing" });
    expect(out.at(-1)).toEqual({ type: "scan", code: "4006381333931" });
  });

  it("lets human typing through, including a typed Enter", () => {
    const d = createWedgeDetector();
    const out = feed(d, [..."hello", "Enter"], 1000, 140);
    expect(out.every((r) => r.type === "pass")).toBe(true);
  });

  it("ignores a short burst and non-character keys", () => {
    const d = createWedgeDetector();
    expect(feed(d, ["1", "2", "Enter"], 0, 5).at(-1)).toEqual({ type: "pass" });
    expect(d.push("Shift", 100)).toEqual({ type: "pass" });
  });

  it("starts fresh after a pause and after reset", () => {
    const d = createWedgeDetector();
    feed(d, [..."123"], 0, 5);
    const out = feed(d, [..."9780306406157", "Enter"], 2000, 5);
    expect(out.at(-1)).toEqual({ type: "scan", code: "9780306406157" });
    d.push("5", 5000);
    d.push("6", 5005);
    d.reset();
    expect(d.push("Enter", 5010)).toEqual({ type: "pass" });
  });

  it("bounds the buffer", () => {
    const d = createWedgeDetector({ maxLength: 8 });
    const out = feed(d, [..."ABCDEFGHIJKL", "Enter"], 0, 3);
    expect(out.at(-1)).toEqual({ type: "scan", code: "EFGHIJKL" });
  });
});
