import { describe, expect, it } from "vitest";

import { enrollmentPayload, qrMatrix, qrPath, QUIET_ZONE } from "./qr.ts";

describe("qrMatrix", () => {
  it("gives the same matrix for the same text", () => {
    expect(qrMatrix("WB7K2Q9M")).toEqual(qrMatrix("WB7K2Q9M"));
  });

  it("gives a different matrix for different text", () => {
    expect(qrMatrix("WB7K2Q9M")).not.toEqual(qrMatrix("WB7K2Q9N"));
  });

  it("uses version 1 for a short string and draws the fixed finder and timing patterns", () => {
    const m = qrMatrix("WB1234");
    expect(m).toHaveLength(21);
    // Top-left finder: solid outer ring, light second ring, dark 3x3 centre.
    expect(m[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(m[1]?.[1]).toBe(false);
    expect(m[3]?.[3]).toBe(true);
    // Top-right finder and the fixed dark module next to the bottom-left finder.
    expect(m[0]?.[20]).toBe(true);
    expect(m[13]?.[8]).toBe(true);
    // Timing pattern alternates along row 6 between the finders.
    expect([8, 9, 10, 11].map((c) => m[6]?.[c])).toEqual([true, false, true, false]);
  });
});

describe("enrollmentPayload", () => {
  it("is the bare code, trimmed, never a prefixed form", () => {
    expect(enrollmentPayload("  WB7K-2Q9M \n")).toBe("WB7K-2Q9M");
  });
});

describe("qrPath", () => {
  it("adds the quiet zone to the viewBox and draws one square per dark module", () => {
    const m = qrMatrix("WB1234");
    const { viewBox, d } = qrPath(m);
    const dark = m.flat().filter(Boolean).length;
    expect(viewBox).toBe(21 + QUIET_ZONE * 2);
    expect(d.split("M")).toHaveLength(dark + 1);
  });

  it("offsets the first dark module by the quiet zone", () => {
    expect(qrPath([[true]], 2)).toEqual({ viewBox: 5, d: "M2 2h1v1h-1z" });
  });
});
