import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.perf.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
