// @ts-check
import { reactNative } from "@wise-biz/config/eslint/react-native";

export default [
  ...reactNative({ root: import.meta.dirname }),
  {
    // Unit tests run in Node and e2e in Playwright: both may use Node built-ins.
    files: ["test/**/*.ts", "e2e/**/*.ts", "e2e/**/*.mjs"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
  {
    // Expo Router loads routes by default export.
    files: ["app/**/*.tsx"],
    rules: { "import-x/no-default-export": "off" },
  },
];
