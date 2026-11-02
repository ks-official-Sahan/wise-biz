import { wiseBizVitest } from "@wise-biz/testing";

const config = wiseBizVitest({ testTimeout: 60_000 });
config.test = {
  ...config.test,
  globalSetup: ["./test/global-setup.ts"],
};

export default config;
