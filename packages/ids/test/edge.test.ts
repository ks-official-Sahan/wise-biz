// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";

import { createHlc, isUuidv7, parseHlc, serializeHlc, timestampOf, uuidv7 } from "../src/index.ts";

describe("edge runtime smoke", () => {
  it("generates ids and HLC timestamps without Node built-ins", () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(isUuidv7(a)).toBe(true);
    expect(b > a).toBe(true);
    expect(timestampOf(a)).toBeGreaterThan(0);
    const hlc = createHlc({ node: "edge" });
    const t = hlc.now();
    expect(parseHlc(serializeHlc(t))).toEqual(t);
  });
});
