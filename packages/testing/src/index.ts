import { defineConfig } from "vitest/config";

import type { ViteUserConfig } from "vitest/config";

export interface CoverageThresholds {
  lines?: number;
  functions?: number;
  branches?: number;
  statements?: number;
}

export interface WiseBizVitestOptions {
  coverage?: CoverageThresholds;
  include?: string[];
  /** Per-test timeout in ms (default 5000). Raise only for vector/property-heavy suites. */
  testTimeout?: number;
  /** Vitest globalSetup files (e.g. a Postgres container started once per run). */
  globalSetup?: string[];
  /** Test files run in parallel per package (default 4). Turbo already runs packages in parallel. */
  maxWorkers?: number;
}

const DEFAULT_INCLUDE = ["src/**/*.test.ts", "test/**/*.test.ts"];
const DEFAULT_THRESHOLD = 80;

/** Shared Vitest config for wise-biz packages. Overrides tune thresholds and test includes. */
export function wiseBizVitest(options: WiseBizVitestOptions = {}): ViteUserConfig {
  const { coverage = {} } = options;
  const testTimeout = options.testTimeout ?? 5_000;
  return defineConfig({
    test: {
      include: options.include ?? DEFAULT_INCLUDE,
      passWithNoTests: true,
      testTimeout,
      // beforeAll/afterAll create, migrate and drop databases: give hooks the same budget as tests.
      hookTimeout: Math.max(testTimeout, 10_000),
      // Bounded per package: `pnpm check` runs every container-backed package at once and saturates Docker
      // (connection timeouts) with one fork per core per package.
      maxWorkers: options.maxWorkers ?? 4,
      ...(options.globalSetup ? { globalSetup: options.globalSetup } : {}),
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
        thresholds: {
          lines: coverage.lines ?? DEFAULT_THRESHOLD,
          functions: coverage.functions ?? DEFAULT_THRESHOLD,
          branches: coverage.branches ?? DEFAULT_THRESHOLD,
          statements: coverage.statements ?? DEFAULT_THRESHOLD,
        },
      },
    },
  });
}
