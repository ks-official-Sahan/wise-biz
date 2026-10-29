import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.perf.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
