import { expect, it } from "vitest";

import { fakeClock } from "./clock.ts";

it("advances and sets", () => {
  const c = fakeClock(1000);
  expect(c.now()).toBe(1000);
  c.advance(50);
  expect(c.now()).toBe(1050);
  c.set(7);
  expect(c.now()).toBe(7);
  expect(fakeClock().now()).toBe(0);
});
