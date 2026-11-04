// @ts-check
import { base } from "@wise-biz/config/eslint/base";

export default [
  ...base({ root: import.meta.dirname }),
  {
    // Receipt text is measured and cut by code point on purpose (single-byte printer code pages).
    rules: { "@typescript-eslint/no-misused-spread": "off" },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
];
