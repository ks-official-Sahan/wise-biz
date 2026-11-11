import { describe, expect, it } from "vitest";

import {
  buildCount,
  buildGapThresholds,
  buildRecount,
  countActions,
  countLineStatusText,
  countLinesQuery,
  countProgressPercent,
  countProgressText,
  countVarianceText,
  expectedText,
  lineKey,
  lineValueText,
  varianceTotalsText,
} from "./counts.ts";
import { parsePrice } from "./pricing.ts";

const LOC = "0190a000-0000-7000-8000-000000000001";
const V1 = "0190a000-0000-7000-8000-000000000002";
const B1 = "0190a000-0000-7000-8000-000000000003";

const base = {
  locationId: LOC,
  kind: "full" as const,
  variantIds: [],
  blind: false,
  mode: "frozen" as const,
  currency: "usd",
  note: "",
};

describe("count actions and words", () => {
  it("offers only the actions each state allows", () => {
    expect(countActions("draft")).toMatchObject({
      open: true,
      close: false,
      approve: false,
      cancel: true,
    });
    expect(countActions("open")).toMatchObject({ close: true, recount: true, approve: false });
    expect(countActions("review")).toMatchObject({ approve: true, recount: true, cancel: true });
    expect(countActions("approved")).toMatchObject({ gaps: true, cancel: false, approve: false });
    expect(countActions("cancelled")).toEqual({
      open: false,
      close: false,
      recount: false,
      approve: false,
      cancel: false,
      gaps: false,
    });
  });

  it("describes progress in words and as a whole percent", () => {
    expect(countProgressText({ countedLineCount: 0, lineCount: 0 })).toBe("No lines yet");
    expect(countProgressText({ countedLineCount: 3, lineCount: 10 })).toBe("3 of 10 lines counted");
    expect(countProgressPercent({ countedLineCount: 1, lineCount: 3 })).toBe(33);
    expect(countProgressPercent({ countedLineCount: 0, lineCount: 0 })).toBe(0);
    expect(countProgressPercent({ countedLineCount: 9, lineCount: 4 })).toBe(100);
  });

  it("names line status and variance without colour", () => {
    expect(countLineStatusText({ countedQty: null, recountRequested: false })).toBe("Not counted");
    expect(countLineStatusText({ countedQty: "2", recountRequested: false })).toBe("Counted");
    expect(countLineStatusText({ countedQty: "2", recountRequested: true })).toBe(
      "Recount requested",
    );
    expect(countVarianceText("-2")).toBe("Short by 2");
    expect(countVarianceText("1.5")).toBe("Over by 1.5");
    expect(countVarianceText("0")).toBe("No change");
    expect(countVarianceText(null)).toBe("Hidden");
    expect(countVarianceText("x")).toBe("Variance not known");
    expect(expectedText(null)).toBe("Hidden");
    expect(expectedText("4")).toBe("4");
  });

  it("values a line: hidden, unvalued, short and over", () => {
    expect(lineValueText({ expectedQty: null, valueMinor: 100, varianceQty: "1" }, "USD")).toBe(
      "Hidden",
    );
    expect(lineValueText({ expectedQty: "3", valueMinor: null, varianceQty: "-1" }, "USD")).toBe(
      "No cost on file, not valued",
    );
    expect(lineValueText({ expectedQty: "3", valueMinor: 250, varianceQty: "-1" }, "USD")).toBe(
      "Short $2.50",
    );
    expect(lineValueText({ expectedQty: "3", valueMinor: 250, varianceQty: "2" }, "USD")).toBe(
      "Over $2.50",
    );
    expect(lineValueText({ expectedQty: "3", valueMinor: 0, varianceQty: "0" }, "USD")).toBe(
      "$0.00",
    );
    expect(lineValueText({ expectedQty: "3", valueMinor: 0, varianceQty: null }, "USD")).toBe(
      "$0.00",
    );
  });

  it("states the totals, showing null totals as hidden and counting unvalued lines", () => {
    expect(
      varianceTotalsText({ shortValueMinor: 250, overValueMinor: null, unvaluedLines: 2 }, "USD"),
    ).toEqual({
      short: "Short value $2.50",
      over: "Over value Hidden",
      unvalued: "2 lines have no cost and are not valued",
    });
    expect(
      varianceTotalsText({ shortValueMinor: 0, overValueMinor: 0, unvaluedLines: 0 }, "USD")
        .unvalued,
    ).toBe("Every line is valued");
  });

  it("keys lines by variant and batch, and pages lines by cursor", () => {
    expect(lineKey({ variantId: V1, batchId: null })).toBe(`${V1}|`);
    expect(lineKey({ variantId: V1, batchId: B1 })).toBe(`${V1}|${B1}`);
    expect(countLinesQuery(null)).toBe("limit=200");
    expect(countLinesQuery(`${V1}|${B1}`)).toContain("after=");
  });
});

describe("buildCount", () => {
  it("builds a full count with an upper-cased currency and no scope", () => {
    const r = buildCount({ ...base, note: "  Monday  " });
    expect(r).toEqual({
      ok: true,
      body: {
        locationId: LOC,
        kind: "full",
        blind: false,
        mode: "frozen",
        currency: "USD",
        note: "Monday",
      },
    });
  });

  it("needs products for a cycle count and refuses products on a full count", () => {
    const cycleEmpty = buildCount({ ...base, kind: "cycle" });
    expect(cycleEmpty.ok).toBe(false);
    if (!cycleEmpty.ok) expect(cycleEmpty.errors.get("scope")).toMatch(/Add at least one product/);

    const fullWithProducts = buildCount({ ...base, variantIds: [V1] });
    expect(fullWithProducts.ok).toBe(false);
    if (!fullWithProducts.ok)
      expect(fullWithProducts.errors.get("scope")).toMatch(/takes no products/);

    const cycle = buildCount({
      ...base,
      kind: "cycle",
      variantIds: [V1],
      blind: true,
      mode: "live",
    });
    expect(cycle).toEqual({
      ok: true,
      body: {
        locationId: LOC,
        kind: "cycle",
        scope: { variantIds: [V1] },
        blind: true,
        mode: "live",
        currency: "USD",
      },
    });
  });

  it("refuses a missing location and a bad currency", () => {
    const r = buildCount({ ...base, locationId: "", currency: "dollars" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.get("locationId")).toMatch(/Pick the location/);
      expect(r.errors.get("currency")).toMatch(/currency code/);
    }
  });

  it("caps a cycle count at 1000 products", () => {
    const ids = Array.from(
      { length: 1001 },
      (_, i) => `${V1.slice(0, -4)}${String(i).padStart(4, "0")}`,
    );
    expect(buildCount({ ...base, kind: "cycle", variantIds: ids }).ok).toBe(false);
  });
});

describe("buildRecount and buildGapThresholds", () => {
  it("needs one to 200 lines to request a recount", () => {
    expect(buildRecount(3, []).ok).toBe(false);
    expect(buildRecount(3, [{ variantId: V1, batchId: null }])).toEqual({
      ok: true,
      body: { version: 3, lines: [{ variantId: V1, batchId: null }] },
    });
    const many = Array.from({ length: 201 }, () => ({ variantId: V1, batchId: null }));
    expect(buildRecount(3, many).ok).toBe(false);
  });

  const toMinor = (text: string) => parsePrice(text, "USD");

  it("takes a quantity, a value, or both as gap thresholds", () => {
    expect(buildGapThresholds("2", "", toMinor)).toEqual({ ok: true, body: { minQty: "2" } });
    expect(buildGapThresholds("", "10.50", toMinor)).toEqual({
      ok: true,
      body: { minValueMinor: 1050 },
    });
    expect(buildGapThresholds("0.5", "1", toMinor)).toEqual({
      ok: true,
      body: { minQty: "0.5", minValueMinor: 100 },
    });
  });

  it("refuses empty thresholds and bad input in place", () => {
    expect(buildGapThresholds("", "", toMinor).ok).toBe(false);
    const bad = buildGapThresholds("-1", "abc", toMinor);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.has("minQty")).toBe(true);
      expect(bad.errors.has("minValueMinor")).toBe(true);
    }
  });
});
