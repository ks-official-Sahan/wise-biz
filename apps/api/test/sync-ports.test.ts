import { describe, expect, it, vi } from "vitest";

import { salesPorts } from "../src/sales-ports.ts";
import { createSyncPorts } from "../src/sync-ports.ts";

import type { ObjectStore } from "@wise-biz/storage";

// The handlers only delegate to the sales module with the sales ports: stub the module and check the wiring.
const sales = vi.hoisted(() => ({
  cashMovement: vi.fn(() => "cashMovement"),
  closeShift: vi.fn(() => "closeShift"),
  completeReturn: vi.fn(() => "completeReturn"),
  completeSale: vi.fn(() => "completeSale"),
  openDrawer: vi.fn(() => "openDrawer"),
  openShift: vi.fn(() => "openShift"),
  recordOverride: vi.fn(() => "recordOverride"),
  voidSale: vi.fn(() => "voidSale"),
}));
vi.mock("@wise-biz/module-sales", () => sales);

const store = {} as ObjectStore;

describe("createSyncPorts", () => {
  it("hands each signed command type to the sales function of the same name", () => {
    const ports = createSyncPorts(store);
    const tx = {} as never;
    const cmd = {} as never;
    for (const [type, fn] of [
      ["complete_sale", "completeSale"],
      ["complete_return", "completeReturn"],
      ["void_sale", "voidSale"],
      ["open_shift", "openShift"],
      ["close_shift", "closeShift"],
      ["open_drawer", "openDrawer"],
      ["cash_movement", "cashMovement"],
      ["record_override", "recordOverride"],
    ] as const) {
      const handler = ports.handlers[type] as unknown as (
        a: unknown,
        b: string,
        c: unknown,
      ) => unknown;
      expect(handler(tx, "tenant", cmd)).toBe(fn);
      expect(sales[fn]).toHaveBeenCalledWith(tx, salesPorts, "tenant", cmd);
    }
  });

  it("passes the store and the metric hook through, and omits an absent hook", () => {
    const onMetric = vi.fn();
    expect(createSyncPorts(store, onMetric).onMetric).toBe(onMetric);
    expect(createSyncPorts(store).store).toBe(store);
    expect("onMetric" in createSyncPorts(store)).toBe(false);
  });

  it("lists a branch's locations with one tenant-scoped query", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [{ id: "l1" }, { id: "l2" }] }));
    const ports = createSyncPorts(store);
    const ids = await ports.branchLocations({ query } as never, "tenant", "branch");
    expect(ids).toEqual(["l1", "l2"]);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/tenant_id = \$1 and branch_id = \$2/),
      ["tenant", "branch"],
    );
  });
});
