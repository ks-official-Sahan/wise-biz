import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Sales, shifts and terminals against a mocked API (no database). */

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const BRANCH = uuid(10);
const SALE = uuid(500);
const SHIFT = uuid(600);
const DEV = uuid(700);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const sale = (over: Record<string, unknown> = {}) => ({
  id: SALE,
  branchId: BRANCH,
  terminalId: DEV,
  shiftId: SHIFT,
  operatorId: uuid(1),
  customerId: null,
  saleNo: 42,
  invoiceNo: "INV-42",
  status: "completed",
  currency: "USD",
  subtotalMinor: 2000,
  discountMinor: 200,
  feeMinor: 0,
  taxMinor: 144,
  totalMinor: 1944,
  cashRoundingMinor: 0,
  payableMinor: 1944,
  businessDate: "2026-11-03",
  flags: ["price_mismatch"],
  completedAt: "2026-11-03T10:15:00Z",
  lines: [
    {
      line: 1,
      variantId: uuid(401),
      name: "Green Tea",
      sku: "TEA-1",
      locationId: uuid(20),
      batchId: null,
      qty: "2",
      unitPriceMinor: 1000,
      priceSource: "override",
      discountMinor: 200,
      taxMinor: 144,
      totalMinor: 1944,
      unitCostMinor: 400,
    },
  ],
  tenders: [
    {
      id: uuid(800),
      kind: "cash",
      amountMinor: 1944,
      receivedMinor: 2000,
      changeMinor: 56,
      card: null,
    },
  ],
  returns: [],
  void: null,
  ...over,
});

const zReport = {
  sales: { count: 3, payableMinor: 9000, taxMinor: 700, discountMinor: 0 },
  voids: { count: 0, payableMinor: 0 },
  returns: { count: 1, totalMinor: 500 },
  tenders: [{ kind: "cash", salesMinor: 6000, refundsMinor: 500 }],
  cash: {
    openingFloatMinor: 10000,
    salesMinor: 6000,
    refundsMinor: 500,
    voidedMinor: 0,
    payInMinor: 200,
    payOutMinor: 300,
    floatAddMinor: 0,
    dropsMinor: 4000,
    expectedMinor: 11400,
    countedMinor: 11150,
    overShortMinor: -250,
  },
  drawerOpens: 5,
};

async function mockApi(page: Page): Promise<{ calls: Call[]; devices: Record<string, unknown>[] }> {
  const calls: Call[] = [];
  const devices: Record<string, unknown>[] = [
    {
      deviceId: DEV,
      tenantId: "t1",
      branchId: BRANCH,
      name: "Front counter",
      platform: "windows",
      appVersion: "1.0.0",
      status: "active",
      enrolledAt: "2026-10-01T00:00:00Z",
      lastSeenAt: new Date().toISOString(),
    },
  ];
  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body: unknown =
      req.postData() === null ? undefined : JSON.parse(req.postData() ?? "null");
    if (req.method() !== "GET") calls.push({ method: req.method(), path, body });

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
    if (path === "/v1/sales/sales" && req.method() === "GET") {
      const flagged = url.searchParams.get("flagged") === "true";
      const items = [sale(), sale({ id: uuid(501), saleNo: 41, flags: [] })];
      return json(200, { items: flagged ? items.slice(0, 1) : items, nextCursor: null });
    }
    if (path === `/v1/sales/sales/${SALE}`) return json(200, sale());
    if (path === "/v1/sales/shifts")
      return json(200, {
        items: [
          {
            id: SHIFT,
            branchId: BRANCH,
            terminalId: DEV,
            openedBy: uuid(1),
            closedBy: uuid(1),
            businessDate: "2026-11-03",
            currency: "USD",
            status: "closed",
            openingFloatMinor: 10000,
            expectedCashMinor: 11400,
            countedCashMinor: 11150,
            overShortMinor: -250,
            blindCount: false,
            flags: [],
            openedAt: "2026-11-03T08:00:00Z",
            closedAt: "2026-11-03T16:00:00Z",
            zReport,
          },
        ],
        nextCursor: null,
      });
    if (path === `/v1/sales/shifts/${SHIFT}`)
      return json(200, {
        id: SHIFT,
        branchId: BRANCH,
        terminalId: DEV,
        openedBy: uuid(1),
        closedBy: uuid(1),
        businessDate: "2026-11-03",
        currency: "USD",
        status: "closed",
        openingFloatMinor: 10000,
        expectedCashMinor: 11400,
        countedCashMinor: 11150,
        overShortMinor: -250,
        blindCount: false,
        flags: ["over_short"],
        openedAt: "2026-11-03T08:00:00Z",
        closedAt: "2026-11-03T16:00:00Z",
        zReport,
      });
    if (path === "/v1/devices" && req.method() === "GET") return json(200, { devices });
    if (path === "/v1/devices/enrollment-codes")
      return json(201, {
        code: "K7M2Q9XA",
        qr: "wisebiz://enroll?code=K7M2Q9XA",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        branchId: BRANCH,
        name: "Back office",
      });
    if (path === `/v1/devices/${DEV}` && req.method() === "PATCH") {
      Object.assign(devices[0] ?? {}, body);
      return json(200, devices[0]);
    }
    return json(404, { status: 404, title: "Not found" });
  });
  return { calls, devices };
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("lists sales, filters the ones that need review and opens a sale", async ({ page }) => {
  await mockApi(page);
  await page.goto("/sales");
  await expect(page.getByRole("heading", { name: "Sales", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "#42" })).toBeVisible();
  await expect(page.getByRole("link", { name: "#41" })).toBeVisible();
  await expect(page.getByText("Price differs from the list")).toBeVisible();
  await a11y(page);

  await page.getByLabel("Review").selectOption("flagged");
  await expect(page.getByRole("link", { name: "#41" })).toHaveCount(0);

  await page.getByRole("link", { name: "#42" }).click();
  await expect(page.getByRole("heading", { name: "Sale #42" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: /Green Tea/ })).toBeVisible();
  await expect(page.getByText("Price changed")).toBeVisible();
  await expect(page.getByText(/given \$20\.00, change \$0\.56/)).toBeVisible();
  await a11y(page);
});

test("shows a shift's Z-report with the drawer walk and the shortage", async ({ page }) => {
  await mockApi(page);
  await page.goto("/shifts");
  await expect(page.getByText("Short $2.50")).toBeVisible();
  await page
    .getByRole("link", { name: /2026|11\/3|3\/11|3 Nov|Nov 3/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Z-report" })).toBeVisible();
  await expect(page.getByText("The drawer is short by $2.50.")).toBeVisible();
  await expect(page.getByText("Opening float")).toBeVisible();
  await expect(page.getByText("$114.00")).toBeVisible();
  await a11y(page);
});

test("adds a terminal with a one-time code and suspends it after a confirmation", async ({
  page,
}) => {
  const { calls, devices } = await mockApi(page);
  await page.goto("/devices");
  await expect(page.getByText("1 of 1 online")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Front counter" })).toBeVisible();
  await a11y(page);

  await page.getByRole("button", { name: "Add a terminal" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel(/Terminal name/).fill("Back office");
  await add.getByRole("button", { name: "Make a code" }).click();
  await expect(add.getByText("K7M2Q9XA")).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/enrollment-codes"))?.body).toEqual({
    branchId: BRANCH,
    name: "Back office",
  });
  await add.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Suspend Front counter" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("stops selling");
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  await confirm.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(1);
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "suspended" });
  expect(devices[0]?.status).toBe("suspended");
});
