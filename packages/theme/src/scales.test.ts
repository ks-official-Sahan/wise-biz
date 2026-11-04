import { describe, expect, it } from "vitest";

import { scalesFor } from "./scales.ts";

describe("scales", () => {
  it("uses the fixed space, radius, font and motion scales", () => {
    const s = scalesFor("comfortable");
    expect(s.space).toEqual([0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
    expect(s.radius).toEqual({ control: 8, card: 12, pill: 999 });
    expect(s.fontSize["2xl"]).toBe(32);
    expect(s.motion.easeOut).toEqual([0.23, 1, 0.32, 1]);
  });

  it("picks density control heights and keeps touch keys at least target.min", () => {
    expect(scalesFor("compact").control).toEqual({ control: 44, key: 48 });
    expect(scalesFor("comfortable").control).toEqual({ control: 52, key: 56 });
    for (const density of ["compact", "comfortable"] as const) {
      const s = scalesFor(density);
      expect(s.control.key).toBeGreaterThanOrEqual(s.target.min);
    }
  });

  it("sets the cart total size from the density", () => {
    expect(scalesFor("compact").cartTotal).toBe(32);
    expect(scalesFor("comfortable").cartTotal).toBe(48);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(scalesFor("compact"))).toBe(true);
    expect(Object.isFrozen(scalesFor("compact").radius)).toBe(true);
  });
});
