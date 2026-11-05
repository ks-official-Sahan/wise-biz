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

// No debugging port here: a packaged terminal refuses --remote-debugging-port on purpose (see forbiddenSwitches). The
// rendered page and the bridge are covered by the Playwright run against the unpacked build; this checks that the
// packaged app starts and stays up.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wb-packaged-"));
const child = spawn(exe, [`--user-data-dir=${profile}`], { stdio: "ignore" });
let exitCode = null;
child.on("exit", (code) => {
  exitCode = code ?? -1;
});
await new Promise((r) => setTimeout(r, 8000));
const alive = exitCode === null;
child.kill();
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!alive) {
  console.error(`The packaged app exited within 8 seconds (code ${String(exitCode)}).`);
  process.exit(1);
}
console.log("Packaged app: fuses set, stayed up.");
