import { expect, test } from "@playwright/test";

import { RICE, TEA, scan, signIn } from "./mock-api.ts";

test.use({ viewport: { width: 1440, height: 900 } });

test("scan to totals, merge, park and resume, all offline", async ({ page, context }) => {
  await signIn(page);
  await context.setOffline(true);

  await scan(page, TEA);
  await expect(page.getByText("Green Tea 500 g").first()).toBeVisible();
  await scan(page, TEA);
  await scan(page, RICE);
  // 2 x 5.00 + 8.00 = 18.00, tax 10% = 1.80, total 19.80.
  await expect(page.getByText("$19.80").first()).toBeVisible();
  await expect(page.getByText("Subtotal (3 items)")).toBeVisible();

  await page.getByRole("button", { name: "Park sale" }).click();
  await expect(page.getByText("Cart is empty")).toBeVisible();
  await page.getByTestId("sell-parked").click();
  await page.getByText("3 items").first().click();
  await expect(page.getByText("$19.80").first()).toBeVisible();
});

test("an unknown barcode says so and fills the search", async ({ page }) => {
  await signIn(page);
  await scan(page, "9780306406157");
  await expect(
    page.getByText("Barcode 9780306406157 not found. Search below or add a quick item."),
  ).toBeVisible();
  await expect(page.getByTestId("sell-search")).toHaveValue("9780306406157");
});

test("removing a line after the undo window asks for a supervisor", async ({ page }) => {
  await signIn(page);
  await scan(page, TEA);
  await expect(page.getByText("Green Tea 500 g").first()).toBeVisible();
  // Inside the window anyone can undo; wait it out, then the sheet must appear.
  await page.waitForTimeout(5500);
  await page.getByRole("button", { name: "Remove Green Tea 500 g" }).click();
  await expect(page.getByTestId("override-sheet")).toBeVisible();
  await page.getByTestId("override-approver").fill("boss");
  await page.getByTestId("override-reason").fill("customer changed mind");
  for (const d of ["1", "2", "3", "4"])
    await page
      .getByRole("button", { name: `Digit ${d}` })
      .last()
      .click();
  await page.getByTestId("override-submit").click();
  await expect(page.getByTestId("override-error")).toContainText(
    "not available on this terminal yet",
  );
});

test("search by name adds the item", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("sell-search").fill("basm");
  await page.getByRole("button", { name: "Add Basmati Rice" }).click();
  await expect(page.getByText("$8.80").first()).toBeVisible();
});

test("cash sale: exact amount, change screen, receipt printed, new sale", async ({ page }) => {
  await signIn(page);
  await scan(page, TEA);
  await scan(page, RICE);
  // 5.00 + 8.00 = 13.00 + 10% = 14.30.
  await page.getByTestId("sell-pay").click();
  await expect(page.getByTestId("tender-due")).toContainText("$14.30");
  await page.getByTestId("tender-suggest-1").click(); // next note: 15.00
  await expect(page.getByTestId("tender-change")).toContainText("$0.70");
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as { __wbPrinterJobs?: unknown[] }).__wbPrinterJobs?.length ?? 0,
      ),
    )
    .toBe(1);
  await page.getByTestId("tender-new-sale").click();
  await expect(page.getByText("Cart is empty")).toBeVisible();
});

test("split: part cash, rest by card; a decline is not possible with the approving mock, so the rest completes", async ({
  page,
}) => {
  await signIn(page);
  await scan(page, TEA);
  await scan(page, RICE);
  await page.getByTestId("sell-pay").click();
  for (const k of ["5"])
    await page
      .getByRole("button", { name: `Digit ${k}` })
      .last()
      .click();
  await page.getByTestId("tender-cash").click();
  await expect(page.getByTestId("tender-due")).toContainText("$9.30");
  await page.getByTestId("tender-card").click();
  await expect(page.getByText("Paid in full")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("tender-new-sale").click();
});

test("shift: open with a float, sell, void inside the window, close with a matching count", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("till").click();
  await page.getByTestId("ops-float").fill("50.00");
  await page.getByTestId("ops-open").click();
  await expect(page.getByText("Shift open")).toBeVisible();
  await page.keyboard.press("Escape");

  await scan(page, TEA);
  await scan(page, RICE);
  await page.getByTestId("sell-pay").click();
  await page.getByTestId("tender-suggest-0").click(); // exact 14.30
  await page.getByTestId("tender-new-sale").click();

  await page.getByTestId("till").click();
  await page.getByTestId("ops-tabs").getByText("Sales").click();
  await page.getByTestId("ops-sale-1").click();
  await page.getByTestId("ops-reason").fill("customer left");
  await page.getByTestId("ops-void").click();
  await expect(page.getByText("Voided").first()).toBeVisible();

  await page.getByTestId("ops-tabs").getByText("Shift").click();
  await page.getByTestId("ops-counted").fill("50.00");
  await page.getByTestId("ops-close").click();
  await expect(page.getByTestId("ops-variance")).toContainText("Drawer matches");
});

test("shift: a short count is reported, and a return without permission asks for a supervisor", async ({
  page,
}) => {
  await signIn(page);
  await scan(page, TEA);
  await page.getByTestId("sell-pay").click();
  await page.getByTestId("tender-suggest-0").click();
  await page.getByTestId("tender-new-sale").click();

  await page.getByTestId("till").click();
  await page.getByTestId("ops-tabs").getByText("Sales").click();
  await page.getByTestId("ops-sale-1").click();
  await page.getByTestId("ops-plus-0").click();
  await page.getByTestId("ops-reason").fill("wrong item");
  await page.getByTestId("ops-return").click();
  await expect(page.getByTestId("override-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("override-sheet")).toBeHidden();
  if (!(await page.getByTestId("ops-tabs").isVisible())) await page.getByTestId("till").click();
  await page.getByTestId("ops-tabs").getByText("Shift").click();
  await page.getByTestId("ops-counted").fill("1.00");
  await page.getByTestId("ops-close").click();
  await expect(page.getByTestId("ops-variance")).toContainText("Short by");
});
