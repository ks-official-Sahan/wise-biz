import { describe, expect, it } from "vitest";

import { generate } from "./generate.ts";

// Committed generator output, keyed like generate(): path relative to generated/.
const committed = import.meta.glob<string>(
  ["../generated/**/*.json", "!../generated/openapi.json"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);
const onDisk = Object.fromEntries(
  Object.entries(committed).map(([p, c]) => [p.replace("../generated/", ""), c]),
);

describe("generate", () => {
  it("is deterministic", () => {
    expect(generate()).toEqual(generate());
  });

  it("emits formatted JSON with trailing newline and AsyncAPI 3", () => {
    const files = generate();
    for (const c of Object.values(files)) expect(c.endsWith("}\n")).toBe(true);
    const api = JSON.parse(files["asyncapi.json"] ?? "") as { asyncapi: string; channels: object };
    expect(api.asyncapi).toBe("3.0.0");
    expect(Object.keys(api.channels)).toContain("platform_contracts_ping_v1");
    expect(Object.keys(files)).toContain("jsonschema/Money.json");
  });

  it("matches committed generated/ files (run `pnpm -F @wise-biz/contracts gen` if stale)", () => {
    expect(onDisk).toEqual(generate());
  });
});
