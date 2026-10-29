import { wiseBizVitest } from "@wise-biz/testing";

const config = wiseBizVitest({
  coverage: { lines: 95, functions: 95, branches: 95, statements: 95 },
});
// Timing lives in test/*.perf.test.ts (vitest.bench.config.ts); the unit run must not pick it up.
config.test = {
  ...config.test,
  include: ["test/**/*.test.ts"],
  exclude: ["test/**/*.perf.test.ts"],
};

export default config;
