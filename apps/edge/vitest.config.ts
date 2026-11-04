import { wiseBizVitest } from "@wise-biz/testing";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  wiseBizVitest({
    coverage: { lines: 90, functions: 90, branches: 90, statements: 90 },
  }),
  defineConfig({ test: { coverage: { exclude: ["src/worker.ts"] } } }),
);
