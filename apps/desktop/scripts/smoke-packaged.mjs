// Smoke test of the unpacked app from `pnpm run package`: the fuses are set as intended and the app starts and stays up
// with a throwaway profile. (Playwright cannot drive it: the Node inspector fuse is off on purpose.)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const root = path.resolve(import.meta.dirname, "..");
const exe =
  process.platform === "win32"
    ? path.join(root, "release/win-unpacked/Wise Biz POS.exe")
    : process.platform === "darwin"
      ? path.join(root, "release/mac/Wise Biz POS.app/Contents/MacOS/Wise Biz POS")
      : path.join(root, "release/linux-unpacked/wise-biz-desktop");
if (!fs.existsSync(exe)) {
  console.error(`Nothing to test at ${exe}; run "pnpm run package" first.`);
  process.exit(1);
}

const wire = await getCurrentFuseWire(exe);
const expect = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
};
for (const [fuse, state] of Object.entries(expect)) {
  if (wire[fuse] !== state) {
    console.error(
      `Fuse ${FuseV1Options[fuse]} is ${String(wire[fuse])}, expected ${String(state)}`,
    );
    process.exit(1);
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wb-packaged-"));
const debugPort = 9333;
const child = spawn(
  exe,
  [`--user-data-dir=${profile}`, `--remote-debugging-port=${String(debugPort)}`],
  {
    stdio: "ignore",
  },
);
let exited = false;
child.on("exit", () => {
  exited = true;
});
await new Promise((r) => setTimeout(r, 8000));
const alive = !exited;

// Ask the page itself (Chromium's debugging port, which the Node inspector fuse does not cover) what it rendered.
let page = "";
if (alive) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${String(debugPort)}/json/list`)).json();
    const target = targets.find((t) => t.type === "page" && String(t.url).startsWith("app://pos/"));
    if (target === undefined) page = "no page at app://pos/";
    else {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      const answer = new Promise((resolve) => {
        ws.addEventListener("message", (m) => {
          const d = JSON.parse(String(m.data));
          if (d.id === 1) resolve(d.result?.result?.value);
        });
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression:
              "JSON.stringify({ text: document.body.innerText.length, bridge: typeof window.wiseDesktop?.db?.open })",
            returnByValue: true,
          },
        }),
      );
      page = String(await answer);
      ws.close();
    }
  } catch (e) {
    page = e instanceof Error ? e.message : "debug port error";
  }
}
child.kill();
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!alive) {
  console.error("The packaged app exited within 8 seconds.");
  process.exit(1);
}
const seen = (() => {
  try {
    return JSON.parse(page);
  } catch {
    return undefined;
  }
})();
if (seen === undefined || seen.text === 0 || seen.bridge !== "function") {
  console.error(`The packaged page did not render with the bridge: ${page}`);
  process.exit(1);
}
console.log("Packaged app: fuses set, rendered the POS with the bridge, stayed up.");
