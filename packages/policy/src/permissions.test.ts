import { describe, expect, it } from "vitest";

import {
  createCatalog,
  definePermissions,
  isPermission,
  isPlatformPermission,
} from "./permissions.ts";
import { isSystemRole, isTenantRole, SYSTEM_ROLES } from "./roles.ts";

describe("permissions", () => {
  it("defines frozen module:action lists", () => {
    const list = definePermissions("sales", ["create", "discount"]);
    expect(list).toEqual(["sales:create", "sales:discount"]);
    expect(Object.isFrozen(list)).toBe(true);
  });
  it("validates format", () => {
    expect(isPermission("sales:refund:large")).toBe(true);
    for (const bad of ["sales", "Sales:x", "a:b:c:d", "a:1x", "", 5])
      expect(isPermission(bad)).toBe(false);
    expect(() => definePermissions("Bad", ["x"])).toThrow(/Invalid/);
  });
  it("catalog rejects duplicates and bad entries, answers has()", () => {
    const c = createCatalog(["a:b"], ["a:c"]);
    expect(c.has("a:b")).toBe(true);
    expect(c.has("a:z")).toBe(false);
    expect(c.has(3)).toBe(false);
    expect(() => createCatalog(["a:b"], ["a:b"])).toThrow(/Duplicate/);
    expect(() => createCatalog(["nope"])).toThrow(/Invalid/);
  });
  it("detects platform permissions", () => {
    expect(isPlatformPermission("platform:x")).toBe(true);
    expect(isPlatformPermission("platformer:x")).toBe(false);
  });
});

describe("roles", () => {
  it("system and tenant roles", () => {
    expect(SYSTEM_ROLES).toHaveLength(6);
    expect(isSystemRole("owner")).toBe(true);
    expect(isSystemRole("barista")).toBe(false);
    expect(isTenantRole("barista")).toBe(true);
    expect(isTenantRole("platform_admin")).toBe(false);
    expect(isTenantRole("Bad Role")).toBe(false);
    expect(isTenantRole(1)).toBe(false);
  });
});
