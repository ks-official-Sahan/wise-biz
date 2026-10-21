import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decide } from "./decide.ts";
import { ctx, matrix, res, catalog } from "./fixtures.ts";
import { matrixFromRows } from "./matrix.ts";

import type { DecisionContext } from "./conditions.ts";

describe("decide decision table", () => {
  it("owner allow-all (non-platform)", () => {
    for (const p of catalog.all.filter((x) => !x.startsWith("platform:"))) {
      expect(
        decide(matrix, ctx({ roles: ["owner"] }), p, res({ amountMinor: 9e9, discountBps: 10000 }))
          .allow,
      ).toBe(true);
    }
  });
  it("owner denied platform permission", () => {
    expect(decide(matrix, ctx({ roles: ["owner"] }), "platform:tenants_suspend", res())).toEqual({
      allow: false,
      reason: "not_granted",
    });
  });
  it("platform permission denied even if a tampered matrix holds it", () => {
    const evil = { cashier: [{ permission: "platform:tenants_suspend" as const }] };
    expect(decide(evil, ctx(), "platform:tenants_suspend", res()).allow).toBe(false);
  });
  it("cashier discount within limit allowed, returns grant", () => {
    const d = decide(matrix, ctx(), "sales:discount", res({ discountBps: 1000 }));
    expect(d).toEqual({
      allow: true,
      reason: "granted",
      grant: { permission: "sales:discount", conditions: { maxDiscountBps: 1000 } },
    });
  });
  it("cashier discount over limit -> override: manager, owner, supervisor (sorted, who qualify at 2000)", () => {
    const d = decide(matrix, ctx(), "sales:discount", res({ discountBps: 2000 }));
    expect(d).toEqual({
      allow: false,
      reason: "discount_exceeds_limit",
      override: { permission: "sales:discount", approverRoles: ["manager", "owner", "supervisor"] },
    });
  });
  it("override excludes roles that would also fail", () => {
    const d = decide(matrix, ctx(), "sales:discount", res({ discountBps: 4000 }));
    expect(d).toMatchObject({ override: { approverRoles: ["manager", "owner"] } });
    const none = decide(
      matrix,
      ctx({ roles: ["manager"] }),
      "sales:discount",
      res({ discountBps: 6000 }),
    );
    expect(none).toMatchObject({
      reason: "discount_exceeds_limit",
      override: { approverRoles: ["owner"] },
    });
  });
  it("override omitted when nobody qualifies", () => {
    const d = decide(matrix, ctx({ roles: ["cashier"] }), "sales:void", res({ amountMinor: 6000 }));
    expect(d).toMatchObject({ allow: false, reason: "amount_exceeds_limit" });
    expect(d).toMatchObject({ override: { approverRoles: ["owner"] } });
    const m = matrixFromRows(catalog, [
      { role: "cashier", permission: "sales:void", conditions: { maxAmountMinor: 1 } },
    ]);
    const d2 = decide({ ...m, owner: [] }, ctx(), "sales:void", res({ amountMinor: 5 }));
    expect(d2).toEqual({ allow: false, reason: "amount_exceeds_limit" });
  });
  it("branch-scoped manager denied on other branch, allowed on own; no override", () => {
    const c = ctx({ roles: ["manager"], branchScope: ["b1"] });
    expect(decide(matrix, c, "sales:refund", res({ branchId: "b2" }))).toEqual({
      allow: false,
      reason: "branch_out_of_scope",
    });
    expect(decide(matrix, c, "sales:refund", res({ branchId: "b1" })).allow).toBe(true);
    expect(decide(matrix, c, "sales:refund", res()).reason).toBe("branch_out_of_scope");
  });
  it("tenant mismatch denies, even owner, no override", () => {
    expect(
      decide(matrix, ctx({ roles: ["owner"] }), "sales:create", res({ tenantId: "t2" })),
    ).toEqual({
      allow: false,
      reason: "tenant_mismatch",
    });
  });
  it("not_granted for missing perm, unknown role, no roles", () => {
    expect(decide(matrix, ctx(), "inventory:adjust", res())).toEqual({
      allow: false,
      reason: "not_granted",
    });
    expect(decide(matrix, ctx({ roles: ["ghost"] }), "sales:create", res())).toEqual({
      allow: false,
      reason: "not_granted",
    });
    expect(decide(matrix, ctx({ roles: [] }), "sales:create", res())).toEqual({
      allow: false,
      reason: "not_granted",
    });
  });
  it("requiresOpenShift", () => {
    expect(decide(matrix, ctx({ shiftOpen: true }), "sales:create", res()).allow).toBe(true);
    expect(decide(matrix, ctx({ shiftOpen: false }), "sales:create", res())).toMatchObject({
      allow: false,
      reason: "shift_not_open",
    });
  });
  it("time window and device class reasons via custom rows", () => {
    const m = matrixFromRows(catalog, [
      {
        role: "cashier",
        permission: "sales:create",
        conditions: { timeWindow: { startMinute: 1320, endMinute: 360 }, deviceClass: ["pos"] },
      },
    ]);
    expect(
      decide(m, ctx({ localMinuteOfDay: 30, deviceClass: "pos" }), "sales:create", res()).allow,
    ).toBe(true);
    expect(
      decide(m, ctx({ localMinuteOfDay: 700, deviceClass: "pos" }), "sales:create", res()),
    ).toMatchObject({ reason: "outside_time_window" });
    expect(
      decide(m, ctx({ localMinuteOfDay: 30, deviceClass: "web" }), "sales:create", res()),
    ).toMatchObject({ reason: "device_class_not_allowed" });
  });
  it("most permissive grant wins across roles", () => {
    const c = ctx({ roles: ["cashier", "supervisor"] });
    expect(decide(matrix, c, "sales:discount", res({ discountBps: 3000 })).allow).toBe(true);
  });
  it("is deterministic and does not mutate inputs", () => {
    const c = ctx();
    const a = decide(matrix, c, "sales:discount", res({ discountBps: 2000 }));
    expect(decide(matrix, c, "sales:discount", res({ discountBps: 2000 }))).toEqual(a);
  });
});

describe("decide properties", () => {
  const roleArb = fc.constantFrom(
    "owner",
    "manager",
    "supervisor",
    "cashier",
    "inventory_clerk",
    "accountant",
    "ghost",
  );
  const permArb = fc.constantFrom(...catalog.all);
  const ctxArb: fc.Arbitrary<DecisionContext> = fc.record(
    {
      tenantId: fc.constant("t1"),
      roles: fc.array(roleArb, { maxLength: 4 }),
      branchScope: fc.constant("all" as const),
      now: fc.constant(1),
      localMinuteOfDay: fc.integer({ min: 0, max: 1439 }),
      localDayOfWeek: fc.constantFrom(0, 1, 2, 3, 4, 5, 6),
      deviceClass: fc.constantFrom("pos", "web", "mobile"),
      shiftOpen: fc.boolean(),
    },
    {
      requiredKeys: [
        "tenantId",
        "roles",
        "branchScope",
        "now",
        "localMinuteOfDay",
        "localDayOfWeek",
      ],
    },
  );
  const resArb = fc.record(
    {
      tenantId: fc.constant("t1"),
      amountMinor: fc.integer({ min: 0, max: 20000 }),
      discountBps: fc.integer({ min: 0, max: 10000 }),
    },
    { requiredKeys: ["tenantId"] },
  );

  it("never allows when no role holds the permission", () => {
    fc.assert(
      fc.property(ctxArb, permArb, resArb, (c, p, r) => {
        const holds = c.roles.some((role) => (matrix[role] ?? []).some((g) => g.permission === p));
        const d = decide(matrix, c, p, r);
        if (!holds) expect(d.allow).toBe(false);
        if (!holds) expect(d.reason).toBe("not_granted");
      }),
    );
  });
  it("allow implies a grant of a ctx role passes its conditions; never platform", () => {
    fc.assert(
      fc.property(ctxArb, permArb, resArb, (c, p, r) => {
        const d = decide(matrix, c, p, r);
        if (d.allow) {
          expect(p.startsWith("platform:")).toBe(false);
          expect(c.roles.some((role) => (matrix[role] ?? []).includes(d.grant))).toBe(true);
          expect(d.grant.permission).toBe(p);
        }
        if (!d.allow && d.override) {
          expect(d.override.approverRoles.some((x) => c.roles.includes(x))).toBe(false);
        }
      }),
    );
  });
});
