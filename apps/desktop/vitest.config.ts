import { wiseBizVitest } from "@wise-biz/testing";
import { defineConfig, mergeConfig } from "vitest/config";

// main.ts and window.ts wire Electron itself and are covered by the Playwright Electron run.
export default mergeConfig(
  wiseBizVitest({ testTimeout: 20_000 }),
  defineConfig({
    test: {
      include: ["test/**/*.test.ts"],
      coverage: { exclude: ["src/main/main.ts", "src/main/window.ts", "src/preload/**"] },
    },
  }),
);
