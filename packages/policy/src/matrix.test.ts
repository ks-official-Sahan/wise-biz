import { describe, expect, it } from "vitest";

import { catalog, matrix } from "./fixtures.ts";
import { matrixFromRows, toAuthKitMatrix } from "./matrix.ts";

describe("matrixFromRows", () => {
  it("owner gets every non-platform permission, unconditionally", () => {
    const perms = matrix.owner?.map((g) => g.permission).sort();
    expect(perms).toEqual(catalog.all.filter((p) => !p.startsWith("platform:")).sort());
    expect(matrix.owner?.every((g) => g.conditions === undefined)).toBe(true);
  });
  it("never grants platform permissions, even to owner or via rows", () => {
    for (const grants of Object.values(matrix)) {
      expect(grants.some((g) => g.permission.startsWith("platform:"))).toBe(false);
    }
  });
  it("skips unknown permissions, bad roles, bad conditions; owner rows ignored", () => {
    const m = matrixFromRows(catalog, [
      { role: "cashier", permission: "nope:nope" },
      { role: "platform_admin", permission: "sales:create" },
      { role: "Bad Role", permission: "sales:create" },
      { role: "cashier", permission: "sales:void", conditions: { maxAmountMinor: -1 } },
      { role: "owner", permission: "sales:void", conditions: { maxAmountMinor: 1 } },
      { role: "barista", permission: "sales:create" },
    ]);
    expect(m.cashier).toEqual([]);
    expect(m.platform_admin).toBeUndefined();
    expect(m.barista).toEqual([{ permission: "sales:create" }]);
    expect(m.owner?.find((g) => g.permission === "sales:void")?.conditions).toBeUndefined();
    expect(Object.keys(m)).toEqual(expect.arrayContaining(["owner", "manager", "accountant"]));
  });
  it("toAuthKitMatrix yields Record<role, ReadonlySet<permission>>", () => {
    const a = toAuthKitMatrix(matrix);
    expect(a.cashier).toBeInstanceOf(Set);
    expect(a.cashier?.has("sales:discount")).toBe(true);
    expect(a.cashier?.has("inventory:adjust")).toBe(false);
    expect(a.owner?.size).toBe(6);
  });
});
