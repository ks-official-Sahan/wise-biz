import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = "3000";
const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI !== undefined ? 1 : 0,
  reporter: process.env.CI !== undefined ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // .next/ must exist: run `pnpm -F console build` first (the e2e script does not build).
    // The shell specs need no API; the full-flow spec expects the compose stack and `pnpm -F api dev`.
    command: "pnpm start",
    cwd: packageDir,
    url: `http://${HOST}:${PORT}/sign-in`,
    reuseExistingServer: process.env.CI === undefined,
    stdout: "ignore",
    stderr: "pipe",
  },
});
