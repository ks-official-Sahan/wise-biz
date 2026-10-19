import { defineConfig } from "vitest/config";

// Not importing @wise-biz/testing here: it devDepends on this package (cycle breaks turbo).
// These are ESLint integration tests: the first type-aware lint builds a TS program, which can
// exceed the 5 s default when turbo runs every package in parallel.
export default defineConfig({
  test: { passWithNoTests: true, include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
