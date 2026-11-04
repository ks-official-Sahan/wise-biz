import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Stock and label screens against a mocked API (no database). */

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** A local calendar date n days from today, the way the screen counts. */
const inDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const BRANCH = uuid(10);
const LOC = uuid(20);
const V1 = uuid(401);
const V2 = uuid(402);

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

async function mockApi(page: Page): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body: unknown =
      req.postData() === null ? undefined : JSON.parse(req.postData() ?? "null");
    if (req.method() !== "GET")
      calls.push({ method: req.method(), path, body, key: req.headers()["idempotency-key"] });

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
    if (path === `/v1/tenancy/branches/${BRANCH}/locations`)
      return json(200, {
        locations: [
          { locationId: LOC, branchId: BRANCH, name: "Shop floor", kind: "sales", archived: false },
        ],
      });
    if (path === "/v1/catalog/variants")
      return json(200, {
        variants: [
          { id: V1, productId: uuid(1), sku: "TEA-1", name: "Box", productName: "Green Tea" },
          { id: V2, productId: uuid(2), sku: "MILK-1", name: "1L", productName: "Milk" },
        ],
      });
    if (path === "/v1/search/variants")
      return json(200, {
        hits: [
          {
            variantId: V1,
            productId: uuid(1),
            title: "Green Tea",
            sku: "TEA-1",
            barcodes: ["4006381333931"],
          },
        ],
      });
    if (path === "/v1/inventory/balances") {
      const expiring = url.searchParams.get("expiringBefore") !== null;
      return json(200, {
        items: expiring
          ? [
              {
                locationId: LOC,
                variantId: V2,
                batchId: uuid(900),
                qty: "6",
                reserved: "0",
                available: "6",
                lotCode: "L-77",
                expiresOn: inDays(5),
              },
            ]
          : [
              {
                locationId: LOC,
                variantId: V1,
                batchId: null,
                qty: "12",
                reserved: "2",
                available: "10",
              },
              {
                locationId: LOC,
                variantId: V2,
                batchId: null,
                qty: "3",
                reserved: "0",
                available: "3",
              },
            ],
        nextCursor: null,
      });
    }
    if (path === "/v1/inventory/thresholds")
      return json(200, {
        thresholds: [
          {
            locationId: LOC,
            variantId: V2,
            minQty: "5",
            maxQty: null,
            lowSince: "2026-11-01T10:00:00Z",
          },
          { locationId: LOC, variantId: V1, minQty: "2", maxQty: null, lowSince: null },
        ],
      });
    if (path === "/v1/inventory/receipts")
      return json(201, { id: (body as { id: string }).id, balances: [], lines: [] });
    if (path === "/v1/inventory/adjustments")
      return json(201, { id: (body as { id: string }).id, valueMinor: 0, balances: [] });
    return json(404, { status: 404, title: "Not found" });
  });
  return calls;
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("shows stock on hand, low stock and expiring batches for a location", async ({ page }) => {
  await mockApi(page);
  await page.goto("/stock");
  await expect(page.getByRole("heading", { name: "Stock", level: 1 })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Green Tea · Box" })).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "Low stock" }).click();
  await expect(page.getByRole("rowheader", { name: "Milk · 1L" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Green Tea · Box" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Expiring soon" }).click();
  await expect(page.getByText("L-77")).toBeVisible();
  await expect(page.getByText("5 days")).toBeVisible();
  await a11y(page);
});

test("receives stock with cost, lot and expiry under one idempotency key", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/stock");
  await page.getByRole("button", { name: "Receive stock" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Add a product").fill("tea");
  await dialog.getByRole("button", { name: "Add Green Tea" }).click();

  // A bad quantity is explained and nothing is sent.
  await dialog.getByLabel("Quantity").fill("0");
  await dialog.getByRole("button", { name: "Receive stock" }).click();
  await expect(dialog.getByText("The quantity cannot be zero.")).toBeVisible();
  expect(calls.filter((c) => c.path.endsWith("/receipts"))).toHaveLength(0);

  await dialog.getByLabel("Quantity").fill("24");
  await dialog.getByLabel("Unit cost (USD)").fill("2.50");
  await dialog.getByLabel("Lot code").fill("L-9");
  await dialog.getByLabel("Expires").fill("2027-03-01");
  await a11y(page);
  await dialog.getByRole("button", { name: "Receive stock" }).click();

  await expect.poll(() => calls.filter((c) => c.path.endsWith("/receipts")).length).toBe(1);
  const call = calls.find((c) => c.path.endsWith("/receipts"));
  expect(call?.body).toMatchObject({
    locationId: LOC,
    currency: "USD",
    lines: [
      { variantId: V1, qty: "24", unitCostMinor: 250, lotCode: "L-9", expiresOn: "2027-03-01" },
    ],
  });
  expect(call?.key).toBe((call?.body as { id: string }).id);
});

test("adjusts stock with a reason, and asks for a note when the reason is other", async ({
  page,
}) => {
  const calls = await mockApi(page);
  await page.goto("/stock");
  await page.getByRole("button", { name: "Adjust stock" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Add a product").fill("tea");
  await dialog.getByRole("button", { name: "Add Green Tea" }).click();
  await dialog.getByLabel("Change in quantity").fill("-3");
  await dialog.getByLabel("Reason").selectOption("other");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog.getByText("Explain what happened.")).toBeVisible();

  await dialog.getByLabel("What happened").fill("Dropped a box");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/adjustments")).length).toBe(1);
  expect(calls.find((c) => c.path.endsWith("/adjustments"))?.body).toMatchObject({
    reason: "other",
    note: "Dropped a box",
    lines: [{ variantId: V1, batchId: null, qty: "-3" }],
  });
});

test("previews barcode labels and the ZPL for a label printer", async ({ page }) => {
  await mockApi(page);
  await page.goto("/stock/labels");
  await page.getByLabel("Add a product").fill("tea");
  await page.getByRole("button", { name: "Add Green Tea" }).click();
  await page.getByLabel("Copies of Green Tea").fill("3");
  await page.getByLabel("Price on the label for Green Tea").fill("$4.00");
  await expect(page.getByText("3 label(s), 1 sheet(s)")).toBeVisible();
  await expect(page.getByRole("img", { name: "Barcode 4006381333931" })).toHaveCount(3);
  await a11y(page);

  await page.getByLabel("Print as").selectOption("zpl");
  const zpl = page.getByLabel("ZPL preview");
  await expect(zpl).toContainText("^BEN,70,Y,N^FD400638133393^FS");
  await expect(zpl).toContainText("^PQ3,0,1,N");
  await expect(zpl).toContainText("$4.00");
});
