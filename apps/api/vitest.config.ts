import { wiseBizVitest } from "@wise-biz/testing";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  wiseBizVitest({ testTimeout: 120_000 }),
  defineConfig({ test: { globalSetup: ["./test/global-setup.ts"] } }),
);
