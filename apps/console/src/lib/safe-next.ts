const BASE = "https://console.invalid";

/**
 * Returns a same-origin path to follow after sign-in, or "/". Rejects protocol-relative URLs and the backslash
 * and control-character tricks ("/\evil.com", "/\t/evil.com") that browsers resolve cross-origin.
 */
export function safeNext(raw: string | null): string {
  // eslint-disable-next-line no-control-regex
  if (
    raw === null ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(raw)
  ) {
    return "/";
  }
  const url = new URL(raw, BASE);
  return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : "/";
}
