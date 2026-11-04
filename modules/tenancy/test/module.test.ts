import { describe, expect, it } from "vitest";

import { TENANCY_EVENTS, TENANCY_PERMISSIONS, createTenancyModule } from "../src/index.ts";

import { fakeSessions } from "./helpers.ts";

describe("tenancy module", () => {
  it("registers its permissions, events and migrations", () => {
    const m = createTenancyModule(fakeSessions());
    expect(m.name).toBe("tenancy");
    expect(m.permissions).toEqual(["tenancy:read", "tenancy:manage"]);
    expect(TENANCY_PERMISSIONS).toEqual(m.permissions);
    expect(m.events).toHaveLength(TENANCY_EVENTS.length);
    expect(m.events.map((e) => (e as { key: string }).key)).toContain("tenancy.member.invited@v1");
    expect(m.migrationsDir).toMatch(/tenancy.migrations$/);
    expect(m.devOnly).toBeUndefined();
  });
});
