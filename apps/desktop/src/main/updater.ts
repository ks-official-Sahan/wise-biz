export type UpdateChannel = "latest" | "staging";

/** The slice of electron-updater's `autoUpdater` this module uses, so the policy can be tested without Electron. */
export interface UpdaterLike {
  channel: string | null;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates: () => Promise<unknown>;
  on: (event: "update-downloaded" | "error", handler: (arg: unknown) => void) => unknown;
}

export interface UpdaterOptions {
  readonly updater: UpdaterLike;
  /** Only a packaged app updates itself: a developer checkout never replaces its own files. */
  readonly packaged: boolean;
  readonly channel: string | undefined;
  readonly log: (line: string) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
}

const HOUR_MS = 60 * 60 * 1000;

/** `production` is the default; anything other than `staging` is production, so a typo never lands a till on staging. */
export function channelFrom(value: string | undefined): UpdateChannel {
  return value === "staging" ? "staging" : "latest";
}

/**
 * Checks for updates at startup and every hour, downloads in the background and installs when the app quits (the
 * till is closed at the end of the day anyway). Nothing restarts the app: the install waits for the next quit, so a sale in progress is never interrupted. Updates must be
 * signed by the same publisher: electron-updater verifies the signature of the installer before it runs.
 */
export function startUpdater(o: UpdaterOptions): { channel: UpdateChannel; started: boolean } {
  const channel = channelFrom(o.channel);
  if (!o.packaged) return { channel, started: false };
  const u = o.updater;
  u.channel = channel;
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  // A rollback is a new, higher version; the updater never moves a till back by itself.
  u.allowDowngrade = false;
  u.allowPrerelease = channel === "staging";
  u.on("error", (e: unknown) => {
    o.log(`update check failed: ${e instanceof Error ? e.message : "unknown error"}`);
  });
  u.on("update-downloaded", () => {
    o.log("update downloaded; it installs when the app quits");
  });
  const check = () => {
    u.checkForUpdates().catch((e: unknown) => {
      o.log(`update check failed: ${e instanceof Error ? e.message : "unknown error"}`);
    });
  };
  check();
  (o.setTimer ?? setInterval)(check, HOUR_MS);
  return { channel, started: true };
}
