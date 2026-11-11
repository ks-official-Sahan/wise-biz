import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/**
 * Support tickets against a mocked API (no database). The mock keeps a small in-memory state per test. The viewer is in
 * Colombo (UTC+5:30) and the clock is fixed, so due times and countdowns are exact.
 */

test.use({ timezoneId: "Asia/Colombo" });

// One test at a time: the mocked flows share one dev/prod server, and parallel browsers starve its page loads.
test.describe.configure({ mode: "serial" });

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-11-11T09:00:00Z";
const T_NEW_OPEN = uuid(701);
const T_PENDING = uuid(700);
const T_SOLVED = uuid(702);
const T_OLD_SOLVED = uuid(703);
const T_CREATED = uuid(799);
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
  key: string | undefined;
}

interface Message {
  id: string;
  authorKind: "tenant" | "platform";
  authorId: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

interface Ticket {
  id: string;
  subject: string;
  status: "open" | "pending" | "solved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  branchId: string | null;
  planCode: string;
  slaFirstResponseDueAt: string;
  slaResolutionDueAt: string;
  firstRespondedAt: string | null;
  solvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  diagnostics: {
    appVersion?: string;
    platform?: string;
    deviceId?: string;
    lastErrors: { message: string }[];
  };
  messages: Message[];
  messagesTruncated: boolean;
}

interface MockOptions {
  /** Tickets the mock starts with. */
  tickets?: Ticket[];
  /** Answer the list with an error. */
  listStatus?: number;
  /** Hold the list response, to see the loading state. */
  listDelayMs?: number;
  /** Refuse a reopen with the domain reason, as the API does past the window. */
  refuseReopen?: boolean;
}

const summaryOf = (t: Ticket): Partial<Ticket> => {
  const copy: Partial<Ticket> = { ...t };
  delete copy.messages;
  delete copy.diagnostics;
  delete copy.messagesTruncated;
  return copy;
};

/** The base set: an open ticket the platform has not answered, one it answered (pending), and a recent solve. */
function baseTickets(): Ticket[] {
  return [
    {
      id: T_NEW_OPEN,
      subject: "Scale not reading",
      status: "open",
      priority: "high",
      branchId: null,
      planCode: "pro",
      slaFirstResponseDueAt: "2026-11-11T16:00:00Z",
      slaResolutionDueAt: "2026-11-13T08:00:00Z",
      firstRespondedAt: null,
      solvedAt: null,
      createdAt: "2026-11-11T08:00:00Z",
      updatedAt: "2026-11-11T08:00:00Z",
      diagnostics: { lastErrors: [] },
      messages: [
        {
          id: uuid(801),
          authorKind: "tenant",
          authorId: "u1",
          body: "The scale shows zero for every item.",
          internal: false,
          createdAt: "2026-11-11T08:00:00Z",
        },
      ],
      messagesTruncated: false,
    },
    {
      id: T_PENDING,
      subject: "Till will not open",
      status: "pending",
      priority: "normal",
      branchId: null,
      planCode: "pro",
      slaFirstResponseDueAt: "2026-11-11T15:00:00Z",
      slaResolutionDueAt: "2026-11-13T07:00:00Z",
      firstRespondedAt: "2026-11-11T08:00:00Z",
      solvedAt: null,
      createdAt: "2026-11-11T07:00:00Z",
      updatedAt: "2026-11-11T08:00:00Z",
      diagnostics: {
        appVersion: "1.4.0",
        platform: "win32",
        deviceId: "0190a000-0000-7000-8000-0000000000aa",
        lastErrors: [{ message: "SECRET-ERROR-TEXT at C:\\Users\\till\\app.log" }],
      },
      messages: [
        {
          id: uuid(802),
          authorKind: "tenant",
          authorId: "u1",
          body: "The till will not open since this morning.",
          internal: false,
          createdAt: "2026-11-11T07:00:00Z",
        },
        {
          id: uuid(803),
          authorKind: "platform",
          authorId: "staff1",
          body: "Checking the logs now.",
          internal: false,
          createdAt: "2026-11-11T08:00:00Z",
        },
        {
          // The API never sends this to a tenant. The page must hide it even if it arrives.
          id: uuid(804),
          authorKind: "platform",
          authorId: "staff1",
          body: "INTERNAL-ONLY: suspect the payment driver",
          internal: true,
          createdAt: "2026-11-11T08:30:00Z",
        },
      ],
      messagesTruncated: false,
    },
    {
      id: T_SOLVED,
      subject: "Printer offline",
      status: "solved",
      priority: "low",
      branchId: null,
      planCode: "free",
      slaFirstResponseDueAt: "2026-11-06T09:00:00Z",
      slaResolutionDueAt: "2026-11-09T09:00:00Z",
      firstRespondedAt: "2026-11-04T10:00:00Z",
      solvedAt: "2026-11-05T09:00:00Z",
      createdAt: "2026-11-04T09:00:00Z",
      updatedAt: "2026-11-05T09:00:00Z",
      diagnostics: { lastErrors: [] },
      messages: [],
      messagesTruncated: false,
    },
  ];
}

const oldSolved = (): Ticket => ({
  id: T_OLD_SOLVED,
  subject: "Old label printing",
  status: "solved",
  priority: "low",
  branchId: null,
  planCode: "free",
  slaFirstResponseDueAt: "2026-10-20T09:00:00Z",
  slaResolutionDueAt: "2026-10-23T09:00:00Z",
  firstRespondedAt: "2026-10-19T10:00:00Z",
  solvedAt: "2026-10-20T09:00:00Z",
  createdAt: "2026-10-19T09:00:00Z",
  updatedAt: "2026-10-20T09:00:00Z",
  diagnostics: { lastErrors: [] },
  messages: [],
  messagesTruncated: false,
});

async function mockApi(page: Page, options: MockOptions = {}): Promise<Call[]> {
  const calls: Call[] = [];
  const tickets: Ticket[] = options.tickets ?? baseTickets();
  await page.clock.setFixedTime(new Date(NOW));

  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body: unknown =
      req.postData() === null ? undefined : JSON.parse(req.postData() ?? "null");
    calls.push({
      method: req.method(),
      path,
      query: url.search,
      body,
      key: req.headers()["idempotency-key"],
    });

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
        country: "LK",
        currency: "LKR",
        timezone: "Asia/Colombo",
        taxRegion: null,
        onboardedAt: "2026-10-01T00:00:00Z",
      });

    if (path === "/v1/support/tickets" && req.method() === "GET") {
      if (options.listDelayMs !== undefined)
        await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
      if (options.listStatus !== undefined)
        return json(options.listStatus, { status: options.listStatus, title: "Server error" });
      const status = url.searchParams.get("status");
      const after = url.searchParams.get("after");
      const filtered = status === null ? tickets : tickets.filter((t) => t.status === status);
      // Two per page, so the second page is reached with the cursor.
      const items = after === null ? filtered.slice(0, 2) : filtered.slice(2);
      const nextCursor = after === null && filtered.length > 2 ? "cursor-2" : null;
      return json(200, { items: items.map(summaryOf), nextCursor });
    }

    if (path === "/v1/support/tickets" && req.method() === "POST") {
      const b = body as { subject: string; priority: Ticket["priority"]; body: string };
      const created: Ticket = {
        id: T_CREATED,
        subject: b.subject,
        status: "open",
        priority: b.priority,
        branchId: null,
        planCode: "pro",
        slaFirstResponseDueAt: "2026-11-11T17:00:00Z",
        slaResolutionDueAt: "2026-11-13T09:00:00Z",
        firstRespondedAt: null,
        solvedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        diagnostics: { lastErrors: [] },
        messages: [
          {
            id: uuid(805),
            authorKind: "tenant",
            authorId: "u1",
            body: b.body,
            internal: false,
            createdAt: NOW,
          },
        ],
        messagesTruncated: false,
      };
      tickets.unshift(created);
      return json(201, created);
    }

    const one = /^\/v1\/support\/tickets\/([^/]+)(?:\/(messages|status))?$/.exec(path);
    if (one !== null) {
      const ticket = tickets.find((t) => t.id === one[1]);
      if (ticket === undefined) return json(404, { status: 404, title: "Not found" });
      if (one[2] === undefined && req.method() === "GET") return json(200, ticket);
      if (one[2] === "messages") {
        const b = body as { body: string };
        ticket.messages.push({
          id: uuid(810 + ticket.messages.length),
          authorKind: "tenant",
          authorId: "u1",
          body: b.body,
          internal: false,
          createdAt: NOW,
        });
        if (ticket.status !== "open") ticket.status = "open";
        ticket.updatedAt = NOW;
        return json(201, ticket.messages[ticket.messages.length - 1]);
      }
      if (one[2] === "status") {
        const b = body as { status: "open" | "solved" };
        if (options.refuseReopen === true && b.status === "open")
          return json(409, {
            status: 409,
            title: "Conflict",
            detail: "The reopen window has closed. Open a new ticket.",
          });
        ticket.status = b.status;
        if (b.status === "solved") ticket.solvedAt = NOW;
        ticket.updatedAt = NOW;
        return json(200, summaryOf(ticket));
      }
    }

    return json(404, { status: 404, title: "Not found" });
  });
  return calls;
}

const a11y = async (page: Page) => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
};

const noHorizontalScroll = async (page: Page) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
};

test("lists tickets, pages with the cursor and filters by status", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Support", level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: /Till will not open/ })).toContainText(
    "Awaiting your reply",
  );
  await expect(page.getByRole("row", { name: /Scale not reading/ })).toContainText("High");
  await a11y(page);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect.poll(() => calls.filter((c) => c.query.includes("after=cursor-2")).length).toBe(1);
  await expect(page.getByRole("row", { name: /Printer offline/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  await page.getByLabel("Status", { exact: true }).selectOption("solved");
  await expect.poll(() => calls.some((c) => c.query === "?limit=50&status=solved")).toBe(true);
  await expect(page.getByRole("row", { name: /Printer offline/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Scale not reading/ })).toHaveCount(0);
  await a11y(page);
});

test("shows the loading state while the list loads", async ({ page }) => {
  await mockApi(page, { listDelayMs: 1500 });
  await page.goto("/support");
  await expect(page.getByRole("status", { name: "Loading support tickets" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Till will not open/ })).toBeVisible();
});

test("shows the empty state", async ({ page }) => {
  await mockApi(page, { tickets: [] });
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "No tickets yet" })).toBeVisible();
  await a11y(page);
});

test("a failed list says so and offers a retry", async ({ page }) => {
  await mockApi(page, { listStatus: 500 });
  await page.goto("/support");
  await expect(page.getByText("Could not load this.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await a11y(page);
});

test("opens a ticket from the keyboard, validates, then opens the thread", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/support");
  const opener = page.getByRole("button", { name: "New ticket" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New support ticket" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Open ticket" }).click();
  await expect(dialog.getByText("Enter a short subject", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Describe what you need help with.")).toBeVisible();
  await a11y(page);

  await dialog.getByLabel("Subject", { exact: true }).fill("Scanner beeps");
  await dialog.getByLabel("Priority", { exact: true }).selectOption("urgent");
  await dialog.getByLabel("First message", { exact: true }).fill("It beeps on every item.");
  await dialog.getByRole("button", { name: "Open ticket" }).click();

  await expect.poll(() => calls.filter((c) => c.method === "POST").length).toBe(1);
  const post = calls.find((c) => c.method === "POST");
  expect(post?.path).toBe("/v1/support/tickets");
  expect(post?.body).toEqual({
    subject: "Scanner beeps",
    priority: "urgent",
    body: "It beeps on every item.",
  });
  expect(post?.key).toMatch(UUIDV7);
  await expect(page).toHaveURL(new RegExp(`/support/${T_CREATED}$`));
  await expect(page.getByRole("heading", { name: "Scanner beeps", level: 1 })).toBeVisible();
});

test("the thread hides internal notes and diagnostics, and shows the SLA in the viewer's zone", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`/support/${T_PENDING}`);
  await expect(page.getByRole("heading", { name: "Till will not open", level: 1 })).toBeVisible();
  await expect(page.getByText("Checking the logs now.")).toBeVisible();
  await expect(page.getByText("INTERNAL-ONLY")).toHaveCount(0);
  await expect(page.getByText("SECRET-ERROR-TEXT")).toHaveCount(0);
  await expect(page.getByText("0190a000-0000-7000-8000-0000000000aa")).toHaveCount(0);

  await expect(page.getByText("App version")).toBeVisible();
  await expect(page.getByText("1.4.0", { exact: true })).toBeVisible();
  await expect(page.getByText("win32", { exact: true })).toBeVisible();

  // Pending means the platform has answered, so the resolution clock runs: 2026-11-13 07:00 UTC.
  const sla = page.locator("p").filter({ hasText: "Resolution due:" });
  await expect(sla).toContainText("Nov 13, 2026");
  await expect(sla).toContainText(/12:30\s*PM/);
  await expect(sla).toContainText("GMT+5:30");
  await expect(sla).toContainText("Due in 1d 22h");
  await a11y(page);
});

test("a first-response clock counts down until the minute", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/support/${T_NEW_OPEN}`);
  const sla = page.locator("p").filter({ hasText: "First response due:" });
  await expect(sla).toContainText(/9:30\s*PM/);
  await expect(sla).toContainText("Due in 7h 0m");
});

test("replies, solves and reopens, with a fresh idempotency key for each request", async ({
  page,
}) => {
  const calls = await mockApi(page);
  await page.goto(`/support/${T_NEW_OPEN}`);
  await expect(page.getByRole("heading", { name: "Scale not reading", level: 1 })).toBeVisible();
  await expect(page.getByText("The scale shows zero for every item.")).toBeVisible();
  await a11y(page);

  const reply = page.getByLabel("Your reply", { exact: true });
  await reply.fill("Thanks, I will check the cable.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Thanks, I will check the cable.")).toBeVisible();
  await expect(reply).toHaveValue("");

  // The same text sent again is a new request, so it must not replay the first key.
  await reply.fill("Thanks, I will check the cable.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/messages")).length).toBe(2);
  const sent = calls.filter((c) => c.path.endsWith("/messages"));
  expect(sent[0]?.body).toEqual({ body: "Thanks, I will check the cable." });
  expect(sent[0]?.key).toMatch(UUIDV7);
  expect(sent[1]?.key).toMatch(UUIDV7);
  expect(sent[1]?.key).not.toBe(sent[0]?.key);

  await page.getByRole("button", { name: "Mark solved" }).click();
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/status")).length).toBe(1);
  const solve = calls.find((c) => c.path.endsWith("/status"));
  expect(solve?.body).toEqual({ status: "solved" });
  expect(solve?.key).toMatch(UUIDV7);
  await expect(page.getByText("Solved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark solved" })).toHaveCount(0);
  await expect(page.getByText("Replying reopens this ticket.")).toBeVisible();

  await page.getByRole("button", { name: "Reopen ticket" }).click();
  await expect.poll(() => calls.filter((c) => c.path.endsWith("/status")).length).toBe(2);
  expect(calls.filter((c) => c.path.endsWith("/status"))[1]?.body).toEqual({ status: "open" });
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await a11y(page);
});

test("a refused reopen shows the server's reason", async ({ page }) => {
  await mockApi(page, { refuseReopen: true });
  await page.goto(`/support/${T_SOLVED}`);
  await page.getByRole("button", { name: "Reopen ticket" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "reopen window" })).toContainText(
    "The reopen window has closed. Open a new ticket.",
  );
  await expect(page.getByRole("button", { name: "Reopen ticket" })).toBeVisible();
});

test("a ticket solved more than 14 days ago cannot be reopened or replied to", async ({ page }) => {
  await mockApi(page, { tickets: [...baseTickets(), oldSolved()] });
  await page.goto(`/support/${T_OLD_SOLVED}`);
  await expect(page.getByRole("heading", { name: "Old label printing", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen ticket" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Your reply" })).toHaveCount(0);
  await expect(page.getByText("solved more than 14 days ago", { exact: false })).toBeVisible();
  await a11y(page);
});

test("the list and a thread fit a phone without sideways scrolling", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/support");
  await expect(page.getByRole("row", { name: /Till will not open/ })).toBeVisible();
  await noHorizontalScroll(page);

  await page.goto(`/support/${T_PENDING}`);
  await expect(page.getByText("Checking the logs now.")).toBeVisible();
  await noHorizontalScroll(page);
});
