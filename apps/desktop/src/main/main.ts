import fs from "node:fs";
import tcp from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  net,
  protocol,
  safeStorage,
  screen,
  session,
} from "electron";
import { autoUpdater } from "electron-updater";

import { DISPLAY_PUSH } from "../shared/channels.ts";

import { createDisplayController } from "./display.ts";
import { createHardwareService, parseHardwareConfig } from "./hardware.ts";
import { registerIpc } from "./ipc.ts";
import { createKeyring } from "./keyring.ts";
import { createKiosk, isBlockedKioskKey, parseKioskRecord } from "./kiosk.ts";
import {
  APP_ORIGIN,
  buildCsp,
  forbiddenSwitches,
  isAllowedNavigation,
  needsHtmlFallback,
  resolveAsset,
} from "./security.ts";
import { createStorageService } from "./storage.ts";
import { startUpdater } from "./updater.ts";
import { createVaultStore } from "./vault.ts";
import { createDisplayWindow, createMainWindow } from "./window.ts";

import type { SerialLike } from "./hardware.ts";
import type { Driver } from "./storage.ts";
import type { DisplayState } from "../shared/channels.ts";

// Replaced at build time (scripts/build.mjs). The renderer bundle talks to this API origin and no other.
declare const __API_ORIGIN__: string;

const dev = !app.isPackaged;
// Test hooks exist only in unpackaged builds: a shipped terminal ignores them.
const e2e = dev && process.env.WISE_BIZ_E2E === "1";

if (e2e && process.env.WISE_BIZ_USER_DATA !== undefined)
  app.setPath("userData", process.env.WISE_BIZ_USER_DATA);

// A packaged terminal refuses debugging and sandbox-weakening switches (see forbiddenSwitches) before anything else runs.
if (!dev) {
  const refused = forbiddenSwitches(process.argv.slice(1));
  if (refused.length > 0) {
    process.stderr.write(`Refusing to start with ${refused.join(", ")}
`);
    app.exit(2);
    // app.exit() returns: stop here so nothing below (sandbox, protocol, lock, windows) runs.
    process.exit(2);
  }
}

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

async function openSerialPort(path: string, baudRate: number): Promise<SerialLike> {
  const { SerialPort } = await import("serialport");
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    port.open((err) => {
      if (err) reject(err);
      else resolve(port as unknown as SerialLike);
    });
  });
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
      const displayRoot = path.join(app.getAppPath(), "display");

      protocol.handle("app", async (request) => {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        const url = new URL(request.url);
        if (url.host !== "pos" && url.host !== "display")
          return new Response("Not found", { status: 404 });
        const base = url.host === "pos" ? root : displayRoot;
        let file = resolveAsset(base, url.pathname);
        if (file === undefined) return new Response("Bad request", { status: 400 });
        if (!fs.existsSync(file) && needsHtmlFallback(url.pathname))
          file = path.join(base, "index.html");
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
      const safe = {
        isStrong: strong,
        encryptString: (s: string) => safeStorage.encryptStringAsync(s),
        decryptString: async (b: Uint8Array) =>
          (await safeStorage.decryptStringAsync(Buffer.from(b))).result,
      };
      const files = {
        read: (f: string) => (fs.existsSync(f) ? fs.readFileSync(f) : undefined),
        write: atomicWrite,
        remove: (f: string) => {
          fs.rmSync(f, { force: true });
        },
      };
      const vault = createVaultStore({ file: path.join(userData, "identity.bin"), safe, files });
      // Device signing keys live here, encrypted with the same OS store, and never go to the renderer.
      const keyring = createKeyring({
        store: createVaultStore({ file: path.join(userData, "device-keys.bin"), safe, files }),
      });
      const configFile = path.join(userData, "hardware.json");
      const hardware = createHardwareService({
        dev,
        loadConfig: () => {
          try {
            return parseHardwareConfig(JSON.parse(fs.readFileSync(configFile, "utf8")), { dev });
          } catch {
            return undefined;
          }
        },
        saveConfig: (c) => {
          atomicWrite(configFile, Buffer.from(JSON.stringify(c)));
        },
        connect: (host, port) => {
          const socket = tcp.connect({ host, port });
          return {
            write: (bytes, done) => {
              socket.write(bytes, done);
            },
            destroy: () => {
              socket.destroy();
            },
            end: () => {
              socket.end();
            },
            on: (event, handler) => {
              socket.on(event, handler);
            },
          };
        },
        openSerial: openSerialPort,
        listSerial: async () => {
          const { SerialPort } = await import("serialport");
          return (await SerialPort.list()).map((p) => ({
            path: p.path,
            manufacturer: p.manufacturer,
          }));
        },
      });
      Menu.setApplicationMenu(null);
      const main = createMainWindow({
        url: `${APP_ORIGIN}/`,
        preload: path.join(__dirname, "preload.cjs"),
      });

      const displayFile = path.join(userData, "display.json");
      const display = createDisplayController({
        screens: () =>
          screen.getAllDisplays().map((d) => ({
            id: d.id,
            label: d.label === "" ? `Screen ${String(d.id)}` : d.label,
            primary: d.id === screen.getDisplayMatching(main.getBounds()).id,
            width: d.size.width,
            height: d.size.height,
          })),
        // The e2e run has one screen, so the display may open on it there.
        primaryId: () => (e2e ? undefined : screen.getDisplayMatching(main.getBounds()).id),
        open: (screenId) => {
          const bounds = screen.getAllDisplays().find((d) => d.id === screenId)?.bounds;
          const win = createDisplayWindow({
            url: "app://display/",
            preload: path.join(__dirname, "display-preload.cjs"),
            bounds: bounds ?? { x: 0, y: 0, width: 800, height: 600 },
          });
          let latest: DisplayState | null = null;
          let ready = false;
          win.webContents.once("did-finish-load", () => {
            ready = true;
            win.webContents.send(DISPLAY_PUSH, latest);
          });
          return {
            send: (state) => {
              latest = state;
              if (ready && !win.isDestroyed()) win.webContents.send(DISPLAY_PUSH, state);
            },
            close: () => {
              if (!win.isDestroyed()) win.close();
            },
            isLoaded: () => ready,
            isClosed: () => win.isDestroyed(),
          };
        },
        load: () => {
          try {
            const v = (JSON.parse(fs.readFileSync(displayFile, "utf8")) as { screen?: unknown })
              .screen;
            return typeof v === "number" ? v : null;
          } catch {
            return null;
          }
        },
        save: (id) => {
          atomicWrite(displayFile, Buffer.from(JSON.stringify({ screen: id })));
        },
      });
      main.on("closed", () => {
        display.closeAll();
      });

      const kioskFile = path.join(userData, "kiosk.json");
      let kioskOn = false;
      main.webContents.on("before-input-event", (event, input) => {
        if (kioskOn && isBlockedKioskKey(input)) event.preventDefault();
      });
      main.on("close", (event) => {
        if (kioskOn) event.preventDefault();
      });
      const kiosk = createKiosk({
        load: () => {
          try {
            return parseKioskRecord(JSON.parse(fs.readFileSync(kioskFile, "utf8")));
          } catch {
            return undefined;
          }
        },
        save: (r) => {
          atomicWrite(kioskFile, Buffer.from(JSON.stringify(r)));
        },
        now: Date.now,
        apply: (enabled) => {
          kioskOn = enabled;
          main.setKiosk(enabled);
          main.setAlwaysOnTop(enabled, "screen-saver");
        },
      });
      kiosk.start();
      startUpdater({
        updater: autoUpdater,
        packaged: app.isPackaged,
        channel: process.env.WISE_BIZ_UPDATE_CHANNEL,
        log: (line) => {
          console.warn(line);
        },
      });

      registerIpc(
        {
          handle: (channel, listener) => {
            ipcMain.handle(channel, listener);
          },
        },
        { storage, vault, keyring, hardware, display, kiosk },
      );
      app.on("before-quit", () => {
        kioskOn = false;
        storage.close();
      });
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
