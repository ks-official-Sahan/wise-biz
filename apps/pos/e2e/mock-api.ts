import { gzipSync } from "node:zlib";

import { expect } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Anything with `route`: a page in the browser suite, the app context in the Electron suite. */
export type Routable = Pick<Page, "route">;

const API = "http://localhost:3000";
const SNAP = "http://localhost:3000/snap";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-expose-headers": "etag,retry-after",
};

// EAN-13 with valid check digits: 4006381333931 (Tea), 5901234123457 (Rice).
export const TEA = "4006381333931";
export const RICE = "5901234123457";

const variant = (id: string, name: string, sku: string) => ({
  entity: "variant",
  id,
  version: 1,
  payload: {
    variantId: id,
    productName: name,
    name,
    sku,
    taxCategory: "std",
    categoryIds: [],
    archived: false,
  },
});

const SNAPSHOTS: Record<string, { cursor: string; rows: unknown[] }> = {
  catalog: {
    cursor: "c1",
    rows: [
      variant("v1", "Green Tea 500 g", "GT-500"),
      variant("v2", "Basmati Rice", "BR-1"),
      { entity: "barcodes", id: "v1", version: 1, payload: { variantId: "v1", codes: [TEA] } },
      { entity: "barcodes", id: "v2", version: 1, payload: { variantId: "v2", codes: [RICE] } },
    ],
  },
  prices: {
    cursor: "p1",
    rows: [
      {
        entity: "price_list",
        id: "pl1",
        version: 1,
        payload: {
          priceListId: "pl1",
          name: "Main",
          currency: "USD",
          taxRegionId: "tr1",
          branchId: null,
          customerGroup: null,
          validFrom: null,
          validTo: null,
          cashIncrementMinor: null,
          version: 1,
          archived: false,
        },
      },
      {
        entity: "price",
        id: "pl1:v1",
        version: 1,
        payload: { priceListId: "pl1", variantId: "v1", priceMinor: 500 },
      },
      {
        entity: "price",
        id: "pl1:v2",
        version: 1,
        payload: { priceListId: "pl1", variantId: "v2", priceMinor: 800 },
      },
    ],
  },
  tax: {
    cursor: "t1",
    rows: [
      {
        entity: "tax_region",
        id: "tr1",
        version: 1,
        payload: {
          taxRegionId: "tr1",
          code: "US",
          name: "US",
          inclusive: false,
          strategy: "per-line",
          roundingMode: "half-even",
          version: 1,
          rules: [
            { id: "r1", name: "VAT", rateBps: 1000, compound: false, categories: ["*"], order: 1 },
          ],
        },
      },
    ],
  },
  promotions: { cursor: "m1", rows: [] },
  stock_branch: {
    cursor: "s1",
    rows: [
      {
        entity: "stock",
        id: "loc1:v1:-",
        version: 0,
        payload: { variantId: "v1", locationId: "loc1" },
      },
      {
        entity: "stock",
        id: "loc1:v2:-",
        version: 0,
        payload: { variantId: "v2", locationId: "loc1" },
      },
    ],
  },
};

const ndjson = (s: { cursor: string; rows: unknown[] }) =>
  gzipSync(
    [JSON.stringify({ cursor: s.cursor }), ...s.rows.map((r) => JSON.stringify(r))].join("\n"),
  );

export async function mockApi(page: Routable): Promise<void> {
  await page.route(`${SNAP}/**`, (route: Route) => {
    const dataset = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const snap = SNAPSHOTS[dataset];
    return snap === undefined
      ? route.fulfill({ status: 404, headers: CORS })
      : route.fulfill({
          status: 200,
          headers: { ...CORS, "content-type": "application/gzip" },
          body: ndjson(snap),
        });
  });
  await page.route(`${API}/v1/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        headers: {
          ...CORS,
          "content-type": status >= 400 ? "application/problem+json" : "application/json",
        },
        body: JSON.stringify(body),
      });
    switch (url.pathname) {
      case "/v1/devices/enroll":
        return json(200, {
          deviceId: "d",
          tenantId: "t",
          branchId: "b",
          name: "Front counter",
          status: "active",
        });
      case "/v1/devices/heartbeat":
        return json(200, { status: "active", serverTime: new Date().toISOString() });
      case "/v1/devices/pin-login":
        return json(200, {
          sessionId: "s",
          userId: "u1",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      case "/v1/devices/pin-logout":
        return json(200, {});
      case "/v1/sync/bootstrap": {
        const dataset = url.searchParams.get("dataset") ?? "";
        const snap = SNAPSHOTS[dataset];
        return json(200, {
          cursor: snap?.cursor ?? null,
          url: snap === undefined ? null : `${SNAP}/${dataset}`,
        });
      }
      case "/v1/sync/changes":
        return json(200, { changes: [], nextCursor: null, hasMore: false });
      case "/v1/sync/commands":
        return json(200, { acks: [] });
      default:
        return json(404, { code: "NOT_FOUND", title: "Not found", status: 404 });
    }
  });
}

export async function signIn(
  page: Page,
  o: { routes?: Routable; goto?: boolean } = {},
): Promise<void> {
  await mockApi(o.routes ?? page);
  if (o.goto !== false) await page.goto("/");
  await page.getByLabel("Setup code").fill("ABCD-1234");
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("User ID").fill("u1");
  for (const d of ["1", "2", "3", "4"])
    await page.getByRole("button", { name: `Digit ${d}` }).click();
  await page.getByTestId("pin-submit").click();
  await expect(page.getByTestId("sell-search")).toBeVisible();
  await expect(page.getByTestId("sell-waiting")).toBeHidden({ timeout: 15_000 });
}

/** Types a code the way a keyboard-wedge scanner does: all keys a few milliseconds apart, then Enter. */
export async function scan(page: Page, code: string): Promise<void> {
  await page.evaluate(async (c) => {
    const fire = (key: string) => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    };
    for (const ch of c) {
      fire(ch);
      await new Promise((r) => setTimeout(r, 4));
    }
    fire("Enter");
  }, code);
}
