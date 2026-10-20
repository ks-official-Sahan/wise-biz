import { wiseBizVitest } from "./src/index.ts";

export default wiseBizVitest({
  testTimeout: 120_000,
  globalSetup: ["./src/containers/pg-global-setup.ts"],
});
