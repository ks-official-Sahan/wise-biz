import { wiseBizVitest } from "@wise-biz/testing";

const base = wiseBizVitest({
  coverage: { lines: 90, functions: 90, branches: 80, statements: 90 },
});

// Unit coverage counts the logic modules. Screens, hooks and the runtime wiring (expo-sqlite, secure-store,
// router) are exercised end to end by the Playwright suite on the web export, not by Node unit tests.
export default {
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test?.coverage,
      include: [
        "src/platform/**/*.ts",
        "src/state/**/*.ts",
        "src/features/*/model/**/*.ts",
        "src/features/overrides/port.ts",
        "src/runtime/report.ts",
      ],
    },
  },
};
