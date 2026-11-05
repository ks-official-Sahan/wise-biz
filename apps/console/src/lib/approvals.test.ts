import { describe, expect, it } from "vitest";

import { countLabel, pendingDevices } from "./approvals.ts";

import type { Device } from "./devices.ts";

const device = (status: Device["status"], id: string): Device => ({
  deviceId: id,
  tenantId: "t",
  branchId: "b",
  name: id,
  platform: "windows",
  appVersion: "1",
  status,
  enrolledAt: "2026-11-05T00:00:00Z",
  lastSeenAt: null,
});

describe("approvals", () => {
  it("lists only the terminals that wait to be let in", () => {
    const all = [
      device("pending", "a"),
      device("active", "b"),
      device("revoked", "c"),
      device("pending", "d"),
    ];
    expect(pendingDevices(all).map((d) => d.deviceId)).toEqual(["a", "d"]);
    expect(pendingDevices([])).toEqual([]);
  });

  it("shows nothing when nothing waits, the sum otherwise, and a plus when the list is cut", () => {
    expect(countLabel(0, 0, false)).toBe("");
    expect(countLabel(2, 3, false)).toBe("5");
    expect(countLabel(0, 49, false)).toBe("49");
    expect(countLabel(1, 50, false)).toBe("51+");
    expect(countLabel(0, 12, true)).toBe("12+");
  });
});
