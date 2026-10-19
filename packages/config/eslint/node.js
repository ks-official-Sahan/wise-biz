// @ts-check
import globals from "globals";

import { base } from "./base.js";

/**
 * @param {{ root: string }} options
 * @returns {import("eslint").Linter.Config[]}
 */
export function node({ root }) {
  return [...base({ root }), { languageOptions: { globals: globals.node } }];
}
