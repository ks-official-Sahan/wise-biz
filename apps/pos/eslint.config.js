// @ts-check
import { base } from "@wise-biz/config/eslint/base";

export default [
  ...base({ root: import.meta.dirname }),
  {
    // Tests run in Node only and need the file system for durability tests; shipped code stays universal.
    files: ["test/**/*.ts"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
];
