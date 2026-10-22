import { describe, expect, it } from "vitest";

import { TENANCY_PERMISSIONS, createTenancyModule } from "../src/index.ts";

import { fakeSessions } from "./helpers.ts";

describe("tenancy module", () => {
  it("registers its permissions, event and migrations", () => {
    const m = createTenancyModule(fakeSessions());
    expect(m.name).toBe("tenancy");
    expect(m.permissions).toEqual(["tenancy:read", "tenancy:manage"]);
    expect(TENANCY_PERMISSIONS).toEqual(m.permissions);
    expect(m.events).toHaveLength(1);
    expect(m.migrationsDir).toMatch(/tenancy.migrations$/);
    expect(m.devOnly).toBeUndefined();
  });
});
