import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, app, ipcMain, net, protocol, safeStorage, session } from "electron";

import { registerIpc } from "./ipc.ts";
import {
  APP_ORIGIN,
  buildCsp,
  isAllowedNavigation,
  needsHtmlFallback,
  resolveAsset,
} from "./security.ts";
import { createStorageService } from "./storage.ts";
import { createVaultStore } from "./vault.ts";
import { createMainWindow } from "./window.ts";

import type { Driver } from "./storage.ts";

// Replaced at build time (scripts/build.mjs). The renderer bundle talks to this API origin and no other.
declare const __API_ORIGIN__: string;

const dev = !app.isPackaged;
// Test hooks exist only in unpackaged builds: a shipped terminal ignores them.
const e2e = dev && process.env.WISE_BIZ_E2E === "1";

if (e2e && process.env.WISE_BIZ_USER_DATA !== undefined)
  app.setPath("userData", process.env.WISE_BIZ_USER_DATA);

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function openDriver(file: string): Driver {
  // The bundle is CommonJS and better-sqlite3 is a native addon that stays external.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as new (f: string) => Driver;
  return new Database(file);
}

function atomicWrite(file: string, data: Uint8Array): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const strong = async (): Promise<boolean> => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  // Linux without a keyring falls back to a hard-coded password: that is not protection.
  if (process.platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend();
    return backend !== "basic_text" && backend !== "unknown";
  }
  return true;
};

function rendererRoot(): string {
  return path.join(app.getAppPath(), "renderer");
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (!isAllowedNavigation(event.url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

if (gotLock)
  app
    .whenReady()
    .then(() => {
      const csp = buildCsp({ apiOrigin: __API_ORIGIN__, dev });
      const root = rendererRoot();

      protocol.handle("app", async (request) => {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        const url = new URL(request.url);
        if (url.host !== "pos") return new Response("Not found", { status: 404 });
        let file = resolveAsset(root, url.pathname);
        if (file === undefined) return new Response("Bad request", { status: 400 });
        if (!fs.existsSync(file) && needsHtmlFallback(url.pathname))
          file = path.join(root, "index.html");
        if (!fs.existsSync(file)) return new Response("Not found", { status: 404 });
        const res = await net.fetch(pathToFileURL(file).toString());
        const headers = new Headers();
        for (const h of ["content-type", "content-length", "last-modified", "etag"]) {
          const v = res.headers.get(h);
          if (v !== null) headers.set(h, v);
        }
        headers.set("Content-Security-Policy", csp);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        return new Response(res.body, { status: res.status, headers });
      });

      // No camera, microphone, geolocation, notifications or device pickers: hardware goes through the main process.
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
        callback(false);
      });
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.setDevicePermissionHandler(() => false);

      const userData = app.getPath("userData");
      fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
      const storage = createStorageService({
        dir: userData,
        open: openDriver,
        join: (dir, name) => path.join(dir, name),
      });
      const vault = createVaultStore({
        file: path.join(userData, "identity.bin"),
        safe: {
          isStrong: strong,
          encryptString: (s) => safeStorage.encryptStringAsync(s),
          decryptString: async (b) => (await safeStorage.decryptStringAsync(Buffer.from(b))).result,
        },
        files: {
          read: (f) => (fs.existsSync(f) ? fs.readFileSync(f) : undefined),
          write: atomicWrite,
          remove: (f) => {
            fs.rmSync(f, { force: true });
          },
        },
      });
      registerIpc(
        {
          handle: (channel, listener) => {
            ipcMain.handle(channel, listener);
          },
        },
        { storage, vault },
      );
      app.on("before-quit", () => {
        storage.close();
      });

      createMainWindow({ url: `${APP_ORIGIN}/`, preload: path.join(__dirname, "preload.cjs") });
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : "The app failed to start.");
      app.exit(1);
    });

app.on("second-instance", () => {
  const [w] = BrowserWindow.getAllWindows();
  if (w !== undefined) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
