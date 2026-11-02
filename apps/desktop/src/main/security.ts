import path from "node:path";

/** The one origin the terminal runs from. Everything else is an external site and is never loaded in a window. */
export const APP_ORIGIN = "app://pos";

export function buildCsp(o: { apiOrigin: string; dev?: boolean }): string {
  const connect = ["'self'", o.apiOrigin, ...(o.dev === true ? ["ws://localhost:*"] : [])];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    // react-native-web writes its rules into <style> tags at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Only the app origin may be navigated to. A product link or a typo in a note cannot take the till to a web page. */
export function isAllowedNavigation(url: string): boolean {
  try {
    // Custom schemes have an opaque origin ("null"), so compare scheme and host instead.
    const u = new URL(url);
    const app = new URL(APP_ORIGIN);
    return u.protocol === app.protocol && u.host === app.host;
  } catch {
    return false;
  }
}

/** IPC is answered only to the app's own frames (a frame that navigated away or an injected iframe gets nothing). */
export function isTrustedSender(frameUrl: string | undefined): boolean {
  return frameUrl !== undefined && isAllowedNavigation(frameUrl);
}

/**
 * Maps a request path under `app://pos/` to a file inside `root`, or undefined when it would leave `root`.
 * `/` maps to `index.html`; the caller falls back to it for extensionless routes (single-page routing).
 */
export function resolveAsset(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const rel = decoded.replace(/^\/+/, "");
  const target = path.resolve(root, rel === "" ? "index.html" : rel);
  const back = path.relative(root, target);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) return undefined;
  return target;
}

export const needsHtmlFallback = (pathname: string): boolean => path.extname(pathname) === "";
