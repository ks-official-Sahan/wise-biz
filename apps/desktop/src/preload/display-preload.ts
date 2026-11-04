import { contextBridge, ipcRenderer } from "electron";

import { DISPLAY_PUSH } from "../shared/channels.ts";

import type { DisplayState } from "../shared/channels.ts";

// The customer display only listens: it has no way to call back into the main process.
contextBridge.exposeInMainWorld("wiseDisplay", {
  onState: (cb: (state: DisplayState | null) => void): void => {
    ipcRenderer.on(DISPLAY_PUSH, (_event, state: DisplayState | null) => {
      cb(state);
    });
  },
});
