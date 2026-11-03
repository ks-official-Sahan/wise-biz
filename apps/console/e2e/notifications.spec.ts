import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** The bell and the notifications page against a mocked API (no database). */

const N1 = "0190a000-0000-7000-8000-0000000000a1";
const N2 = "0190a000-0000-7000-8000-0000000000a2";

interface Sent {
  reads: unknown[];
  prefs: unknown[];
}

async function mockApi(page: Page): Promise<Sent> {
  const sent: Sent = { reads: [], prefs: [] };
  let unread = 2;
  const read = new Set<string>();
  const prefs = [
    { kind: "low_stock", label: "Low stock", inApp: true, email: false },
    { kind: "expiring", label: "Stock about to expire", inApp: true, email: false },
  ];
  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/v1/auth/get-session")
      return json(200, {
        session: { id: "s1", activeTenantId: "t1" },
        user: { id: "u1", email: "owner@example.test", name: "Owner" },
      });
    if (path === "/v1/tenancy/me/tenants")
      return json(200, {
        tenants: [
          { tenantId: "t1", name: "Shop", membershipId: "m1", onboardedAt: "2026-10-01T00:00:00Z" },
        ],
      });
    if (path === "/v1/notifications/unread-count") return json(200, { unread });
    if (path === "/v1/notifications" && req.method() === "GET") {
      const item = (id: string, title: string, link: string | null) => ({
        id,
        kind: "low_stock",
        title,
        body: "On hand is 2.0000, below the minimum of 5.0000.",
        link,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        readAt: read.has(id) ? new Date().toISOString() : null,
      });
      return json(200, {
        notifications: [
          item(N2, "Stock is running low", "/stock"),
          item(N1, "Stock is about to expire", null),
        ],
        next: null,
      });
    }
    if (path === "/v1/notifications/read") {
      const body = req.postDataJSON() as { ids?: string[]; all?: true };
      sent.reads.push(body);
      for (const id of body.ids ?? [N1, N2]) read.add(id);
      unread = 2 - read.size;
      return json(200, { marked: 1 });
    }
    if (path === "/v1/notifications/preferences") {
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as {
          preferences: { kind: string; inApp: boolean; email: boolean }[];
        };
        sent.prefs.push(body);
        for (const p of body.preferences) {
          const mine = prefs.find((x) => x.kind === p.kind);
          if (mine) Object.assign(mine, p);
        }
      }
      return json(200, { preferences: prefs });
    }
    return json(404, { status: 404, title: "Not found" });
  });
  return sent;
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("the bell shows the unread count and opens the list", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const bell = page.getByRole("link", { name: "Notifications, 2 unread" });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
  await expect(page.getByText("Stock is running low")).toBeVisible();
  // A notification without a link has no Open link; one with a link has it.
  await expect(page.getByRole("link", { name: "Open" })).toHaveCount(1);
  await a11y(page);
});

test("marks one read, then all, and the badge follows", async ({ page }) => {
  const sent = await mockApi(page);
  await page.goto("/notifications");
  await page.getByRole("button", { name: "Mark read" }).first().click();
  await expect.poll(() => sent.reads.length).toBe(1);
  expect(sent.reads[0]).toEqual({ ids: [N2] });
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect.poll(() => sent.reads.length).toBe(2);
  expect(sent.reads[1]).toEqual({ all: true });
  await expect(page.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();
});

test("saves a preference when it is toggled", async ({ page }) => {
  const sent = await mockApi(page);
  await page.goto("/notifications");
  await page.getByRole("checkbox", { name: "Stock about to expire: by email" }).check();
  await expect.poll(() => sent.prefs.length).toBe(1);
  expect(sent.prefs[0]).toEqual({
    preferences: [{ kind: "expiring", inApp: true, email: true }],
  });
  await a11y(page);
});
