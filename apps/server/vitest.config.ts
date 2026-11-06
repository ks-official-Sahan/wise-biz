import { wiseBizVitest } from "@wise-biz/testing";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  wiseBizVitest(),
  defineConfig({ test: { coverage: { exclude: ["src/main.ts", "test/**"] } } }),
);
