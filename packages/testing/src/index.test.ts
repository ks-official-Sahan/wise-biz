import { describe, expect, it } from "vitest";

import { wiseBizVitest } from "./index.ts";

interface Resolved {
  test: {
    include: string[];
    passWithNoTests: boolean;
    testTimeout: number;
    hookTimeout: number;
    maxWorkers: number;
    coverage: { provider: string; thresholds: Record<string, number>; include: string[] };
  };
}

describe("wiseBizVitest", () => {
  it("applies defaults", () => {
    const config = wiseBizVitest() as unknown as Resolved;
    expect(config.test.include).toEqual(["src/**/*.test.ts", "test/**/*.test.ts"]);
    expect(config.test.passWithNoTests).toBe(true);
    expect(config.test.testTimeout).toBe(5_000);
    expect(config.test.hookTimeout).toBe(10_000);
    expect(config.test.maxWorkers).toBe(4);
    expect(config.test.coverage.provider).toBe("v8");
    expect(config.test.coverage.include).toEqual(["src/**/*.ts"]);
    expect(config.test.coverage.thresholds).toEqual({
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
    });
  });

  it("applies overrides", () => {
    const config = wiseBizVitest({
      include: ["test/**/*.spec.ts"],
      coverage: { lines: 90, branches: 50 },
      testTimeout: 30_000,
    }) as unknown as Resolved;
    expect(config.test.include).toEqual(["test/**/*.spec.ts"]);
    expect(config.test.testTimeout).toBe(30_000);
    expect(config.test.hookTimeout).toBe(30_000);
    expect(config.test.coverage.thresholds).toEqual({
      lines: 90,
      functions: 80,
      branches: 50,
      statements: 80,
    });
  });
});
