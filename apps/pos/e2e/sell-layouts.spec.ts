import { expect, test } from "@playwright/test";

// Design-gate screenshots for P1-09. Build with EXPO_PUBLIC_PREVIEW=1 (e2e:build does).
const WIDTHS = [
  { name: "phone-390", width: 390, height: 844, id: "sell-phone" },
  { name: "tablet-834", width: 834, height: 1112, id: "sell-tablet-portrait" },
  { name: "tablet-landscape-1112", width: 1112, height: 834, id: "sell-tablet-landscape" },
  { name: "desktop-1440", width: 1440, height: 900, id: "sell-desktop" },
] as const;

for (const w of WIDTHS) {
  test(`sell layout at ${String(w.width)} px`, async ({ page }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/preview/sell");
    await expect(page.getByTestId(w.id)).toBeVisible();
    await expect(page.getByTestId("sell-pay")).toBeVisible();
    await expect(page).toHaveScreenshot(`sell-${w.name}.png`);
  });
}
