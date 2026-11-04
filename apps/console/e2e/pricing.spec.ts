import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Pricing screens against a mocked API (no database): session, business and pricing endpoints answered from memory. */

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const LIST = uuid(100);
const REGION = uuid(200);
const PROMO = uuid(300);
const V1 = uuid(401);
const V2 = uuid(402);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface State {
  prices: Map<string, number>;
  listVersion: number;
  promo: Record<string, unknown>;
  coupons: { id: string; code: string }[];
}

async function mockApi(page: Page): Promise<{ calls: Call[]; state: State }> {
  const calls: Call[] = [];
  const state: State = {
    prices: new Map([
      [V1, 1000],
      [V2, 250],
    ]),
    listVersion: 3,
    promo: {
      id: PROMO,
      name: "Weekend",
      status: "draft",
      priority: 0,
      stackable: true,
      target: { kind: "cart" },
      effect: { kind: "percent", bps: 1000 },
      requiresCoupon: false,
      customerGroups: null,
      startsAt: null,
      endsAt: null,
      minQty: null,
      minAmountMinor: null,
      version: 1,
      publishedAt: null,
    },
    coupons: [],
  };
  const list = () => ({
    id: LIST,
    name: "Retail",
    currency: "USD",
    taxRegionId: REGION,
    branchId: null,
    customerGroup: null,
    validFrom: null,
    validTo: null,
    cashIncrementMinor: null,
    version: state.listVersion,
    archived: false,
  });
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
    if (path === "/v1/catalog/categories") return json(200, { categories: [] });
    if (path === "/v1/catalog/variants")
      return json(200, {
        variants: [
          {
            id: V1,
            productId: uuid(1),
            sku: "TEA-1",
            name: "Box",
            productName: "Green Tea",
            productVersion: 1,
          },
          {
            id: V2,
            productId: uuid(2),
            sku: "RICE-1",
            name: "1kg",
            productName: "Rice",
            productVersion: 1,
          },
        ],
      });
    if (path === "/v1/search/variants")
      return json(200, {
        hits: [
          { variantId: uuid(403), productId: uuid(3), title: "Honey", sku: "HON-1", barcodes: [] },
        ],
      });
    if (path === "/v1/pricing/tax-regions")
      return json(200, {
        taxRegions: [
          {
            id: REGION,
            code: "us",
            name: "United States",
            inclusive: false,
            strategy: "per-line",
            roundingMode: "half-even",
            version: 1,
            rules: [
              {
                id: uuid(250),
                name: "Sales tax",
                rateBps: 800,
                compound: false,
                categories: ["*"],
                order: 0,
              },
            ],
          },
        ],
      });
    if (path === "/v1/pricing/fees") return json(200, { fees: [] });
    if (path === "/v1/pricing/price-lists") return json(200, { priceLists: [list()] });
    if (path === `/v1/pricing/price-lists/${LIST}` && req.method() === "GET")
      return json(200, list());
    if (path === `/v1/pricing/price-lists/${LIST}/prices`) {
      if (req.method() === "PUT") {
        const b = body as {
          version: number;
          prices: { variantId: string; priceMinor: number | null }[];
        };
        if (b.version !== state.listVersion) return json(409, { status: 409, title: "Conflict" });
        for (const p of b.prices) {
          if (p.priceMinor === null) state.prices.delete(p.variantId);
          else state.prices.set(p.variantId, p.priceMinor);
        }
        state.listVersion += 1;
        return json(200, {
          priceListId: LIST,
          version: state.listVersion,
          changed: b.prices.length,
        });
      }
      return json(200, {
        items: [...state.prices].map(([variantId, priceMinor]) => ({ variantId, priceMinor })),
        nextCursor: null,
      });
    }
    if (path === "/v1/pricing/promotions" && req.method() === "GET")
      return json(200, { items: [state.promo], nextCursor: null });
    if (path === `/v1/pricing/promotions/${PROMO}` && req.method() === "GET")
      return json(200, state.promo);
    if (path === `/v1/pricing/promotions/${PROMO}` && req.method() === "PATCH") {
      Object.assign(state.promo, body, { version: (state.promo.version as number) + 1 });
      return json(200, state.promo);
    }
    if (path === `/v1/pricing/promotions/${PROMO}/publish`) {
      Object.assign(state.promo, {
        status: "published",
        version: (state.promo.version as number) + 1,
      });
      return json(200, state.promo);
    }
    if (path === `/v1/pricing/promotions/${PROMO}/coupons`) {
      if (req.method() === "POST") {
        const b = body as { id: string; code: string };
        state.coupons.push({ id: b.id, code: b.code });
        return json(201, { ...b, promotionId: PROMO, maxUses: null, uses: 0, active: true });
      }
      return json(200, {
        coupons: state.coupons.map((c) => ({
          ...c,
          promotionId: PROMO,
          maxUses: null,
          uses: 0,
          active: true,
        })),
      });
    }
    return json(404, { status: 404, title: "Not found" });
  });
  return { calls, state };
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("pricing tabs list lists, tax regions and promotions", async ({ page }) => {
  await mockApi(page);
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Retail" })).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "Tax regions" }).click();
  await expect(page.getByText("Sales tax 8%")).toBeVisible();
  await a11y(page);

  await page.getByRole("tab", { name: "Promotions" }).click();
  await expect(page.getByRole("link", { name: "Weekend" })).toBeVisible();
  await expect(page.getByText("10% off the whole cart")).toBeVisible();

  // Arrow keys move between tabs.
  await page.getByRole("tab", { name: "Promotions" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Tax regions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("edits prices, reviews the change and saves with the list version", async ({ page }) => {
  const { calls, state } = await mockApi(page);
  await page.goto(`/pricing/lists/${LIST}`);
  await expect(page.getByText("Green Tea · Box")).toBeVisible();
  await expect(page.getByText("Rice · 1kg")).toBeVisible();
  await a11y(page);

  await page.getByLabel("New price for Green Tea · Box").fill("12.00");
  await page.getByLabel("New price for Rice · 1kg").fill("");
  await expect(page.getByText("2 unsaved change(s).")).toBeVisible();

  // A typo blocks the save and says why.
  await page.getByLabel("New price for Green Tea · Box").fill("1.234");
  await expect(page.getByRole("button", { name: "Review and save" })).toBeDisabled();
  await page.getByLabel("New price for Green Tea · Box").fill("12.00");

  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("0 new, 1 changed, 1 removed.");
  await expect(dialog).toContainText("$10.00 → $12.00");
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Save prices" }).click();

  await expect(page.getByText("Saved 2 price change(s).")).toBeVisible();
  const put = calls.find((c) => c.method === "PUT");
  expect(put?.body).toEqual({
    version: 3,
    prices: [
      { variantId: V1, priceMinor: 1200 },
      { variantId: V2, priceMinor: null },
    ],
  });
  expect(state.prices.get(V1)).toBe(1200);
  expect(state.prices.has(V2)).toBe(false);
});

test("builds a promotion draft, previews it and publishes", async ({ page }) => {
  const { calls, state } = await mockApi(page);
  await page.goto(`/pricing/promotions/${PROMO}`);
  await expect(page.getByRole("heading", { name: "Weekend", level: 1 })).toBeVisible();
  await a11y(page);

  await page.getByLabel("Percentage off").fill("15");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  const patch = calls.find((c) => c.method === "PATCH");
  expect(patch?.body).toMatchObject({ version: 1, effect: { kind: "percent", bps: 1500 } });

  await page.getByRole("button", { name: "Review and publish" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("15% off the whole cart");
  await expect(dialog).toContainText("$20.00");
  await expect(dialog).toContainText("$17.00");
  expect(calls.filter((c) => c.path.endsWith("/publish"))).toHaveLength(0);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByText("Published and archived promotions cannot be edited.")).toBeVisible();
  expect(state.promo.status).toBe("published");
});

test("a coupon-only promotion takes coupon codes", async ({ page }) => {
  const { calls, state } = await mockApi(page);
  state.promo.requiresCoupon = true;
  await page.goto(`/pricing/promotions/${PROMO}`);
  await page.getByLabel("Code", { exact: true }).fill("SPRING10");
  await page.getByRole("button", { name: "Add code" }).click();
  await expect(page.getByRole("rowheader", { name: "SPRING10" })).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/coupons"))?.body).toMatchObject({ code: "SPRING10" });
});
