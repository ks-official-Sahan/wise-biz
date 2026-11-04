// @ts-check
import { base } from "@wise-biz/config/eslint/base";

export default [
  ...base({ root: import.meta.dirname }),
  {
    // Test keys are ASCII: spreading a string into characters is safe there.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-misused-spread": "off" },
  },
];
