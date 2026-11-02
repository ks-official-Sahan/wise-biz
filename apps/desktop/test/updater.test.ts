import { describe, expect, it } from "vitest";

import { channelFrom, startUpdater } from "../src/main/updater.ts";

import type { UpdaterLike } from "../src/main/updater.ts";

function fake(fail = false) {
  const handlers: Record<string, (arg: never) => void> = {};
  let checks = 0;
  const u: UpdaterLike = {
    channel: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    allowPrerelease: false,
    checkForUpdates: () => {
      checks++;
      return fail ? Promise.reject(new Error("offline")) : Promise.resolve(null);
    },
    on: (event, handler) => {
      handlers[event] = handler;
    },
  };
  return { u, handlers, checks: () => checks };
}

describe("updater", () => {
  it("maps the channel, defaulting to production", () => {
    expect(channelFrom("staging")).toBe("staging");
    expect(channelFrom("production")).toBe("latest");
    expect(channelFrom("Staging ")).toBe("latest");
    expect(channelFrom(undefined)).toBe("latest");
  });

  it("does nothing in a developer checkout", () => {
    const f = fake();
    expect(
      startUpdater({ updater: f.u, packaged: false, channel: "staging", log: () => undefined }),
    ).toEqual({
      channel: "staging",
      started: false,
    });
    expect(f.checks()).toBe(0);
    expect(f.u.channel).toBeNull();
  });

  it("checks at startup and on a timer, downloads, installs on quit and never downgrades", () => {
    const f = fake();
    const timers: (() => void)[] = [];
    const logs: string[] = [];
    const r = startUpdater({
      updater: f.u,
      packaged: true,
      channel: "staging",
      log: (l) => void logs.push(l),
      setTimer: (fn) => void timers.push(fn),
    });
    expect(r).toEqual({ channel: "staging", started: true });
    expect(f.u).toMatchObject({
      channel: "staging",
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: false,
      allowPrerelease: true,
    });
    expect(f.checks()).toBe(1);
    timers[0]?.();
    expect(f.checks()).toBe(2);
    f.handlers["update-downloaded"]?.(undefined as never);
    expect(logs.at(-1)).toContain("installs when the app quits");
  });

  it("keeps production off prereleases and reports failures instead of throwing", async () => {
    const f = fake(true);
    const logs: string[] = [];
    startUpdater({
      updater: f.u,
      packaged: true,
      channel: undefined,
      log: (l) => void logs.push(l),
      setTimer: () => undefined,
    });
    expect(f.u.allowPrerelease).toBe(false);
    expect(f.u.channel).toBe("latest");
    await new Promise((r) => setTimeout(r, 5));
    expect(logs[0]).toContain("update check failed: offline");
    f.handlers.error?.(new Error("boom") as never);
    f.handlers.error?.("x" as never);
    expect(logs.at(-2)).toContain("boom");
    expect(logs.at(-1)).toContain("unknown error");
  });
});
