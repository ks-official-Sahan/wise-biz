// @ts-check
import globals from "globals";

import { react } from "./react.js";

/**
 * @param {{ root: string }} options
 * @returns {import("eslint").Linter.Config[]}
 */
export function reactNative({ root }) {
  return [
    ...react({ root }),
    { files: ["**/*.{js,cjs,mjs,ts,tsx}"], languageOptions: { globals: globals.es2023 } },
  ];
}
