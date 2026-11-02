import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * Catalog screens against a mocked API (no database needed): the session, the business and the catalog endpoints are
 * answered from memory, so the flows run anywhere `pnpm start` runs.
 */

interface Variant {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unitId: null;
  tracksBatches: boolean;
  taxCategory: string;
  attributes: Record<string, never>;
  version: number;
  archived: boolean;
  updatedAt: string;
  barcodes: { code: string; format: string }[];
}
interface Product {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  tagIds: string[];
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  variants: Variant[];
}

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

// Fixture: makeProduct always builds one variant.
// eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
const blankVariant: Variant = makeProduct(900).variants.at(0) as Variant;

function makeProduct(n: number, o: Partial<Product> = {}): Product {
  const id = uuid(1000 + n);
  return {
    id,
    name: `Product ${String(n).padStart(3, "0")}`,
    description: null,
    categoryId: null,
    tagIds: [],
    version: 1,
    archived: false,
    createdAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-01T10:00:00Z",
    variants: [
      {
        id: uuid(2000 + n),
        productId: id,
        sku: `SKU-${String(n).padStart(3, "0")}`,
        name: "Default",
        unitId: null,
        tracksBatches: false,
        taxCategory: "standard",
        attributes: {},
        version: 1,
        archived: false,
        updatedAt: "2026-11-01T10:00:00Z",
        barcodes: n % 2 === 0 ? [{ code: `40063813339${String(n % 10)}1`, format: "ean13" }] : [],
      },
    ],
    ...o,
  };
}

interface Calls {
  method: string;
  path: string;
  body: unknown;
}

async function mockApi(page: Page, products: Product[]): Promise<Calls[]> {
  const calls: Calls[] = [];
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
    if (path === "/v1/catalog/categories")
      return json(200, {
        categories: [{ id: uuid(1), parentId: null, name: "Drinks", path: ["Drinks"] }],
      });
    if (path === "/v1/catalog/tags") return json(200, { tags: [{ id: uuid(2), name: "Organic" }] });
    if (path === "/v1/catalog/units") return json(200, { units: [], conversions: [] });
    if (path === "/v1/search/variants") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = products
        .filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.variants.some((v) => v.sku.toLowerCase().includes(q)),
        )
        .map((p) => ({
          variantId: p.variants[0]?.id,
          productId: p.id,
          title: p.name,
          sku: p.variants[0]?.sku,
          barcodes: p.variants[0]?.barcodes.map((b) => b.code),
          score: 1,
        }));
      return json(200, { hits });
    }
    if (path === "/v1/catalog/products" && req.method() === "GET") {
      const archived = url.searchParams.get("archived") ?? "false";
      const list = products.filter((p) => archived === "all" || String(p.archived) === archived);
      const after = Number(url.searchParams.get("after") ?? "0");
      const page_ = list.slice(after, after + 50);
      return json(200, {
        products: page_,
        next: after + 50 < list.length ? String(after + 50) : null,
      });
    }
    if (path === "/v1/catalog/products" && req.method() === "POST") {
      const b = body as {
        id: string;
        name: string;
        categoryId: string | null;
        tagIds: string[];
        variants: {
          id: string;
          sku: string;
          name: string;
          taxCategory: string;
          barcodes: { code: string }[];
        }[];
      };
      const created = makeProduct(900, {
        id: b.id,
        name: b.name,
        categoryId: b.categoryId,
        tagIds: b.tagIds,
        variants: b.variants.map((v) => ({
          ...blankVariant,
          id: v.id,
          productId: b.id,
          sku: v.sku,
          name: v.name,
          taxCategory: v.taxCategory,
          barcodes: v.barcodes.map((c) => ({ code: c.code, format: "ean13" })),
        })),
      });
      products.push(created);
      return json(201, created);
    }
    const one = /^\/v1\/catalog\/products\/([^/]+)$/.exec(path);
    if (one !== null) {
      const p = products.find((x) => x.id === one[1]);
      if (p === undefined) return json(404, { status: 404, title: "Not found" });
      if (req.method() === "PATCH") {
        const b = body as { archived?: boolean; name?: string };
        if (b.archived !== undefined) p.archived = b.archived;
        if (b.name !== undefined) p.name = b.name;
        p.version += 1;
      }
      return json(200, p);
    }
    const variant = /^\/v1\/catalog\/variants\/([^/]+)$/.exec(path);
    if (variant !== null && req.method() === "PATCH") {
      const v = products.flatMap((p) => p.variants).find((x) => x.id === variant[1]);
      if (v === undefined) return json(404, { status: 404, title: "Not found" });
      Object.assign(v, body, { version: v.version + 1 });
      return json(200, v);
    }
    if (/^\/v1\/catalog\/variants\/[^/]+\/barcodes$/.test(path)) return json(200, {});
    if (path === "/v1/catalog/imports" && req.method() === "POST")
      return json(201, {
        id: uuid(5000),
        fileName: "products.csv",
        status: "awaiting_upload",
        totalRows: 0,
        okRows: 0,
        errorRows: 0,
        errors: [],
        failure: null,
        reportUrl: null,
        upload: {
          method: "PUT",
          url: "/upload/import.csv",
          headers: { "content-type": "text/csv" },
        },
        createdAt: "2026-11-02T10:00:00Z",
        finishedAt: null,
      });
    if (/^\/v1\/catalog\/imports\/[^/]+\/start$/.test(path))
      return json(200, {
        id: uuid(5000),
        fileName: "products.csv",
        status: "queued",
        totalRows: 3,
        okRows: 0,
        errorRows: 0,
        errors: [],
        failure: null,
        reportUrl: null,
        upload: null,
        createdAt: "2026-11-02T10:00:00Z",
        finishedAt: null,
      });
    if (/^\/v1\/catalog\/imports\/[^/]+$/.test(path))
      return json(200, {
        id: uuid(5000),
        fileName: "products.csv",
        status: "done",
        totalRows: 3,
        okRows: 2,
        errorRows: 1,
        errors: [{ row: 3, column: "sku", error: "1-64 letters, digits, . _ / - (required)." }],
        failure: null,
        reportUrl: null,
        upload: null,
        createdAt: "2026-11-02T10:00:00Z",
        finishedAt: "2026-11-02T10:00:05Z",
      });
    return json(404, { status: 404, title: "Not found" });
  });
  await page.route("**/upload/**", (route) => route.fulfill({ status: 200, body: "" }));
  return calls;
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("lists products a page at a time, searches and archives in bulk after a preview", async ({
  page,
}) => {
  const products = Array.from({ length: 60 }, (_, i) => makeProduct(i + 1));
  const calls = await mockApi(page, products);
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: "Products", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Product 001" })).toBeVisible();
  await a11y(page);

  // 60 products, 50 per page: the rest load on demand.
  await page.getByRole("button", { name: "Load more" }).click();
  // Only rows near the viewport are in the DOM (windowing), not all 60 that were loaded.
  await expect(page.getByRole("link", { name: "Product 060" })).toBeVisible();
  expect(await page.getByRole("row").count()).toBeLessThan(45);
  await page.evaluate(() => {
    globalThis.scrollTo(0, 0);
  });
  await expect(page.getByRole("link", { name: "Product 001" })).toBeVisible();

  await page.getByLabel("Select Product 001").check();
  await page.getByLabel("Select Product 002").check();
  await page.getByRole("button", { name: "Archive…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Archive 2 product(s)");
  await expect(dialog).toContainText("Product 001");
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === "PATCH").length).toBe(2);
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ version: 1, archived: true });

  await page.getByLabel("Search by name, SKU or barcode").fill("SKU-007");
  await expect(page.getByRole("link", { name: "Product 007" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Product 008" })).toHaveCount(0);
});

test("creates a product with a generated in-store barcode after reviewing it", async ({ page }) => {
  const products: Product[] = [];
  const calls = await mockApi(page, products);
  await page.goto("/catalog/new");
  await page.getByRole("textbox", { name: /^Name/ }).fill("Oat Milk");
  await page.getByRole("textbox", { name: /^SKU/ }).fill("OAT-1");
  await page.getByRole("button", { name: "Generate in-store barcode" }).click();
  await a11y(page);
  await page.getByRole("button", { name: "Create product" }).click();

  const review = page.getByRole("dialog");
  await expect(review).toContainText('Create "Oat Milk" with 1 variant(s).');
  expect(calls).toHaveLength(0);
  await review.getByRole("button", { name: "Confirm and save" }).click();
  await expect.poll(() => calls.length).toBe(1);
  const body = calls[0]?.body as {
    name: string;
    variants: { sku: string; taxCategory: string; barcodes: { code: string }[] }[];
  };
  expect(body.name).toBe("Oat Milk");
  expect(body.variants[0]?.sku).toBe("OAT-1");
  expect(body.variants[0]?.barcodes[0]?.code).toMatch(/^2\d{12}$/);
  await expect(page).toHaveURL(/\/catalog\/[0-9a-f]{8}-/);
});

test("shows a change summary before a tax category changes", async ({ page }) => {
  const products = [makeProduct(2)];
  const calls = await mockApi(page, products);
  await page.goto(`/catalog/${products[0]?.id ?? ""}`);
  await expect(page.getByRole("heading", { name: "Product 002", level: 1 })).toBeVisible();
  await a11y(page);
  await page.getByLabel("Tax category").fill("zero_rated");
  await page.getByRole("button", { name: "Save changes" }).click();
  const review = page.getByRole("dialog");
  await expect(review).toContainText("SKU-002: tax category standard → zero_rated.");
  expect(calls).toHaveLength(0);
  await review.getByRole("button", { name: "Confirm and save" }).click();
  await expect.poll(() => calls.some((c) => c.path.startsWith("/v1/catalog/variants/"))).toBe(true);
  expect(calls.find((c) => c.path.startsWith("/v1/catalog/variants/"))?.body).toMatchObject({
    version: 1,
    taxCategory: "zero_rated",
  });
});

test("imports a spreadsheet: matches columns, uploads and reports the rows it skipped", async ({
  page,
}) => {
  await mockApi(page, []);
  await page.goto("/catalog/import");
  await a11y(page);
  await page.getByLabel("CSV file").setInputFiles({
    name: "products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Title,Item Code,EAN,Notes\nGreen Tea,GT-1,4006381333931,x\nRice,R-1,,y\nBad,,,z\n",
    ),
  });
  await expect(page.getByText("3 row(s)")).toBeVisible();
  await expect(page.getByLabel("Product name (required)")).toHaveValue("0");
  await expect(page.getByLabel("SKU (required)")).toHaveValue("1");
  await expect(page.getByRole("cell", { name: "Green Tea" })).toBeVisible();
  await page.getByRole("button", { name: "Check and import" }).click();
  await expect(page.getByText("2 row(s) imported, 1 skipped")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("cell", { name: "1-64 letters, digits, . _ / - (required)." }),
  ).toBeVisible();
});

test("refuses a file that is not a CSV", async ({ page }) => {
  await mockApi(page, []);
  await page.goto("/catalog/import");
  await page
    .getByLabel("CSV file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("x") });
  await expect(page.getByRole("alert").filter({ hasText: "Choose a .csv file" })).toBeVisible();
});
