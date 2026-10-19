// @ts-check
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

import { base } from "./base.js";

/**
 * @param {{ root: string }} options
 * @returns {import("eslint").Linter.Config[]}
 */
export function react({ root }) {
  return [
    ...base({ root }),
    reactHooks.configs.flat.recommended,
    { files: ["**/*.tsx"], languageOptions: { globals: globals.browser } },
  ];
}
