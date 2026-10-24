// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import { configs as tsConfigs, plugin as tsPlugin } from "typescript-eslint";

/** esquery regex matching node:* and every bare built-in name (builtinModules includes subpaths). */
const BUILTIN_SPECIFIER = `/^(node:|(${builtinModules
  .filter((name) => !name.startsWith("node:"))
  .map((name) => name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"))
  .join("|")})$)/`;

/** Config files may use default exports (tooling requires them). */
export const CONFIG_FILES = ["**/*.config.{js,ts,cjs,mjs}", "eslint.config.js"];

/**
 * @param {string} root
 * @returns {boolean}
 */
function isUniversal(root) {
  // Fail loudly: a silent false here would switch the Node built-in ban off.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg?.wiseBiz?.runtime === "universal";
}

/**
 * @param {{ root: string }} options
 * @returns {import("eslint").Linter.Config[]}
 */
export function base({ root }) {
  /** @type {import("eslint").Linter.Config[]} */
  const universalRules = isUniversal(root)
    ? [
        {
          files: ["**/*.{js,cjs,mjs,ts,tsx}"],
          rules: {
            "no-restricted-imports": [
              "error",
              {
                patterns: [{ group: ["node:*"], message: "universal package: no Node built-ins" }],
                paths: builtinModules.map((name) => ({
                  name,
                  message: "universal package: no Node built-ins",
                })),
              },
            ],
            "no-restricted-syntax": [
              "error",
              {
                // import("node:x"), import("fs"), import("fs/promises"); same for require().
                selector: `:matches(ImportExpression, CallExpression[callee.name="require"]) > Literal[value=${BUILTIN_SPECIFIER}]`,
                message: "universal package: no Node built-ins",
              },
            ],
          },
        },
      ]
    : [];

  return defineConfig([
    { ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "**/node_modules/**"] },
    js.configs.recommended,
    // Set for every file, not only TS: import-x parses imported .d.ts files with the importing
    // file's parser options, and without a root the parser fails when ESLint runs from the repo root.
    { languageOptions: { parserOptions: { tsconfigRootDir: root } } },
    {
      files: ["**/*.{ts,tsx}"],
      extends: [...tsConfigs.strictTypeChecked, ...tsConfigs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: root },
      },
    },
    {
      files: ["**/*.{js,cjs,mjs}"],
      extends: [tsConfigs.disableTypeChecked],
    },
    { plugins: { "@typescript-eslint": tsPlugin } },
    {
      files: ["**/*.{ts,tsx}"],
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/consistent-type-imports": "error",
      },
    },
    importX.flatConfigs.recommended,
    importX.flatConfigs.typescript,
    {
      settings: {
        // Resolve against this package's tsconfig, not the process cwd: lint-staged runs ESLint from the repo root,
        // and package-level tsconfig settings (paths, customConditions) must still apply.
        "import-x/resolver-next": [
          createTypeScriptImportResolver(
            existsSync(join(root, "tsconfig.json")) ? { project: join(root, "tsconfig.json") } : {},
          ),
        ],
      },
      rules: {
        "import-x/order": [
          "error",
          {
            groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
            "newlines-between": "always",
            alphabetize: { order: "asc", caseInsensitive: true },
          },
        ],
        "import-x/no-default-export": "error",
        // CJS plugins (e.g. @next/eslint-plugin-next) only expose `default`; TypeScript already
        // checks named vs default imports, so these two only add noise and lint time.
        "import-x/no-named-as-default": "off",
        "import-x/no-named-as-default-member": "off",
      },
    },
    {
      files: CONFIG_FILES,
      rules: { "import-x/no-default-export": "off" },
    },
    ...universalRules,
    prettier,
  ]);
}
