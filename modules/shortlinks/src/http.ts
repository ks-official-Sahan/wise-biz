import { normalizeReceiptCode, renderHtml } from "@wise-biz/receipt";

import { ReceiptSnapshot, toReceiptDoc } from "./snapshot.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type pg from "pg";

/**
 * The public receipt page is served to anyone with the link: no store-side data, no tenant, not indexed. The CSP
 * allows only inline styles (the renderer's CSS); no scripts, no images, no frames.
 */
export const PAGE_HEADERS = {
  "Cache-Control": "private, max-age=300",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
} as const;

/** One body for every miss (unknown or malformed code), so the response is no oracle for code existence. */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Receipt not found</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;background:#f4f4f4;color:#111}main{max-width:380px;margin:16px auto;background:#fff;padding:20px;border-radius:8px;text-align:center}</style></head>
<body><main><h1>Receipt not found</h1><p>Check the link and try again.</p></main></body></html>`;

/**
 * Public lookup through the SECURITY DEFINER function: there is no tenant on this request, and wb_app has no table
 * privilege. Returns undefined for an unknown code.
 */
export async function findReceipt(
  pool: pg.Pool,
  code: string,
): Promise<ReceiptSnapshot | undefined> {
  const r = await pool.query<{ snapshot: unknown }>(
    "select shortlinks.receipt_by_code($1) as snapshot",
    [code],
  );
  const raw = r.rows[0]?.snapshot;
  return raw === null || raw === undefined ? undefined : ReceiptSnapshot.parse(raw);
}

/** GET /r/:code: no auth, no tenant. Malformed codes never reach the database. */
export function mountReceiptPage(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  app.get("/r/:code", async (c) => {
    const code = normalizeReceiptCode(c.req.param("code"));
    const snapshot = code === undefined ? undefined : await findReceipt(deps.pool, code);
    if (snapshot === undefined) return c.html(NOT_FOUND_HTML, 404, PAGE_HEADERS);
    return c.html(renderHtml(toReceiptDoc(snapshot), { timeZone: "UTC" }), 200, PAGE_HEADERS);
  });
}
