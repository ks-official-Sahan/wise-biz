import { wiseBizVitest } from "@wise-biz/testing";

export default wiseBizVitest({
  coverage: { lines: 90, functions: 90, branches: 85, statements: 90 },
  // 10k-sample UTF-8 cross-checks and Wycheproof/NIST vectors exceed 5 s under coverage + parallel turbo.
  testTimeout: 30_000,
});
