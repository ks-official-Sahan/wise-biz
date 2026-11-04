// Static server for the Playwright suite. Serves dist/ with SPA fallback to index.html.
// Node built-ins only (no new dependency). Usage: node e2e/serve.mjs [port] [host]
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
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
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

// Every servable file is listed once at start-up (dist/ is built before this server runs). A request is answered only by
// looking its path up in this table, so a request can never name a file that is not in dist/.
const files = new Map();
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const full = join(entry.parentPath, entry.name);
  files.set("/" + relative(root, full).split(sep).join("/"), full);
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let requested;
  try {
    requested = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  } catch {
    res.writeHead(400).end();
    return;
  }
  // Unknown paths and extensionless routes fall back to the SPA shell. Missing asset files get a 404.
  const file =
    files.get(requested) ?? (extname(requested) === "" ? files.get("/index.html") : undefined);
  if (file === undefined) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    // expo-sqlite on web needs cross-origin isolation (SharedArrayBuffer).
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
  });
  res.end(req.method === "HEAD" ? undefined : body);
});

server.listen(port, host, () => {
  process.stdout.write(`POS e2e server on http://${host}:${port} (root ${root})\n`);
});
