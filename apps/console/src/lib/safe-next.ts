const BASE = "https://console.invalid";
// Backslash and ASCII control characters: browsers resolve "/\evil.com" or "/\t/evil.com" cross-origin.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\\u0000-\u001f\u007f]/;

/**
 * Returns a same-origin path to follow after sign-in, or "/". Rejects protocol-relative URLs and the backslash
 * and control-character tricks that browsers resolve cross-origin.
 */
export function safeNext(raw: string | null): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//") || UNSAFE.test(raw)) return "/";
  const url = new URL(raw, BASE);
  return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : "/";
}
