import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** Checks that need only the console: headers, routing, and accessibility of the public pages. */

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test("sends a nonce CSP and the static security headers", async ({ request }) => {
  const res = await request.get("/sign-in");
  const headers = res.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("uses a fresh nonce per request", async ({ request }) => {
  const nonce = async (): Promise<string | undefined> =>
    /'nonce-([^']+)'/.exec(
      (await request.get("/sign-in")).headers()["content-security-policy"] ?? "",
    )?.[1];
  const [a, b] = [await nonce(), await nonce()];
  expect(a).toBeDefined();
  expect(a).not.toBe(b);
});

test("answers unknown URLs with the 404 page", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
});

test("keeps invite tokens out of the referrer", async ({ request }) => {
  const res = await request.get("/invite/accept");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
});

test("sends signed-out visitors to sign in", async ({ page }) => {
  await page.goto("/people");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fpeople/);
});

for (const vp of VIEWPORTS) {
  for (const path of ["/sign-in", "/sign-up"]) {
    test(`${path} has no axe violations at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
        .analyze();
      expect(result.violations).toEqual([]);
    });
  }
}
