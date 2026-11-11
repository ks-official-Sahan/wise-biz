import { describe, expect, it } from "vitest";

import {
  assigneeText,
  buildResolve,
  buildTask,
  evidenceSourceText,
  gapActions,
  gapValueText,
  gapVarianceText,
  shortageQty,
  unavailableText,
} from "./gaps.ts";

const ID = "0190a000-0000-7000-8000-000000000009";
const LOC = "0190a000-0000-7000-8000-000000000001";

describe("gap cases", () => {
  it("lets a resolved case take no more work", () => {
    expect(gapActions("open")).toEqual({
      investigate: true,
      assign: true,
      addTask: true,
      resolve: true,
    });
    expect(gapActions("investigating")).toEqual({
      investigate: false,
      assign: true,
      addTask: true,
      resolve: true,
    });
    expect(gapActions("resolved")).toEqual({
      investigate: false,
      assign: false,
      addTask: false,
      resolve: false,
    });
  });

  it("states the variance and the shortage in words", () => {
    expect(gapVarianceText("-3")).toBe("Short by 3");
    expect(gapVarianceText("1")).toBe("Over by 1");
    expect(gapVarianceText("0")).toBe("No change");
    expect(gapVarianceText("bad")).toBe("Variance not known");
    expect(shortageQty("-2.5")).toBe("2.5");
    expect(shortageQty("4")).toBe("0");
  });

  it("never shows an unknown cost as zero", () => {
    expect(gapValueText(null, "USD")).toBe("No cost on file, not valued");
    expect(gapValueText(1250, "USD")).toBe("$12.50");
  });

  it("names sources and unwired evidence plainly", () => {
    expect(evidenceSourceText("ledger")).toBe("Stock ledger");
    expect(evidenceSourceText("void_events")).toBe("void events");
    expect(unavailableText([])).toBeNull();
    expect(unavailableText(["sales_voids"])).toMatch(/Not checked yet: sales voids/);
    expect(assigneeText(null)).toBe("Unassigned");
    expect(assigneeText(ID)).toBe("Member 0190a000…");
  });
});

describe("resolution", () => {
  const none = { foundLocationId: "", foundQty: "" };

  it("takes a code and an optional, trimmed note", () => {
    expect(buildResolve(2, { code: "theft", note: " walked out ", ...none }, "3")).toEqual({
      ok: true,
      body: { version: 2, code: "theft", note: "walked out" },
    });
    expect(buildResolve(2, { code: "", note: "", ...none }, "3").ok).toBe(false);
  });

  it("needs a location and a quantity no larger than the shortage for misplaced stock", () => {
    const missing = buildResolve(2, { code: "misplaced_found", note: "", ...none }, "3");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.get("foundLocationId")).toMatch(/Pick where/);
      expect(missing.errors.get("foundQty")).toMatch(/above zero/);
    }
    const over = buildResolve(
      2,
      { code: "misplaced_found", note: "", foundLocationId: LOC, foundQty: "4" },
      "3",
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.get("foundQty")).toBe("At most the shortage, 3.");
    expect(
      buildResolve(
        2,
        { code: "misplaced_found", note: "", foundLocationId: LOC, foundQty: "2" },
        "3",
      ),
    ).toEqual({
      ok: true,
      body: { version: 2, code: "misplaced_found", foundLocationId: LOC, foundQty: "2" },
    });
  });

  it("refuses an over-long note", () => {
    const r = buildResolve(1, { code: "damage", note: "x".repeat(501), ...none }, "1");
    expect(r.ok).toBe(false);
  });
});

describe("tasks", () => {
  it("needs a title and carries an optional assignee", () => {
    expect(buildTask(1, "  ", null).ok).toBe(false);
    expect(buildTask(1, "x".repeat(201), null).ok).toBe(false);
    expect(buildTask(4, " Check CCTV ", ID)).toEqual({
      ok: true,
      body: { version: 4, title: "Check CCTV", assigneeId: ID },
    });
    expect(buildTask(4, "Recount shelf", null)).toEqual({
      ok: true,
      body: { version: 4, title: "Recount shelf" },
    });
  });
});
