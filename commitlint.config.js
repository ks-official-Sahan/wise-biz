// @ts-check
import { readdirSync } from "node:fs";

/** @param {string} dir @returns {string[]} */
function workspaceScopes(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const scopes = [
  ...["apps", "modules", "packages", "services"].flatMap(workspaceScopes),
  "docs",
  "ci",
  "infra",
  "deps",
  "release",
];

/** @type {import("@commitlint/types").UserConfig} */
const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", scopes],
  },
};

export default config;
