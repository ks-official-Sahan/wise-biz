import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Stock counts and expiry against a mocked API (no database). Each test keeps its own small in-memory state. */

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const BRANCH = uuid(10);
const FLOOR = uuid(20);
const BACK = uuid(21);
const V1 = uuid(401);
const V2 = uuid(402);
const COUNT_ID = uuid(700);
const B1 = uuid(800);
const B2 = uuid(801);

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

async function mockApi(
  page: Page,
  opts: { countStatus: string; batches: boolean },
): Promise<Call[]> {
  const calls: Call[] = [];
  const count = {
    id: COUNT_ID,
    locationId: FLOOR,
    kind: "full",
    scope: { categoryIds: [], variantCount: 0 },
    blind: false,
    mode: "frozen",
    status: opts.countStatus,
    currency: "USD",
    note: "",
    version: 3,
    lineCount: 2,
    countedLineCount: 2,
    openedAt: "2026-11-10T09:00:00Z",
    startedAt: "2026-11-10T09:05:00Z",
    closedAt: "2026-11-10T17:00:00Z",
    approvedAt: null as string | null,
    cancelledAt: null,
  };
  const lines = [
    {
      variantId: V1,
      batchId: null,
      round: 1,
      countedQty: "8",
      recountRequested: false,
      note: "",
      expectedQty: "10",
      closeQty: "10",
    },
    {
      variantId: V2,
      batchId: null,
      round: 1,
      countedQty: "6",
      recountRequested: false,
      note: "",
      expectedQty: "6",
      closeQty: "6",
    },
  ];
  const batches = [
    {
      batchId: B1,
      variantId: V1,
      locationId: FLOOR,
      lotCode: "LOT-1",
      expiresOn: "2026-11-13",
      daysLeft: 2,
      qtyOnHand: "4",
      unitCostMinor: 250,
      valueMinor: 1000,
      currency: "USD",
      salePriceMinor: null,
    },
    {
      batchId: B2,
      variantId: V2,
      locationId: FLOOR,
      lotCode: "LOT-2",
      expiresOn: "2026-12-01",
      daysLeft: 20,
      qtyOnHand: "6",
      unitCostMinor: 300,
      valueMinor: 1800,
      currency: "USD",
      salePriceMinor: null,
    },
  ];

  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
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
          {
            locationId: FLOOR,
            branchId: BRANCH,
            name: "Shop floor",
            kind: "sales_floor",
            archived: false,
          },
          {
            locationId: BACK,
            branchId: BRANCH,
            name: "Backroom",
            kind: "backroom",
            archived: false,
          },
        ],
      });
    if (path === "/v1/catalog/variants")
      return json(200, {
        variants: [
          { id: V1, productId: uuid(1), sku: "TEA-1", name: "Box", productName: "Green Tea" },
          { id: V2, productId: uuid(2), sku: "MILK-1", name: "1L", productName: "Milk" },
        ],
      });

    if (path === "/v1/inventory/counts" && req.method() === "GET")
      return json(200, { items: [count], nextCursor: null });
    if (path === `/v1/inventory/counts/${COUNT_ID}` && req.method() === "GET")
      return json(200, { count, lines, nextCursor: null });
    if (path === `/v1/inventory/counts/${COUNT_ID}/variance`)
      return json(200, {
        count,
        lines: lines.map((l) => ({
          variantId: l.variantId,
          batchId: null,
          countedQty: l.countedQty,
          expectedQty: l.expectedQty,
          varianceQty: String(Number(l.countedQty) - Number(l.expectedQty)),
          unitCostMinor: 250,
          valueMinor: 250,
        })),
        totals: { shortValueMinor: 500, overValueMinor: 0, unvaluedLines: 0 },
      });
    if (path === `/v1/inventory/counts/${COUNT_ID}/approve`) {
      count.status = "approved";
      count.approvedAt = "2026-11-11T10:00:00Z";
      count.version += 1;
      return json(200, count);
    }

    if (path === "/v1/inventory/expiry/near-expiry")
      return json(200, {
        asOf: "2026-11-11",
        days: 30,
        items: opts.batches ? batches : [],
        nextCursor: null,
      });
    if (path === "/v1/inventory/expiry/fefo-report")
      return json(200, { from: "2026-10-12", to: "2026-11-11", items: [], nextCursor: null });
    if (path === "/v1/inventory/expiry/writeoffs") {
      const b = body as {
        locationId: string;
        lines: { variantId: string; batchId: string; qty: string }[];
      };
      return json(201, {
        id: uuid(900),
        locationId: b.locationId,
        valueMinor: 750,
        currency: "USD",
        lines: b.lines.map((l) => ({
          variantId: l.variantId,
          batchId: l.batchId,
          qty: l.qty,
          unitCostMinor: 250,
          valueMinor: 750,
        })),
        balances: [],
      });
    }

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

test("lists a count in review, reads the variance, and approves it behind a confirmation", async ({
  page,
}) => {
  const calls = await mockApi(page, { countStatus: "review", batches: false });
  await page.goto("/counts");
  await expect(page.getByRole("heading", { name: "Stock counts", level: 1 })).toBeVisible();
  const listed = page.getByRole("row", { name: /Full count/ });
  await expect(listed.getByText("In review", { exact: true })).toBeVisible();
  await expect(listed).toContainText("2 of 2 lines counted");
  await a11y(page);

  await page.getByRole("link", { name: "Full count", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/counts/${COUNT_ID}$`));
  await expect(page.getByRole("heading", { name: "Full count", level: 1 })).toBeVisible();
  const variance = page.getByRole("table", { name: /Variance per line/ });
  const tea = variance.getByRole("row", { name: /Green Tea/ });
  await expect(tea).toContainText("Short by 2");
  await expect(tea).toContainText("Short $2.50");
  await expect(page.getByText("Short value $5.00")).toBeVisible();
  await a11y(page);

  await page.getByRole("button", { name: "Approve variances" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve these variances?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Approve variances" }).click();

  await expect.poll(() => calls.filter((c) => c.path.endsWith("/approve")).length).toBe(1);
  const approve = calls.find((c) => c.path.endsWith("/approve"));
  expect(approve?.body).toEqual({ version: 3 });
  expect(approve?.key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create gap cases" })).toBeVisible();
  await a11y(page);
});

test("writes off an expiring batch behind a confirmation and leaves a later batch alone", async ({
  page,
}) => {
  const calls = await mockApi(page, { countStatus: "open", batches: true });
  await page.goto("/expiry");
  await expect(page.getByRole("heading", { name: "Expiry", level: 1 })).toBeVisible();
  const row = page.getByRole("row", { name: /Green Tea/ });
  await expect(row).toContainText("2 days left");
  await expect(row).toContainText("$10.00");
  await a11y(page);

  // A batch with 20 days left cannot be written off: its checkbox is disabled and says why.
  const later = page.getByRole("checkbox", { name: "Write off Milk · 1L, LOT-2" });
  await expect(later).toBeDisabled();

  await page.getByRole("checkbox", { name: "Write off Green Tea · Box, LOT-1" }).check();
  await page.getByRole("button", { name: "Write off picked batches" }).click();
  const dialog = page.getByRole("dialog", { name: "Write off these batches?" });
  await dialog.getByLabel("Quantity to write off, Green Tea · Box").fill("3");
  await a11y(page);
  await dialog.getByRole("button", { name: "Write off stock", exact: true }).click();

  await expect.poll(() => calls.filter((c) => c.path.endsWith("/writeoffs")).length).toBe(1);
  const call = calls.find((c) => c.path.endsWith("/writeoffs"));
  expect(call?.body).toEqual({
    locationId: FLOOR,
    lines: [{ variantId: V1, batchId: B1, qty: "3" }],
  });
  expect(call?.key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Wrote off $7.50 of stock across 1 batch.")).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "FEFO report" }).click();
  await expect(page.getByRole("tabpanel", { name: "FEFO report" })).toBeVisible();
  await expect(page.getByText("No sales or transfers in this window")).toBeVisible();
  await a11y(page);
});
