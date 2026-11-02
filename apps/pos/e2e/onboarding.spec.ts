import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

const API = "http://localhost:3000";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-expose-headers": "etag,retry-after",
};

interface Mock {
  enrollStatus: number;
  pinStatus: number;
}

/** A tiny API double: empty datasets (so first sync completes at once), an accepting heartbeat, scriptable enroll and PIN. */
async function mockApi(page: Page, mock: Mock): Promise<void> {
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        headers: {
          ...CORS,
          "content-type": status >= 400 ? "application/problem+json" : "application/json",
        },
        body: JSON.stringify(body),
      });
    switch (path) {
      case "/v1/devices/enroll":
        return mock.enrollStatus === 200
          ? json(200, {
              deviceId: "d",
              tenantId: "t",
              branchId: "b",
              name: "Front counter",
              status: "active",
            })
          : json(mock.enrollStatus, {
              code: "INVALID_CODE",
              title: "Invalid code",
              status: mock.enrollStatus,
            });
      case "/v1/devices/heartbeat":
        return json(200, { status: "active", serverTime: new Date().toISOString() });
      case "/v1/devices/pin-login":
        return mock.pinStatus === 200
          ? json(200, {
              sessionId: "s",
              userId: "u1",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            })
          : json(mock.pinStatus, {
              code: "INVALID_CREDENTIALS",
              title: "Invalid",
              status: mock.pinStatus,
            });
      case "/v1/devices/pin-logout":
        return json(200, {});
      case "/v1/sync/bootstrap":
        return json(200, { cursor: null, url: null });
      case "/v1/sync/changes":
        return json(200, { changes: [], nextCursor: null, hasMore: false });
      case "/v1/sync/commands":
        return json(200, { acks: [] });
      default:
        return json(404, { code: "NOT_FOUND", title: "Not found", status: 404 });
    }
  });
}

test("a fresh terminal lands on enrollment", async ({ page }) => {
  await mockApi(page, { enrollStatus: 200, pinStatus: 200 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up this terminal" })).toBeVisible();
  await expect(page.getByTestId("enroll-submit")).toBeDisabled();
});

test("a bad setup code shows a plain message and keeps the code", async ({ page }) => {
  await mockApi(page, { enrollStatus: 422, pinStatus: 200 });
  await page.goto("/");
  await page.getByLabel("Setup code").fill("WRONG-CODE");
  await page.getByTestId("enroll-submit").click();
  await expect(
    page.getByText("That code did not work. Ask the owner for a new one."),
  ).toBeVisible();
  await expect(page.getByLabel("Setup code")).toHaveValue("WRONG-CODE");
});

test("enroll, first sync, PIN unlock, lock", async ({ page }) => {
  await mockApi(page, { enrollStatus: 200, pinStatus: 200 });
  await page.goto("/");
  await page.getByLabel("Setup code").fill("ABCD-1234");
  await page.getByTestId("enroll-submit").click();

  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("User ID").fill("u1");
  for (const digit of ["1", "2", "3", "4"])
    await page.getByRole("button", { name: `Digit ${digit}` }).click();
  await page.getByTestId("pin-submit").click();

  await expect(page.getByRole("heading", { name: "Ready to sell" })).toBeVisible();
  await expect(page.getByTestId("sync-chip")).toBeVisible();

  await page.getByTestId("lock").click();
  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible();
});

test("a wrong PIN says so and clears the digits", async ({ page }) => {
  await mockApi(page, { enrollStatus: 200, pinStatus: 401 });
  await page.goto("/");
  await page.getByLabel("Setup code").fill("ABCD-1234");
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("User ID").fill("u1");
  for (const digit of ["9", "9", "9", "9"])
    await page.getByRole("button", { name: `Digit ${digit}` }).click();
  await page.getByTestId("pin-submit").click();
  await expect(page.getByTestId("pin-error")).toContainText("That PIN did not work");
  await expect(page.getByTestId("pin-dots")).toHaveAccessibleName("0 digits entered");
});

test("the terminal stays enrolled after a reload and asks for the PIN again", async ({ page }) => {
  await mockApi(page, { enrollStatus: 200, pinStatus: 200 });
  await page.goto("/");
  await page.getByLabel("Setup code").fill("ABCD-1234");
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible({ timeout: 20_000 });
});

test("offline shows the banner and does not block the screen", async ({ page, context }) => {
  await mockApi(page, { enrollStatus: 200, pinStatus: 200 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up this terminal" })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toBeHidden();
});
