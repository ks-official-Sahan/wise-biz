import { wiseBizVitest } from "@wise-biz/testing";
import { mergeConfig } from "vitest/config";

import type { ViteUserConfig } from "vitest/config";

// Pure lib modules are unit-tested here; pages and flows are covered by Playwright (e2e/).
const config: ViteUserConfig = mergeConfig(
  wiseBizVitest({ coverage: { lines: 90, functions: 90, branches: 85, statements: 90 } }),
  {
    resolve: { alias: { "@": `${import.meta.dirname}/src` } },
    test: { include: ["src/**/*.test.ts"] },
  },
);
// mergeConfig concatenates arrays; the coverage scope must replace the shared default, not extend it.
if (config.test?.coverage !== undefined) {
  config.test.coverage.include = ["src/lib/{csp,nav,diff,permissions,safe-next}.ts"];
}

export default config;
