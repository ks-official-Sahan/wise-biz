// @ts-check
import nextPlugin from "@next/eslint-plugin-next";

import { CONFIG_FILES } from "./base.js";
import { react } from "./react.js";

/**
 * @param {{ root: string }} options
 * @returns {import("eslint").Linter.Config[]}
 */
export function next({ root }) {
  return [
    ...react({ root }),
    nextPlugin.configs["core-web-vitals"],
    {
      files: [
        "app/**/{page,layout,loading,error,not-found,template,default,route}.tsx",
        ...CONFIG_FILES,
      ],
      rules: { "import-x/no-default-export": "off" },
    },
  ];
}
