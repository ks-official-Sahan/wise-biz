import { wiseBizVitest } from "@wise-biz/testing";

const config = wiseBizVitest({ testTimeout: 60_000 });
// Timing lives in test/*.perf.test.ts (vitest.perf.config.ts); the unit run must not pick it up.
config.test = {
  ...config.test,
  globalSetup: ["./test/global-setup.ts"],
  include: ["test/**/*.test.ts"],
  exclude: ["test/**/*.perf.test.ts"],
};

export default config;
