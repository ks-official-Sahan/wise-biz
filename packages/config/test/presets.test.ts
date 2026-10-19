import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { base } from "../eslint/base.js";
import { next } from "../eslint/next.js";
import { node } from "../eslint/node.js";
import { reactNative } from "../eslint/react-native.js";
import { react } from "../eslint/react.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const universalDir = join(fixtures, "universal");
const nodeDir = join(fixtures, "node");

/** Lint a fixture package with its own eslint.config.js. Returns messages keyed by file name. */
async function lintFixture(dir: string, file: string) {
  const eslint = new ESLint({ cwd: dir });
  const [result] = await eslint.lintFiles([join(dir, "src", file)]);
  return result?.messages.map((m) => m.ruleId) ?? [];
}

describe("universal runtime ban", () => {
  it("flags node:fs and bare fs imports", async () => {
    const rules = await lintFixture(universalDir, "index.ts");
    expect(rules.filter((r) => r === "no-restricted-imports")).toHaveLength(2);
  });

  it("flags dynamic import() of node built-ins", async () => {
    const rules = await lintFixture(universalDir, "index.ts");
    // import("node:os"), import("fs"), import("fs/promises")
    expect(rules.filter((r) => r === "no-restricted-syntax")).toHaveLength(3);
  });

  it("throws when the package root has no package.json", () => {
    expect(() => base({ root: join(fixtures, "does-not-exist") })).toThrow();
  });

  it("does not flag node built-ins for node runtime", async () => {
    const rules = await lintFixture(nodeDir, "index.ts");
    expect(rules).not.toContain("no-restricted-imports");
  });
});

describe("rules", () => {
  it("flags explicit any", async () => {
    expect(await lintFixture(universalDir, "index.ts")).toContain(
      "@typescript-eslint/no-explicit-any",
    );
  });

  it("flags floating promises", async () => {
    expect(await lintFixture(universalDir, "index.ts")).toContain(
      "@typescript-eslint/no-floating-promises",
    );
  });

  it("flags default exports in src", async () => {
    expect(await lintFixture(universalDir, "default-export.ts")).toContain(
      "import-x/no-default-export",
    );
  });
});

describe("presets load and lint a trivial file", () => {
  const filePath = join(nodeDir, "src", "trivial.js");
  const presets = {
    base: () => base({ root: nodeDir }),
    node: () => node({ root: nodeDir }),
    react: () => react({ root: nodeDir }),
    reactNative: () => reactNative({ root: nodeDir }),
    next: () => next({ root: nodeDir }),
  } as const;

  for (const [name, preset] of Object.entries(presets)) {
    it(`${name} preset`, () => {
      const linter = new Linter({ configType: "flat" });
      expect(() => linter.verify("export const a = 1;\n", preset(), filePath)).not.toThrow();
    });
  }
});
