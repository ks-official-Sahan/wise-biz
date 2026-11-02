import { BrowserWindow, app } from "electron";

export function createMainWindow(o: { url: string; preload: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#ffffff",
    title: "Wise Biz POS",
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged && process.env.WISE_BIZ_DEVTOOLS === "1",
    },
  });
  win.once("ready-to-show", () => {
    win.show();
  });
  win.loadURL(o.url).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "The window failed to load.");
  });
  return win;
}

/** The customer-facing window: frameless and fullscreen on the chosen screen, listen-only preload, never focused. */
export function createDisplayWindow(o: {
  url: string;
  preload: string;
  bounds: { x: number; y: number; width: number; height: number };
}): BrowserWindow {
  const win = new BrowserWindow({
    ...o.bounds,
    show: false,
    frame: false,
    fullscreen: true,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: "#ffffff",
    title: "Customer display",
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
    },
  });
  win.once("ready-to-show", () => {
    win.showInactive();
  });
  win.loadURL(o.url).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "The display failed to load.");
  });
  return win;
}
