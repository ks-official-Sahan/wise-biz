// @ts-check
import { node } from "@wise-biz/config/eslint/node";

export default [
  { ignores: ["renderer/**", "dist/**", "release/**", "display/**", "src/customer-display/**"] },
  ...node({ root: import.meta.dirname }),
  {
    // electron-builder loads the afterPack hook by its default export.
    files: ["scripts/after-pack.mjs"],
    rules: { "import-x/no-default-export": "off" },
  },
  {
    // Unit tests and e2e touch the filesystem and Node built-ins freely.
    files: ["test/**/*.ts", "e2e/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];
