import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import { templateModule } from "../src/index.ts";
import { ListItemsQuery } from "../src/schemas.ts";

describe("templateModule", () => {
  it("declares name, permissions, absolute migrations dir, dev-only", () => {
    expect(templateModule.name).toBe("_template");
    expect(templateModule.permissions).toEqual(["template:read", "template:write"]);
    expect(isAbsolute(templateModule.migrationsDir)).toBe(true);
    expect(templateModule.devOnly).toBe(true);
  });
});

describe("?include allowlist", () => {
  it("accepts children, rejects anything else", () => {
    expect(ListItemsQuery.safeParse({ include: "children" }).success).toBe(true);
    expect(ListItemsQuery.safeParse({}).success).toBe(true);
    expect(ListItemsQuery.safeParse({ include: "children,secrets" }).success).toBe(false);
    expect(ListItemsQuery.safeParse({ include: "secrets" }).success).toBe(false);
  });
});
