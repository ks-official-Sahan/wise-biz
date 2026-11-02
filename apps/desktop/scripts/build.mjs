// Bundles the main process and the preload to CommonJS (Electron loads neither TypeScript nor a bare `.ts`), and copies
// the Expo web export next to them. WISE_BIZ_API_URL is the API origin the terminal may talk to (CSP connect-src).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { build } from "rolldown";

const root = path.resolve(import.meta.dirname, "..");
const apiUrl = process.env.WISE_BIZ_API_URL ?? "http://localhost:3000";
const apiOrigin = new URL(apiUrl).origin;
// A release talks to its API over TLS only; plain http is for a developer machine.
if (process.env.WISE_BIZ_RELEASE === "1" && !apiOrigin.startsWith("https://"))
  throw new Error("WISE_BIZ_RELEASE=1 needs WISE_BIZ_API_URL to be an https URL.");

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });

const common = {
  platform: "node",
  external: ["electron", "better-sqlite3", "serialport"],
  output: { format: "cjs", dir: path.join(root, "dist"), sourcemap: false },
};

await build({
  ...common,
  input: { main: path.join(root, "src/main/main.ts") },
  output: { ...common.output, entryFileNames: "[name].cjs" },
  transform: { define: { __API_ORIGIN__: JSON.stringify(apiOrigin) } },
});
// One bundle per preload, nothing shared: a sandboxed preload can require "electron" only, so a common chunk would not load.
for (const name of ["preload", "display-preload"]) {
  await build({
    ...common,
    input: { [name]: path.join(root, `src/preload/${name}.ts`) },
    output: { ...common.output, entryFileNames: "[name].cjs" },
  });
}

const web = process.env.WISE_BIZ_WEB_DIR ?? path.resolve(root, "../pos/dist");
const target = path.join(root, "renderer");
if (!fs.existsSync(path.join(web, "index.html"))) {
  console.warn(
    `No web export at ${web}; run the POS export first (pnpm -F @wise-biz/pos e2e:build or export:web).`,
  );
} else {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(web, target, { recursive: true });
}

// The customer display page is plain static files served from app://display/.
fs.rmSync(path.join(root, "display"), { recursive: true, force: true });
fs.cpSync(path.join(root, "src/customer-display"), path.join(root, "display"), { recursive: true });
