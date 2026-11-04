import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

interface Viewport {
  readonly width: number;
  readonly height: number;
}
// axe-core is a transitive dependency; derive its types from the builder instead of importing it.
type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type Result = AxeResults["violations"][number];

// Window global set by App.tsx on each theme or mode switch (control press to next commit).
declare global {
  interface Window {
    __wbThemeSwitchMs?: number;
  }
}

const PHONE: Viewport = { width: 390, height: 900 };
const TABLET: Viewport = { width: 834, height: 1112 };
const DESKTOP: Viewport = { width: 1440, height: 900 };
const SWITCH_BUDGET_MS = 100;
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS: readonly (string | null | undefined)[] = ["serious", "critical"];

interface GalleryCase {
  /** Screenshot and test name stem. */
  readonly id: string;
  readonly query: string;
  readonly viewport: Viewport;
}

const WIDTHS: readonly Viewport[] = [PHONE, TABLET, DESKTOP];

/** Platform light and dark sell screens plus the components view, at every width. */
const PLATFORM_CASES: readonly GalleryCase[] = WIDTHS.flatMap((viewport) => [
  { id: "sell-platform-light", query: "theme=platform&mode=light&view=sell", viewport },
  { id: "sell-platform-dark", query: "theme=platform&mode=dark&view=sell", viewport },
  { id: "components-platform-light", query: "theme=platform&mode=light&view=components", viewport },
]);

/** Dark-only tenant theme: sell screen at tablet width only. */
const LANKA_CASE: GalleryCase = {
  id: "sell-lanka-hardware-dark",
  query: "theme=lanka-hardware&mode=dark&view=sell",
  viewport: TABLET,
};

const VISUAL_CASES: readonly GalleryCase[] = [...PLATFORM_CASES, LANKA_CASE];

function caseTitle(gallery: GalleryCase): string {
  return `${gallery.id} at ${String(gallery.viewport.width)}px`;
}

/** Sets the viewport, loads the gallery from its URL state, and waits for the fonts and the header. */
async function openGallery(page: Page, query: string, viewport: Viewport): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await expect(page.getByText("wise-biz UI gallery", { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function resetSwitchMs(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete window.__wbThemeSwitchMs;
  });
}

async function readSwitchMs(page: Page): Promise<number> {
  await page.waitForFunction(() => typeof window.__wbThemeSwitchMs === "number");
  return page.evaluate(() => window.__wbThemeSwitchMs ?? Number.NaN);
}

function formatBlocking(violations: readonly Result[]): string {
  if (violations.length === 0) return "no serious or critical violations";
  return violations
    .map((violation) => {
      const nodes = violation.nodes.map(
        (node) => `    ${node.target.join(" ")} :: ${node.failureSummary?.split("\n")[0] ?? ""}`,
      );
      return `[${violation.id}] impact=${String(violation.impact)} ${violation.help}\n${nodes.join("\n")}`;
    })
    .join("\n");
}

async function blockingViolations(page: Page): Promise<Result[]> {
  const results: AxeResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.filter((violation) => BLOCKING_IMPACTS.includes(violation.impact));
}

test.describe("visual baselines", () => {
  for (const gallery of VISUAL_CASES) {
    test(`screenshot: ${caseTitle(gallery)}`, async ({ page }) => {
      await openGallery(page, gallery.query, gallery.viewport);
      await expect(page).toHaveScreenshot(`${gallery.id}-w${String(gallery.viewport.width)}.png`, {
        fullPage: true,
      });
    });
  }
});

/**
 * Real app bugs found by axe, marked test.fail() so the suite stays green until they are fixed.
 * When a fix lands the test reports "passed unexpectedly": delete its entry here.
 */
const KNOWN_AXE_BUGS: Readonly<Record<string, string>> = {};

test.describe("accessibility (WCAG 2.2 AA, serious and critical)", () => {
  for (const gallery of VISUAL_CASES) {
    test(`axe: ${caseTitle(gallery)}`, async ({ page }) => {
      const knownBug = KNOWN_AXE_BUGS[gallery.id];
      if (knownBug !== undefined) test.fail(true, knownBug);
      await openGallery(page, gallery.query, gallery.viewport);
      const blocking = await blockingViolations(page);
      expect(blocking, formatBlocking(blocking)).toEqual([]);
    });
  }
});

test.describe("theme and mode switching", () => {
  test("Kade Cafe chip then Dark mode toggle each commit in under 100 ms", async ({ page }) => {
    await openGallery(page, "theme=platform&mode=light&view=components", DESKTOP);

    await resetSwitchMs(page);
    await page.getByRole("radio", { name: "Kade Cafe" }).click();
    const themeMs = await readSwitchMs(page);

    await resetSwitchMs(page);
    await page.getByRole("switch", { name: "Dark mode" }).click();
    const modeMs = await readSwitchMs(page);

    expect(themeMs, "theme chip switch (ms)").toBeLessThan(SWITCH_BUDGET_MS);
    expect(modeMs, "mode toggle switch (ms)").toBeLessThan(SWITCH_BUDGET_MS);
  });

  test("theme chip updates the URL so the state can be deep-linked", async ({ page }) => {
    await openGallery(page, "theme=platform&mode=light&view=components", DESKTOP);
    await page.getByRole("radio", { name: "Lanka Hardware" }).click();
    await expect(page).toHaveURL(/theme=lanka-hardware/);
    await expect(page.getByRole("radio", { name: "Lanka Hardware" })).toBeChecked();
  });

  test("Dark mode toggle is hidden for a single-mode theme", async ({ page }) => {
    await openGallery(page, "theme=nila-pharmacy&mode=light&view=components", DESKTOP);
    await expect(page.getByRole("radio", { name: "Nila Pharmacy" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Dark mode" })).toHaveCount(0);
  });
});

test.describe("keyboard", () => {
  test("Tab reaches the first Button and its focus ring is visible", async ({ page }) => {
    await openGallery(page, "theme=platform&mode=light&view=components", DESKTOP);

    const firstButton = page.getByRole("button").first();
    // Tab order follows DOM order here, so the first button in the DOM is the first Tab stop that is a button.
    for (let press = 0; press < 80; press += 1) {
      await page.keyboard.press("Tab");
      if (await firstButton.evaluate((element) => element === document.activeElement)) break;
    }
    await expect(firstButton).toBeFocused();

    const ring = await firstButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(ring.outlineStyle, "computed outline-style on focused button").not.toBe("none");
    expect(
      Number.parseFloat(ring.outlineWidth),
      "computed outline-width on focused button",
    ).toBeGreaterThan(0);
  });
});

test.describe("console", () => {
  for (const view of ["components", "sell"] as const) {
    test(`${view} view loads without console errors or page errors`, async ({ page }) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
      });
      await openGallery(page, `theme=platform&mode=light&view=${view}`, DESKTOP);
      await page.waitForLoadState("networkidle");
      expect(problems).toEqual([]);
    });
  }
});
