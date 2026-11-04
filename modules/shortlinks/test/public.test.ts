import { OpenAPIHono } from "@hono/zod-openapi";
import { receiptCode } from "@wise-biz/receipt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyReceiptLink, shortlinksModule } from "../src/index.ts";

import { clock, ids, inTenantTx, saleEvent, setup } from "./helpers.ts";

import type { Fixture } from "./helpers.ts";
import type { AppEnv } from "@wise-biz/module-kit";

const T = "0192f8c6-0000-7000-8000-00000000000a";
const SALE = "0192f8c6-0000-7000-8000-000000000101";
const XSS_SALE = "0192f8c6-0000-7000-8000-000000000102";

let fx: Fixture;
let app: OpenAPIHono<AppEnv>;
let code: string;

beforeAll(async () => {
  fx = await setup();
  await inTenantTx(fx.worker, T, (c) => applyReceiptLink(c, saleEvent(T, SALE)));
  await inTenantTx(fx.worker, T, (c) =>
    applyReceiptLink(c, saleEvent(T, XSS_SALE, { sku: "<script>alert(1)</script>" })),
  );
  code = receiptCode(SALE);
  app = new OpenAPIHono<AppEnv>();
  shortlinksModule.routes(app, { pool: fx.pool, clock, ids });
});
afterAll(async () => {
  await fx.drop();
});

describe("GET /r/:code", () => {
  it("serves the receipt to anyone (no auth, no tenant) with the public headers", async () => {
    const res = await app.request(`/r/${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    const body = await res.text();
    expect(body).toContain("INV-000123");
    expect(body).toContain("Cash");
    expect(body).not.toContain("customerId");
  });

  it("accepts a lower-case code (scanners and people)", async () => {
    expect((await app.request(`/r/${code.toLowerCase()}`)).status).toBe(200);
  });

  it("an unknown code and a malformed code both get the same 404 (no oracle)", async () => {
    const unknown = await app.request("/r/ZZZZZZZZZZ");
    const malformed = await app.request("/r/bad");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    const a = await unknown.text();
    const b = await malformed.text();
    expect(a).toBe(b);
    expect(a).toContain("Receipt not found");
    expect(malformed.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });

  it("escapes a hostile SKU: no raw script tag reaches the page", async () => {
    const res = await app.request(`/r/${receiptCode(XSS_SALE)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
