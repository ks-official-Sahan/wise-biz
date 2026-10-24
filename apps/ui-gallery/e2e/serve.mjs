// Static server for the Playwright suite. Serves dist/ with SPA fallback to index.html.
// Node built-ins only (no new dependency). Usage: node e2e/serve.mjs [port] [host]
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const port = Number(process.argv[2] ?? 4173);
const host = process.argv[3] ?? "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Resolves a request path inside root. Returns null for anything that escapes it. */
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const target = normalize(join(root, decoded));
  return target === root || target.startsWith(root + sep) ? target : null;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const target = safePath(req.url ?? "/");
  if (target === null) {
    res.writeHead(403).end();
    return;
  }
  // Unknown paths and extensionless routes fall back to the SPA shell. Missing asset files get a 404.
  const hasExtension = extname(target) !== "";
  const file = (await isFile(target)) ? target : hasExtension ? null : join(root, "index.html");
  if (file === null) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : body);
});

server.listen(port, host, () => {
  process.stdout.write(`ui-gallery e2e server on http://${host}:${port} (root ${root})\n`);
});
