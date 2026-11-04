import { describe, expect, it } from "vitest";

import {
  applyMapping,
  autoMap,
  changeSummary,
  csvField,
  inStoreBarcode,
  mappingProblems,
  parseCsv,
  parseSavedViews,
  productsQueryString,
  windowRange,
} from "./catalog.ts";

import type { EditableProduct } from "./catalog.ts";

describe("csv", () => {
  it("reads quotes, escaped quotes, CRLF, BOM and a missing final newline", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\nlast,row')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["last", "row"],
    ]);
    expect(parseCsv("a,b\n\n\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("")).toEqual([]);
  });

  it("keeps a newline inside quotes and refuses absurd files", () => {
    expect(parseCsv('a\n"multi\nline"')).toEqual([["a"], ["multi\nline"]]);
    expect(() => parseCsv("a\nb\nc\nd", 2)).toThrow("too many rows");
  });

  it("quotes only what needs it and never rewrites a value", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("multi\nline")).toBe('"multi\nline"');
    // A product called "+1 Drink" must reach the server unchanged.
    expect(csvField("+1 Drink")).toBe("+1 Drink");
    expect(csvField("=A1")).toBe("=A1");
  });
});

describe("import mapping", () => {
  it("matches headers by synonym, once each", () => {
    const m = autoMap(["Item Name", "Item Code", "EAN", "Dept", "Tax Class", "Qty"]);
    expect(m.product).toBe(0);
    expect(m.sku).toBe(1);
    expect(m.barcode).toBe(2);
    expect(m.tax_category).toBe(4);
    expect(m.unit).toBeNull();
    // "Dept" is not a known synonym; the user picks it.
    expect(m.category).toBeNull();
    const dup = autoMap(["name", "name"]);
    expect([dup.product, dup.variant].filter((x) => x !== null)).toEqual([0]);
  });

  it("writes the file with the import's own headers and only mapped columns", () => {
    const rows = [
      ["Title", "Code", "Notes"],
      ["Green Tea", "GT-1", "x"],
      ["=cmd", "S 2", "y"],
    ];
    const m = autoMap(rows[0] ?? []);
    expect(applyMapping(rows, m)).toBe("product,sku\r\nGreen Tea,GT-1\r\n=cmd,S 2\r\n");
  });

  it("names what is missing", () => {
    const none = autoMap(["a", "b"]);
    expect(mappingProblems(none)).toEqual([
      "Choose the column for Product name.",
      "Choose the column for SKU.",
    ]);
    expect(mappingProblems(autoMap(["name", "sku"]))).toEqual([]);
  });
});

describe("in-store barcodes", () => {
  it("makes valid EAN-13 codes in the 2x range", () => {
    for (const n of [0, 1, 7, 123456, 99_999_999_999]) {
      const code = inStoreBarcode(n);
      expect(code).toMatch(/^2\d{12}$/);
      // GS1 check: the weighted sum of all 13 digits is a multiple of 10.
      const sum = code.split("").reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
      expect(sum % 10).toBe(0);
    }
    expect(inStoreBarcode(5)).toBe(inStoreBarcode(5));
    expect(inStoreBarcode(5)).not.toBe(inStoreBarcode(6));
    expect(() => inStoreBarcode(-1)).toThrow(RangeError);
    expect(() => inStoreBarcode(1.5)).toThrow(RangeError);
  });
});

describe("saved views and query strings", () => {
  it("keeps only well-formed views", () => {
    const raw = JSON.stringify([
      { name: "Drinks", filter: { categoryId: "c1", archived: "all", junk: 1 } },
      { name: "", filter: {} },
      { name: "x".repeat(61), filter: {} },
      { name: "Bad status", filter: { archived: "maybe" } },
      null,
      "str",
    ]);
    expect(parseSavedViews(raw)).toEqual([
      { name: "Drinks", filter: { categoryId: "c1", archived: "all" } },
      { name: "Bad status", filter: {} },
    ]);
    expect(parseSavedViews("not json")).toEqual([]);
    expect(parseSavedViews('{"a":1}')).toEqual([]);
    expect(parseSavedViews(null)).toEqual([]);
  });

  it("asks the server for one page at a time with the filters", () => {
    expect(productsQueryString({}, null)).toBe(
      "limit=50&include=variants%2Cbarcodes&archived=false",
    );
    const q = new URLSearchParams(
      productsQueryString({ categoryId: "c", tagId: "t", archived: "all" }, "cur"),
    );
    expect(Object.fromEntries(q)).toMatchObject({
      categoryId: "c",
      tagId: "t",
      archived: "all",
      after: "cur",
      limit: "50",
    });
  });
});

describe("change summary", () => {
  const variant = (o: Partial<EditableProduct["variants"][number]> = {}) => ({
    id: "v1",
    sku: "GT-1",
    name: "Default",
    taxCategory: "standard",
    unitId: null,
    tracksBatches: false,
    barcodes: ["4006381333931"],
    version: 1,
    ...o,
  });
  const base: EditableProduct = {
    name: "Tea",
    description: "",
    categoryId: null,
    tagIds: [],
    variants: [variant()],
  };

  it("describes a new product", () => {
    expect(changeSummary(null, base)).toEqual(['Create "Tea" with 1 variant(s).']);
  });

  it("names tax, SKU and barcode changes first-class", () => {
    const after: EditableProduct = {
      ...base,
      name: "Green Tea",
      variants: [
        variant({ taxCategory: "zero_rated", sku: "GT-2", barcodes: [] }),
        variant({ id: null, sku: "GT-3" }),
      ],
    };
    const out = changeSummary(base, after);
    expect(out).toContain("GT-2: tax category standard → zero_rated.");
    expect(out).toContain("GT-1: SKU → GT-2.");
    expect(out).toContain("GT-2: barcodes 4006381333931 → none.");
    expect(out).toContain("Add variant GT-3 (Default), tax category standard.");
    expect(out).toContain('Name "Tea" → "Green Tea".');
  });

  it("is empty when nothing changed", () => {
    expect(changeSummary(base, { ...base })).toEqual([]);
  });
});

describe("list windowing", () => {
  const base = { rowHeight: 48, viewport: 800, count: 100_000, overscan: 8 };

  it("renders the viewport plus a margin from the top", () => {
    expect(windowRange({ ...base, offset: 0 })).toEqual({ start: 0, end: 25 });
  });

  it("follows the scroll position and keeps the window small anywhere in 100k rows", () => {
    const r = windowRange({ ...base, offset: 48 * 50_000 });
    expect(r.start).toBe(49_992);
    expect(r.end - r.start).toBeLessThan(45);
  });

  it("clamps at both ends and handles an empty or short list", () => {
    expect(windowRange({ ...base, offset: -5000 })).toEqual({ start: 0, end: 0 });
    expect(windowRange({ ...base, count: 0, offset: 0 })).toEqual({ start: 0, end: 0 });
    expect(windowRange({ ...base, count: 10, offset: 10_000 })).toEqual({ start: 10, end: 10 });
    expect(windowRange({ ...base, count: 10, offset: 0 })).toEqual({ start: 0, end: 10 });
  });
});
