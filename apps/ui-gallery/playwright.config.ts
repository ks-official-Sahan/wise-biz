import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = "4173";
const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  // Baselines live next to the spec: e2e/__screenshots__/<name>-<project>-<platform>.png
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}-{platform}{ext}",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    },
  },
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI !== undefined ? 1 : 0,
  reporter: process.env.CI !== undefined ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // dist/ must exist: run `pnpm -F ui-gallery export:web` first (the e2e scripts do not build).
    command: "node e2e/serve.mjs",
    cwd: packageDir,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: process.env.CI === undefined,
    stdout: "ignore",
    stderr: "pipe",
  },
});
