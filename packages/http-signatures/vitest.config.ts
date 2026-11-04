import { wiseBizVitest } from "@wise-biz/testing";

const config = wiseBizVitest({
  coverage: { lines: 90, functions: 90, branches: 85, statements: 90 },
});
// Timing lives in test/*.perf.test.ts (vitest.perf.config.ts); the unit run must not pick it up.
config.test = { ...config.test, include: ["src/**/*.test.ts"] };

export default config;
