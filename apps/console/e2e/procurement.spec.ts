import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { Page, Route } from "@playwright/test";

/** Purchasing and transfers against a mocked API (no database). The mock keeps a small in-memory state per test. */

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const BRANCH = uuid(10);
const FLOOR = uuid(20);
const BACK = uuid(21);
const SUP = uuid(30);
const V1 = uuid(401);
const V2 = uuid(402);
const PO_ID = uuid(500);
const TRANSFER_ID = uuid(600);

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

interface PoLine {
  line: number;
  variantId: string;
  orderedQty: string;
  receivedQty: string;
  shortQty: string;
  unitCostMinor: number;
  lineTotalMinor: number;
}

interface PurchaseOrder {
  id: string;
  poNo: number;
  supplierId: string;
  branchId: string;
  locationId: string;
  currency: string;
  status: "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled";
  expectedOn: string | null;
  notes: string;
  totalMinor: number;
  version: number;
  sentAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PoLine[];
}

interface TransferLine {
  line: number;
  variantId: string;
  requestedQty: string;
  dispatchedQty: string;
  receivedQty: string;
  varianceQty: string;
  valueMinor: number;
}

interface Transfer {
  id: string;
  transferNo: number;
  fromLocationId: string;
  toLocationId: string;
  status: "requested" | "dispatched" | "received" | "closed" | "cancelled";
  notes: string;
  currency: string | null;
  inTransitQty: string;
  inTransitValueMinor: number;
  version: number;
  dispatchedAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: TransferLine[];
}

async function mockApi(page: Page): Promise<Call[]> {
  const calls: Call[] = [];
  // One sent order (10 Green Tea at 2.50, 6 Milk at 3.00) and one requested transfer from the floor to the backroom.
  const pos: PurchaseOrder[] = [
    {
      id: PO_ID,
      poNo: 1,
      supplierId: SUP,
      branchId: BRANCH,
      locationId: FLOOR,
      currency: "USD",
      status: "sent",
      expectedOn: null,
      notes: "",
      totalMinor: 4300,
      version: 1,
      sentAt: "2026-11-05T09:00:00Z",
      closedAt: null,
      cancelledAt: null,
      createdAt: "2026-11-04T09:00:00Z",
      updatedAt: "2026-11-05T09:00:00Z",
      lines: [
        {
          line: 1,
          variantId: V1,
          orderedQty: "10",
          receivedQty: "0",
          shortQty: "0",
          unitCostMinor: 250,
          lineTotalMinor: 2500,
        },
        {
          line: 2,
          variantId: V2,
          orderedQty: "6",
          receivedQty: "0",
          shortQty: "0",
          unitCostMinor: 300,
          lineTotalMinor: 1800,
        },
      ],
    },
  ];
  const transfers: Transfer[] = [
    {
      id: TRANSFER_ID,
      transferNo: 1,
      fromLocationId: FLOOR,
      toLocationId: BACK,
      status: "requested",
      notes: "",
      currency: null,
      inTransitQty: "0",
      inTransitValueMinor: 0,
      version: 1,
      dispatchedAt: null,
      receivedAt: null,
      closedAt: null,
      cancelledAt: null,
      createdAt: "2026-11-10T09:00:00Z",
      updatedAt: "2026-11-10T09:00:00Z",
      lines: [
        {
          line: 1,
          variantId: V1,
          requestedQty: "5",
          dispatchedQty: "0",
          receivedQty: "0",
          varianceQty: "0",
          valueMinor: 0,
        },
      ],
    },
  ];
  const supplier = {
    id: SUP,
    name: "Tea Co",
    contactName: "",
    email: "",
    phone: "",
    address: "",
    paymentTermsDays: 30,
    leadTimeDays: 7,
    currency: "USD",
    archivedAt: null,
    version: 1,
    updatedAt: "2026-11-01T00:00:00Z",
  };

  await page.route("**/v1/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body: unknown =
      req.postData() === null ? undefined : JSON.parse(req.postData() ?? "null");
    if (req.method() !== "GET")
      calls.push({ method: req.method(), path, body, key: req.headers()["idempotency-key"] });

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
    if (path === "/v1/tenancy/branches")
      return json(200, {
        branches: [
          {
            branchId: BRANCH,
            name: "Main street",
            kind: "store",
            timezone: "UTC",
            currency: "USD",
            taxRegion: "us",
            businessDayCutoff: "04:00",
            archived: false,
          },
        ],
      });
    if (path === `/v1/tenancy/branches/${BRANCH}/locations`)
      return json(200, {
        locations: [
          {
            locationId: FLOOR,
            branchId: BRANCH,
            name: "Shop floor",
            kind: "sales_floor",
            archived: false,
          },
          {
            locationId: BACK,
            branchId: BRANCH,
            name: "Backroom",
            kind: "backroom",
            archived: false,
          },
        ],
      });
    if (path === "/v1/catalog/variants")
      return json(200, {
        variants: [
          { id: V1, productId: uuid(1), sku: "TEA-1", name: "Box", productName: "Green Tea" },
          { id: V2, productId: uuid(2), sku: "MILK-1", name: "1L", productName: "Milk" },
        ],
      });
    if (path === "/v1/procurement/suppliers")
      return json(200, { items: [supplier], nextCursor: null });

    if (path === "/v1/procurement/purchase-orders" && req.method() === "GET")
      return json(200, { items: [...pos].reverse(), nextCursor: null });
    const poMatch = /^\/v1\/procurement\/purchase-orders\/([^/]+)(?:\/(receive))?$/.exec(path);
    if (poMatch !== null) {
      const po = pos.find((p) => p.id === poMatch[1]);
      if (po === undefined) return json(404, { status: 404, title: "Not found" });
      if (poMatch[2] === undefined) return json(200, po);
      if (poMatch[2] === "receive") {
        const b = body as { lines: { line: number; qty: string }[] };
        for (const r of b.lines) {
          const line = po.lines.find((l) => l.line === r.line);
          if (line !== undefined) line.receivedQty = r.qty;
        }
        const full = po.lines.every((l) => Number(l.receivedQty) >= Number(l.orderedQty));
        po.status = full ? "received" : "partially_received";
        po.version += 1;
        return json(201, {
          receipt: { id: uuid(900), reference: "", receivedAt: "2026-11-10T10:00:00Z", lines: [] },
          purchaseOrder: po,
        });
      }
    }

    if (path === "/v1/procurement/transfers" && req.method() === "GET")
      return json(200, { items: [...transfers].reverse(), nextCursor: null });
    const trMatch = /^\/v1\/procurement\/transfers\/([^/]+)(?:\/(dispatch|receive))?$/.exec(path);
    if (trMatch !== null) {
      const t = transfers.find((x) => x.id === trMatch[1]);
      if (t === undefined) return json(404, { status: 404, title: "Not found" });
      if (trMatch[2] === undefined) return json(200, t);
      if (trMatch[2] === "dispatch") {
        const b = body as { lines: { line: number; qty: string }[] };
        for (const d of b.lines) {
          const line = t.lines.find((l) => l.line === d.line);
          if (line !== undefined) line.dispatchedQty = d.qty;
        }
        t.status = "dispatched";
        t.currency = "USD";
        t.inTransitQty = "5";
        t.inTransitValueMinor = 1250;
        t.lines.forEach((l) => {
          l.valueMinor = 1250;
        });
        t.version += 1;
        return json(200, t);
      }
      if (trMatch[2] === "receive") {
        const b = body as { lines: { line: number; receivedQty: string }[] };
        for (const r of b.lines) {
          const line = t.lines.find((l) => l.line === r.line);
          if (line !== undefined) {
            line.receivedQty = r.receivedQty;
            line.varianceQty = String(Number(r.receivedQty) - Number(line.dispatchedQty));
          }
        }
        t.status = "received";
        t.inTransitQty = "0";
        t.inTransitValueMinor = 0;
        t.version += 1;
        return json(200, t);
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

test("lists purchase orders, receives part of one per line and shows the new status", async ({
  page,
}) => {
  const calls = await mockApi(page);
  await page.goto("/purchasing");
  await expect(page.getByRole("heading", { name: "Purchasing", level: 1 })).toBeVisible();
  const listed = page.getByRole("row", { name: /PO 1/ });
  await expect(listed).toContainText("Tea Co");
  await expect(listed.getByText("Sent", { exact: true })).toBeVisible();
  await expect(listed).toContainText("$43.00");
  await a11y(page);

  await page.getByRole("link", { name: "PO 1", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/purchasing/${PO_ID}$`));
  await expect(page.getByRole("heading", { name: "PO 1", level: 1 })).toBeVisible();
  await expect(page.getByText("Tea Co · Shop floor")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Green Tea · Box" })).toBeVisible();
  await a11y(page);

  await page.getByRole("button", { name: "Receive goods" }).click();
  const receive = page.getByRole("dialog", { name: "Receive against PO 1" });
  const tea = receive.getByRole("group", { name: "Green Tea · Box" });
  const milk = receive.getByRole("group", { name: "Milk · 1L" });
  await expect(tea.getByText("Ordered 10, received 0, open 10")).toBeVisible();
  await expect(milk.getByText("Ordered 6, received 0, open 6")).toBeVisible();

  // A zero on a line is explained and nothing is sent.
  await tea.getByLabel("Quantity received now").fill("0");
  await receive.getByRole("button", { name: "Record receipt" }).click();
  await expect(
    receive.getByText("Enter a quantity above zero, like 12 or 2.5 (up to 4 decimals)."),
  ).toBeVisible();
  expect(calls.filter((c) => c.path.endsWith("/receive"))).toHaveLength(0);

  // Four of the ten Green Tea arrive; the Milk line is left blank and so left out.
  await tea.getByLabel("Quantity received now").fill("4");
  await a11y(page);
  await receive.getByRole("button", { name: "Record receipt" }).click();

  await expect.poll(() => calls.filter((c) => c.path.endsWith("/receive")).length).toBe(1);
  const call = calls.find((c) => c.path.endsWith("/receive"));
  expect(call?.body).toEqual({ lines: [{ line: 1, qty: "4" }] });
  expect(call?.key).toMatch(/^[0-9a-f-]{36}$/);

  await expect(receive).toBeHidden();
  await expect(page.getByText("Partly received", { exact: true })).toBeVisible();
  const teaRow = page.getByRole("row", { name: /Green Tea/ });
  await expect(teaRow.getByRole("cell", { name: "4", exact: true })).toBeVisible();
  await expect(teaRow.getByRole("cell", { name: "6", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Receive goods" })).toBeVisible();
  await a11y(page);

  await page.getByRole("link", { name: "All orders", exact: true }).click();
  await expect(
    page.getByRole("row", { name: /PO 1/ }).getByText("Partly received", { exact: true }),
  ).toBeVisible();
  await a11y(page);
});

test("requests stock to move, dispatches it, receives a short delivery and shows the shortage", async ({
  page,
}) => {
  const calls = await mockApi(page);
  await page.goto("/transfers");
  await expect(page.getByRole("heading", { name: "Transfers", level: 1 })).toBeVisible();
  const listed = page.getByRole("row", { name: /Transfer 1/ });
  await expect(listed).toContainText("Main street · Shop floor");
  await expect(listed).toContainText("Main street · Backroom");
  await expect(listed.getByText("Requested", { exact: true })).toBeVisible();
  await expect(listed).toContainText("Nothing in transit");
  await a11y(page);

  await page.getByRole("link", { name: "Transfer 1", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/transfers/${TRANSFER_ID}$`));
  await expect(page.getByRole("heading", { name: "Transfer 1", level: 1 })).toBeVisible();
  await expect(page.getByText("Main street · Shop floor to Main street · Backroom")).toBeVisible();
  await a11y(page);

  await page.getByRole("button", { name: "Dispatch stock" }).click();
  const dispatch = page.getByRole("dialog", { name: "Dispatch transfer 1" });
  const dispatchTea = dispatch.getByRole("group", { name: "Green Tea · Box" });
  await expect(dispatchTea.getByLabel("Quantity to dispatch")).toHaveValue("5");
  await a11y(page);
  await dispatch.getByRole("button", { name: "Dispatch stock" }).click();

  await expect.poll(() => calls.filter((c) => c.path.endsWith("/dispatch")).length).toBe(1);
  expect(calls.find((c) => c.path.endsWith("/dispatch"))?.body).toEqual({
    version: 1,
    lines: [{ line: 1, qty: "5" }],
  });
  await expect(dispatch).toBeHidden();
  await expect(page.getByText("5 in transit, $12.50")).toBeVisible();

  await page.getByRole("button", { name: "Receive stock" }).click();
  const receive = page.getByRole("dialog", { name: "Receive transfer 1" });
  const receiveTea = receive.getByRole("group", { name: "Green Tea · Box" });
  await receiveTea.getByLabel("Quantity received").fill("4");
  await expect(receiveTea.getByText("Short by 1", { exact: false })).toBeVisible();
  await a11y(page);
  await receive.getByRole("button", { name: "Record receipt" }).click();

  await expect.poll(() => calls.filter((c) => c.path.endsWith("/receive")).length).toBe(1);
  expect(calls.find((c) => c.path.endsWith("/receive"))?.body).toEqual({
    version: 2,
    lines: [{ line: 1, receivedQty: "4" }],
  });
  await expect(receive).toBeHidden();
  await expect(page.getByRole("cell", { name: "Short by 1", exact: true })).toBeVisible();
  await expect(page.getByText("Nothing in transit")).toBeVisible();
  await a11y(page);
});
