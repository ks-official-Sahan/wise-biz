import { uuidv7 } from "@wise-biz/ids";
import { SYSTEM_ROLES } from "@wise-biz/policy";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { DEFAULT_ROLE_GRANTS, isIanaTimezone, newBusiness } from "../src/domain/business.ts";

import type { NewBusinessInput } from "../src/domain/business.ts";

const deps = () => ({ ownerUserId: uuidv7(), nextId: uuidv7, now: new Date(0) });
const input = (
  over: Partial<NewBusinessInput["branch"]> = {},
  name = "Acme",
): NewBusinessInput => ({
  tenantId: uuidv7(),
  name,
  branch: {
    name: "Main",
    kind: "store",
    timezone: "UTC",
    currency: "USD",
    taxRegion: "US-CA",
    ...over,
  },
});

describe("newBusiness (pure)", () => {
  it("builds tenant, 6 system roles, owner membership, default location Main", () => {
    const d = deps();
    const r = newBusiness(input(), d);
    expect(r.roles.map((x) => x.name)).toEqual([...SYSTEM_ROLES]);
    expect(r.location).toMatchObject({ name: "Main", branchId: r.branch.id });
    expect(r.membership.userId).toBe(d.ownerUserId);
    expect(r.roles.find((x) => x.name === "owner")?.id).toBe(r.ownerRoleId);
    expect(r.branch.businessDayCutoff).toBe("00:00");
  });

  it("owner has no stored grants (implicit); defaults match DEFAULT_ROLE_GRANTS", () => {
    const r = newBusiness(input(), deps());
    const byRole = new Map(r.roles.map((x) => [x.id, x.name]));
    expect(r.rolePermissions.some((g) => byRole.get(g.roleId) === "owner")).toBe(false);
    const expected = Object.values(DEFAULT_ROLE_GRANTS).reduce((n, g) => n + g.length, 0);
    expect(r.rolePermissions).toHaveLength(expected);
  });

  it("trims names and keeps a valid cutoff", () => {
    const r = newBusiness(
      input({ name: "  Shop ", businessDayCutoff: "04:30" }, "  Acme  "),
      deps(),
    );
    expect(r.tenant.name).toBe("Acme");
    expect(r.branch).toMatchObject({ name: "Shop", businessDayCutoff: "04:30" });
  });

  it.each([
    ["kind", { kind: "mall" }],
    ["timezone", { timezone: "Mars/Olympus" }],
    ["timezone", { timezone: "" }],
    ["currency", { currency: "usd" }],
    ["currency", { currency: "ZZZ" }],
    ["cutoff", { businessDayCutoff: "24:00" }],
    ["cutoff", { businessDayCutoff: "4:30" }],
    ["branch name", { name: "   " }],
    ["tax region", { taxRegion: "x".repeat(33) }],
  ])("rejects an invalid %s", (_what, over) => {
    expect(() => newBusiness(input(over), deps())).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects a blank or oversized tenant name", () => {
    for (const name of ["   ", "x".repeat(201)]) {
      expect(() => newBusiness(input({}, name), deps())).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });

  it("isIanaTimezone", () => {
    expect(isIanaTimezone("Asia/Colombo")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
    expect(isIanaTimezone("Not/AZone")).toBe(false);
    expect(isIanaTimezone("x".repeat(65))).toBe(false);
  });

  it("property: every id is unique and every reference points inside the business", () => {
    const valid = fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim() !== ""),
      branchName: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim() !== ""),
      kind: fc.constantFrom("store", "warehouse", "office"),
      timezone: fc.constantFrom("UTC", "Asia/Colombo", "Europe/Berlin", "America/New_York"),
      currency: fc.constantFrom("USD", "LKR", "EUR", "JPY"),
    });
    fc.assert(
      fc.property(valid, (v) => {
        const r = newBusiness(
          input(
            { name: v.branchName, kind: v.kind, timezone: v.timezone, currency: v.currency },
            v.name,
          ),
          deps(),
        );
        const all = [
          ...r.roles.map((x) => x.id),
          ...r.rolePermissions.map((x) => x.id),
          r.branch.id,
          r.location.id,
          r.membership.id,
        ];
        expect(new Set(all).size).toBe(all.length);
        const roleIds = new Set(r.roles.map((x) => x.id));
        for (const g of r.rolePermissions) expect(roleIds.has(g.roleId)).toBe(true);
        expect(roleIds.has(r.ownerRoleId)).toBe(true);
        expect(r.location.branchId).toBe(r.branch.id);
      }),
    );
  });
});
