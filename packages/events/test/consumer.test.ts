import { describe, expect, it } from "vitest";

import { defineConsumer } from "../src/index.ts";
import { ConsumerRouter } from "../src/router.ts";

const handle = (): Promise<void> => Promise.resolve();

describe("defineConsumer", () => {
  it("freezes and defaults maxAttempts to 3", () => {
    const c = defineConsumer({ name: "a.b-c_1", events: ["x.y.z@v1"], handle });
    expect(c.maxAttempts).toBe(3);
    expect(Object.isFrozen(c)).toBe(true);
  });
  it.each(["", "A", "1a", "a b", "a/b"])("rejects name %j", (name) => {
    expect(() => defineConsumer({ name, events: ["x.y.z@v1"], handle })).toThrow(/name/);
  });
  it.each(["x.y.z", "x.y.z@1", "x.y@v1", "x.y.z@v0", "X.y.z@v1", "x.y.z@*1"])(
    "rejects pattern %j",
    (p) => {
      expect(() => defineConsumer({ name: "c", events: [p], handle })).toThrow(/pattern/);
    },
  );
  it("rejects empty events and bad maxAttempts", () => {
    expect(() => defineConsumer({ name: "c", events: [], handle })).toThrow();
    expect(() =>
      defineConsumer({ name: "c", events: ["x.y.z@*"], handle, maxAttempts: 0 }),
    ).toThrow();
  });
});

describe("ConsumerRouter", () => {
  it("matches exact, wildcard, dedupes and rejects duplicate names", () => {
    const r = new ConsumerRouter();
    const a = defineConsumer({ name: "a", events: ["x.y.z@v1", "x.y.z@*"], handle });
    const b = defineConsumer({ name: "b", events: ["x.y.z@v2"], handle });
    r.add(a);
    r.add(b);
    expect(r.match("x.y.z", 1)).toEqual([a]);
    expect(new Set(r.match("x.y.z", 2))).toEqual(new Set([a, b]));
    expect(r.match("x.y.w", 1)).toEqual([]);
    expect(() => {
      r.add(a);
    }).toThrow(/duplicate/);
  });
});
