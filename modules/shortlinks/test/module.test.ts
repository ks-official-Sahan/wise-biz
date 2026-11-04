import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import { shortlinksModule } from "../src/index.ts";

describe("shortlinksModule", () => {
  it("declares name, no user permissions, no emitted events, absolute migrations dir", () => {
    expect(shortlinksModule.name).toBe("shortlinks");
    expect(shortlinksModule.permissions).toEqual([]);
    expect(shortlinksModule.events).toEqual([]);
    expect(isAbsolute(shortlinksModule.migrationsDir)).toBe(true);
    expect(shortlinksModule.devOnly).toBeUndefined();
  });
});
