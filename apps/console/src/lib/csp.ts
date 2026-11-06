/**
 * Strict nonce-based CSP for the console (security.md "Web security"). Scripts load only with the per-request nonce
 * (`strict-dynamic` lets Next's own chunks load); styles likewise. The API is same-origin (proxied under /v1), so
 * connect-src stays 'self' plus, when set, the object-store origin for presigned uploads. Dev adds 'unsafe-eval' for React Refresh only.
 */
export function buildCsp(
  nonce: string,
  opts: {
    dev: boolean;
    /** Object-store origin that file uploads (imports, product images) go to with a presigned URL. */ uploadOrigin?: string;
    /** Where browser error reports go (the Sentry ingest origin from the DSN; see sentryOrigin). */
    reportOrigin?: string;
  },
): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(opts.dev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": [
      "'self'",
      ...(opts.dev ? ["ws:"] : []),
      ...(opts.uploadOrigin === undefined ? [] : [opts.uploadOrigin]),
      ...(opts.reportOrigin === undefined ? [] : [opts.reportOrigin]),
    ],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!opts.dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** 128-bit random nonce, base64 (Web Crypto: works in the Node and Edge runtimes). */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Static security headers (set in next.config headers()). The CSP is per request (proxy.ts). */
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

/**
 * The object-store origin for presigned uploads, from CONSOLE_UPLOAD_ORIGIN: a bare https origin (http only in dev).
 * Anything else (a path, a wildcard, another scheme, a typo) is ignored, so a bad value can never widen connect-src.
 */
export function parseUploadOrigin(value: string | undefined, dev: boolean): string | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const u = new URL(value);
    const schemeOk = u.protocol === "https:" || (dev && u.protocol === "http:");
    if (!schemeOk || u.username !== "" || u.password !== "" || u.hostname.includes("*"))
      return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}
