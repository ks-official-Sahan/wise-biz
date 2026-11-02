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
