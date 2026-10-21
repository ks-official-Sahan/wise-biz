import { matrixFromRows } from "./matrix.ts";
import { createCatalog, definePermissions } from "./permissions.ts";

import type { DecisionContext, Resource } from "./conditions.ts";

export const catalog = createCatalog(
  definePermissions("sales", ["create", "discount", "refund", "void"]),
  definePermissions("inventory", ["adjust", "view"]),
  definePermissions("platform", ["tenants_suspend"]),
);

export const matrix = matrixFromRows(catalog, [
  { role: "manager", permission: "sales:discount", conditions: { maxDiscountBps: 5000 } },
  { role: "manager", permission: "sales:refund" },
  { role: "manager", permission: "inventory:adjust" },
  { role: "supervisor", permission: "sales:discount", conditions: { maxDiscountBps: 3000 } },
  { role: "cashier", permission: "sales:create", conditions: { requiresOpenShift: true } },
  { role: "cashier", permission: "sales:discount", conditions: { maxDiscountBps: 1000 } },
  { role: "cashier", permission: "sales:void", conditions: { maxAmountMinor: 5000 } },
  { role: "inventory_clerk", permission: "inventory:view" },
  { role: "owner", permission: "platform:tenants_suspend" },
  { role: "cashier", permission: "platform:tenants_suspend" },
]);

export const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({
  tenantId: "t1",
  roles: ["cashier"],
  branchScope: "all",
  now: 1_700_000_000_000,
  localMinuteOfDay: 600,
  localDayOfWeek: 2,
  ...over,
});

export const res = (over: Partial<Resource> = {}): Resource => ({ tenantId: "t1", ...over });
