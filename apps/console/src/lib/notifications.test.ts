import { describe, expect, it } from "vitest";

import { ago, badgeText, safeLink, unreadLabel } from "./notifications.ts";

describe("bell", () => {
  it("caps the badge and names the unread count for a screen reader", () => {
    expect(badgeText(3)).toBe("3");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
    expect(unreadLabel(0)).toBe("Notifications");
    expect(unreadLabel(4)).toBe("Notifications, 4 unread");
  });
});

describe("links", () => {
  it("follows in-app paths only", () => {
    expect(safeLink("/stock")).toBe("/stock");
    expect(safeLink("/reports?from=2026-11-01")).toBe("/reports?from=2026-11-01");
    expect(safeLink(null)).toBeNull();
    expect(safeLink("https://evil.example")).toBeNull();
    expect(safeLink("//evil.example")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
  });
});

describe("ago", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  it("says how long ago in plain words", () => {
    expect(ago("2026-11-03T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-03T11:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-11-03T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-11-03T12:05:00Z", now)).toBe("just now");
    expect(ago("2026-10-01T12:00:00Z", now)).toMatch(/\d/);
  });
});
