import { NextResponse } from "next/server";

import { buildCsp, generateNonce } from "./lib/csp.ts";

import type { NextRequest } from "next/server";

/**
 * Per-request CSP nonce (Next 16 `proxy`, Node runtime). The nonce reaches Server Components through the `x-nonce`
 * request header; Next applies it to its own scripts. Invite links carry a token in the URL, so those pages send no
 * Referer at all.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production" });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  if (request.nextUrl.pathname.startsWith("/invite")) {
    response.headers.set("referrer-policy", "no-referrer");
  }
  return response;
}

export const config = {
  // Pages only: API proxying (/v1), static assets and prefetches skip the nonce work.
  matcher: [
    {
      source: "/((?!v1/|_next/static|_next/image|favicon.ico|fonts/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
