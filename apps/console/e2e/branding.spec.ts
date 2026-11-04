import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Branding screens against a mocked API (no database). */

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const BASE_THEME = {
  version: 1,
  name: "Kade Cafe",
  modes: { available: ["light", "dark"], default: "light" },
  brand: { seed: "#c2410c" },
  font: { body: "inter", numeric: "ibm-plex-mono" },
  density: "comfortable",
};

interface State {
  published: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  template: Record<string, unknown> | null;
}

async function mockApi(page: Page): Promise<{ calls: Call[]; state: State }> {
  const calls: Call[] = [];
  const state: State = { published: null, draft: null, template: null };
  const version = (input: unknown, status: string, v: number | null) => ({
    id: `0190a000-0000-7000-8000-00000000${status === "draft" ? "d1" : "b1"}`,
    version: v,
    status,
    name: (input as { name: string }).name,
    input,
    createdAt: "2026-11-03T10:00:00Z",
    publishedAt: v === null ? null : "2026-11-03T10:00:00Z",
  });
  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
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
    if (path === "/v1/theming/theme")
      return json(200, { published: state.published, draft: state.draft });
    if (path === "/v1/theming/theme/versions")
      return json(200, { versions: state.published === null ? [] : [state.published] });
    if (path === "/v1/theming/theme/draft") {
      state.draft = version((body as { input: unknown }).input, "draft", null);
      return json(200, state.draft);
    }
    if (path === "/v1/theming/theme/publish") {
      const draft = state.draft as { input: unknown } | null;
      if (draft === null) return json(404, { status: 404, title: "Not found" });
      state.published = version(draft.input, "published", 1);
      state.draft = null;
      return json(200, state.published);
    }
    if (path === "/v1/theming/receipt-templates") {
      if (req.method() === "PUT") {
        const b = body as Record<string, unknown>;
        state.template = {
          id: "0190a000-0000-7000-8000-0000000000c1",
          branchId: null,
          version: ((state.template?.version as number | undefined) ?? 0) + 1,
          updatedAt: "2026-11-03T10:00:00Z",
          ...b,
        };
        return json(200, state.template);
      }
      return json(200, { templates: state.template === null ? [] : [state.template] });
    }
    return json(404, { status: 404, title: "Not found" });
  });
  return { calls, state };
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    // The preview paints the owner's own colours (even a failing draft): it is not console UI.
    .exclude('[aria-label="Theme preview"]')
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

test("changes the brand colour, sees it in the preview, saves a draft and publishes", async ({
  page,
}) => {
  const { calls, state } = await mockApi(page);
  state.published = version(BASE_THEME);
  await page.goto("/branding");
  await expect(page.getByRole("heading", { name: "Branding", level: 1 })).toBeVisible();
  await expect(page.getByText("Live: version 1.")).toBeVisible();
  await expect(page.getByLabel("Theme preview")).toBeVisible();
  await a11y(page);

  const accentBefore = await page
    .getByLabel("Theme preview")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--pv-accent"));
  await page.getByLabel("Brand colour", { exact: true }).fill("#1d4ed8");
  const accentAfter = await page
    .getByLabel("Theme preview")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--pv-accent"));
  expect(accentAfter).not.toBe(accentBefore);

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/Draft saved/).first()).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/draft"))?.body).toMatchObject({
    input: { brand: { seed: "#1d4ed8" } },
  });

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published\. Terminals pick it up/)).toBeVisible();
  expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(true);
});

test("blocks publishing while a colour is too pale, and fixes it in one click", async ({
  page,
}) => {
  const { state } = await mockApi(page);
  state.draft = version(
    { ...BASE_THEME, name: "Pale", overrides: { light: { accent: "#ffff99" } } },
    "draft",
  );
  await page.goto("/branding");
  await expect(page.getByText("These colours are too hard to read.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await a11y(page);

  await page.getByRole("button", { name: "Use the suggested colour" }).first().click();
  await expect(page.getByText("These colours are too hard to read.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
});

test("edits the receipt: reorders blocks, sees the paper preview and saves", async ({ page }) => {
  const { calls } = await mockApi(page);
  // Tall window: the sticky save bar would otherwise sit over the lower block buttons during the scan.
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.goto("/branding");
  await page.getByRole("tab", { name: "Receipt" }).click();
  const preview = page.getByLabel(/Receipt preview, 80 mm/);
  await expect(preview).toContainText("Sample Cafe");
  await expect(preview).toContainText("TOTAL");
  await a11y(page);

  await page.getByLabel("Invoice prefix").fill("inv-");
  await expect(preview).toContainText("Sale INV-42");
  await page.getByLabel("Paper").selectOption("58");
  await expect(page.getByLabel(/Receipt preview, 58 mm/)).toBeVisible();

  // A receipt must keep its items block.
  await page.getByRole("button", { name: "Remove Items" }).click();
  await expect(page.getByText("A receipt needs the items block.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save receipt" })).toBeDisabled();
  await page.getByLabel("Add a block").selectOption("lines");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Move Items up" }).click();

  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(page.getByText(/Saved\. Terminals use it/)).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/receipt-templates"))?.body).toMatchObject({
    paper: "58",
    invoicePrefix: "INV-",
  });
});

function version(input: unknown, status = "published") {
  return {
    id: "0190a000-0000-7000-8000-000000000001",
    version: status === "draft" ? null : 1,
    status,
    name: (input as { name: string }).name,
    input,
    createdAt: "2026-11-03T10:00:00Z",
    publishedAt: status === "draft" ? null : "2026-11-03T10:00:00Z",
  };
}
