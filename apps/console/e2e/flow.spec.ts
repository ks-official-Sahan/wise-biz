import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Owner journey against the real API: sign up, verify by email, create the business, finish onboarding,
 * invite a person, then read the audit log. Needs the compose stack (Postgres, Redis, Mailpit) and
 * `pnpm -F api dev` with MAIL_SMTP_HOST=127.0.0.1 MAIL_SMTP_PORT=1025. Opt in with E2E_FULL=1.
 */
test.skip(process.env.E2E_FULL !== "1", "Set E2E_FULL=1 with the API and compose stack running.");
test.describe.configure({ mode: "serial" });

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const run = Date.now().toString(36);
const owner = {
  name: "E2E Owner",
  email: `owner-${run}@example.test`,
  password: `e2e-${run}-Passw0rd!`,
};

/** Waits for the newest mail to `to` and returns the first link in its text body. */
async function mailLink(request: APIRequestContext, to: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT}/api/v1/search`, {
          params: { query: `to:"${to}"` },
        });
        const { messages } = (await search.json()) as { messages: { ID: string }[] };
        const id = messages[0]?.ID;
        if (id === undefined) return false;
        const msg = (await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
          Text: string;
        };
        link = /https?:\/\/\S+/.exec(msg.Text)?.[0];
        return link !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return link ?? "";
}

async function noAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

test("owner signs up, verifies and sets up the business", async ({ page, request }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill(owner.name);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await page.goto(await mailLink(request, owner.email));

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();
  await page.getByLabel("Business name").fill(`E2E Store ${run}`);
  await page.getByRole("button", { name: "Create business" }).click();

  // Onboarding: business, branch, invites (skipped), finish.
  await expect(page.getByRole("heading", { name: "Business" })).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "First branch" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Invite your team" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Finish" })).toBeVisible();
  await page.getByRole("button", { name: "Open the console" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Invite a person from People.
  await page.goto("/people");
  await page.getByRole("button", { name: "Invite a person" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await dialog.getByLabel("Email").fill(`staff-${run}@example.test`);
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`staff-${run}@example.test`)).toBeVisible();
  await noAxeViolations(page);

  // Every change above is in the audit log.
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.getByRole("row").nth(1)).toBeVisible();
  await noAxeViolations(page);
});
