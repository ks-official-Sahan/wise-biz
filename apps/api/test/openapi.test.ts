import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { docModules as modules } from "../src/modules.ts";
import { buildOpenApi } from "../src/openapi.ts";

const committed = join(import.meta.dirname, "../../../packages/contracts/generated/openapi.json");

describe("openapi", () => {
  it("is deterministic and well-formed", () => {
    const a = buildOpenApi(modules);
    expect(a).toBe(buildOpenApi(modules));
    expect(a.endsWith("}\n")).toBe(true);
    const doc = JSON.parse(a) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/health", "/ready"]));
  });

  it("matches packages/contracts/generated/openapi.json (run `pnpm -F @wise-biz/api openapi` if stale)", () => {
    expect(readFileSync(committed, "utf8")).toBe(buildOpenApi(modules));
  });
});
