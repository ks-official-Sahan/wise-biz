// @ts-check
import { base } from "@wise-biz/config/eslint/base";

// Each workspace package lints itself with its own eslint.config.js.
/** @type {import("eslint").Linter.Config[]} */
const workspaceIgnores = [{ ignores: ["apps/**", "modules/**", "packages/**", "services/**"] }];

export default [...workspaceIgnores, ...base({ root: import.meta.dirname })];
