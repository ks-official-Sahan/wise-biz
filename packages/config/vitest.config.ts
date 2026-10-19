import { defineConfig } from "vitest/config";

// Not importing @wise-biz/testing here: it devDepends on this package (cycle breaks turbo).
export default defineConfig({ test: { passWithNoTests: true, include: ["test/**/*.test.ts"] } });
