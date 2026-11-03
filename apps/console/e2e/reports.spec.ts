import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Reports and the home "Today" card against a mocked API (no database). */

const BRANCH = "0190a000-0000-7000-8000-000000000010";

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const salesRow = (key: string, net: number, count = 3) => ({
  key,
  currency: "USD",
  salesCount: count,
  subtotalMinor: net,
  discountMinor: 0,
  feeMinor: 0,
  taxMinor: Math.round(net * 0.08),
  payableMinor: net,
  voidsCount: 0,
  voidsPayableMinor: 0,
  returnsCount: 0,
  returnsMinor: 0,
  netMinor: net,
});

const exportBodies: unknown[] = [];
const exportRow = (status: string) => ({
  id: "0190a000-0000-7000-8000-0000000000e1",
  kind: "sales_lines",
  status,
  from: day(-7),
  to: day(0),
  rowCount: status === "ready" ? 1200 : null,
  error: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  downloadable: status === "ready",
});

async function mockApi(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.startsWith("/v1/reporting")) requests.push(`${path}?${url.searchParams.toString()}`);

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
    if (path === "/v1/tenancy/business")
      return json(200, {
        tenantId: "t1",
        name: "Shop",
        country: "US",
        currency: "USD",
        timezone: "UTC",
        taxRegion: null,
        onboardedAt: "2026-10-01T00:00:00Z",
      });
    if (path === "/v1/tenancy/branches")
      return json(200, {
        branches: [
          {
            branchId: BRANCH,
            name: "Main street",
            kind: "store",
            timezone: "UTC",
            currency: "USD",
            taxRegion: "us",
            businessDayCutoff: "04:00",
            archived: false,
          },
        ],
      });
    if (path === "/v1/tenancy/members") return json(200, { members: [], next: null });
    if (path === "/v1/tenancy/invites") return json(200, { invites: [] });
    if (path === "/v1/reporting/sales") {
      const by = url.searchParams.get("groupBy");
      if (by === "branch") return json(200, { groupBy: by, rows: [salesRow(BRANCH, 30000, 12)] });
      return json(200, {
        groupBy: "day",
        rows: [
          salesRow(day(-7), 10000, 5),
          salesRow(day(-2), 8000),
          salesRow(day(-1), 12000),
          salesRow(day(0), 15000, 6),
        ],
      });
    }
    if (path === "/v1/reporting/products")
      return json(200, {
        rows: [
          {
            variantId: "0190a000-0000-7000-8000-000000000401",
            sku: "TEA-1",
            currency: "USD",
            qty: "12.5000",
            revenueMinor: 10800,
            taxMinor: 800,
            discountMinor: 0,
            costMinor: 4000,
            netMinor: 10000,
            profitMinor: 6000,
            returnedQty: "0.0000",
            refundMinor: 0,
          },
        ],
      });
    if (path === "/v1/reporting/payments")
      return json(200, {
        rows: [
          {
            kind: "cash",
            currency: "USD",
            count: 8,
            salesMinor: 20000,
            refundsMinor: 500,
            netMinor: 19500,
          },
          {
            kind: "card",
            currency: "USD",
            count: 4,
            salesMinor: 10000,
            refundsMinor: 0,
            netMinor: 10000,
          },
        ],
      });
    if (path === "/v1/reporting/exports") {
      if (req.method() === "POST") {
        exportBodies.push(req.postDataJSON());
        return json(201, exportRow("queued"));
      }
      return json(200, { exports: [exportRow("ready")] });
    }
    if (path === "/v1/reporting/hours")
      return json(200, {
        rows: [
          { hour: 9, currency: "USD", salesCount: 4, payableMinor: 12000 },
          { hour: 13, currency: "USD", salesCount: 9, payableMinor: 27000 },
        ],
      });
    if (path === "/v1/reporting/operators")
      return json(200, {
        rows: [
          {
            operatorId: "0190a000-0000-7000-8000-00000000abcd",
            currency: "USD",
            salesCount: 12,
            payableMinor: 36000,
            averageMinor: 3000,
            discountMinor: 500,
            voidsCount: 1,
            voidsPayableMinor: 2000,
          },
          {
            operatorId: "00000000-0000-0000-0000-000000000000",
            currency: "USD",
            salesCount: 3,
            payableMinor: 9000,
            averageMinor: 3000,
            discountMinor: 0,
            voidsCount: 0,
            voidsPayableMinor: 0,
          },
        ],
      });
    if (path === "/v1/reporting/tax")
      return json(200, {
        rows: [
          {
            day: day(-1),
            currency: "USD",
            taxMinor: 960,
            payableMinor: 12000,
            netOfTaxMinor: 11040,
          },
        ],
      });
    return json(404, { status: 404, title: "Not found" });
  });
  return requests;
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("shows sales totals, the daily chart and a branch breakdown with a CSV link", async ({
  page,
}) => {
  const requests = await mockApi(page);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  await expect(page.getByText("Net sales", { exact: true })).toBeVisible();
  await expect(page.getByText("$450.00")).toBeVisible();
  await expect(page.getByRole("img", { name: /Net sales per day/ })).toBeVisible();
  await a11y(page);
  expect(requests.some((r) => r.includes("groupBy=day"))).toBe(true);

  await page.getByLabel("Break down by").selectOption("branch");
  await expect(page.getByRole("rowheader", { name: "Main street" })).toBeVisible();
  const link = page.getByRole("link", { name: "Download CSV" });
  await expect(link).toHaveAttribute("href", /\/v1\/reporting\/sales\.csv\?.*groupBy=branch/);
});

test("switches between products, payments and tax, and changes the period", async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto("/reports");
  await page.getByRole("tab", { name: "Products" }).click();
  await expect(page.getByRole("rowheader", { name: "TEA-1" })).toBeVisible();
  await expect(page.getByText("12.5", { exact: true })).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "Payments" }).click();
  await expect(page.getByRole("rowheader", { name: "cash" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "$195.00" })).toBeVisible();

  await page.getByRole("tab", { name: "Hours" }).click();
  await expect(page.getByRole("rowheader", { name: "13:00–14:00" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "09:00–10:00" })).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "Staff" }).click();
  await expect(page.getByRole("rowheader", { name: "Staff …00abcd" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Before staff were recorded" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "$360.00" })).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "Tax" }).click();
  await expect(page.getByText("$9.60").first()).toBeVisible();

  await page.getByLabel("Period").selectOption("7d");
  await expect
    .poll(() => requests.filter((r) => r.startsWith("/v1/reporting/tax")).length)
    .toBeGreaterThan(1);
  await page.getByLabel("Period").selectOption("custom");
  await page.getByLabel("To").fill("2020-01-01");
  await expect(page.getByText("Must not be before the start.")).toBeVisible();
});

test("the home page compares today with the same weekday last week", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", level: 2 })).toBeVisible();
  await expect(page.getByText("$150.00")).toBeVisible();
  await expect(page.getByText(/Same weekday last week: up 50%/)).toBeVisible();
  await a11y(page);
});

test("requests an export and offers a finished one for download", async ({ page }) => {
  await mockApi(page);
  exportBodies.length = 0;
  await page.goto("/reports");
  await page.getByRole("tab", { name: "Exports" }).click();
  await expect(page.getByText("Ready, 1200 rows")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    //v1/reporting/exports/.+/download$/,
  );
  await a11y(page);
  await page.getByRole("button", { name: "Request export" }).click();
  await expect.poll(() => exportBodies.length).toBe(1);
  expect(exportBodies[0]).toMatchObject({ kind: "sales_lines" });
});
