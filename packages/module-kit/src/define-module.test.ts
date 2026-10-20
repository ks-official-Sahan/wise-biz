import { definePermissions } from "@wise-biz/policy";
import { describe, expect, it } from "vitest";

import { defineModule } from "./index.ts";

import type { WbModule } from "./index.ts";

const base: WbModule = {
  name: "_template",
  migrationsDir: "/abs/modules/_template/migrations",
  permissions: definePermissions("template", ["read", "write"]),
  events: [],
  routes: () => undefined,
};

describe("defineModule", () => {
  it("returns a frozen module", () => {
    const m = defineModule(base);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.permissions)).toBe(true);
    expect(m.name).toBe("_template");
  });

  it.each(["Bad", "1abc", "has-dash", "", "a b"])("rejects name %j", (name) => {
    expect(() => defineModule({ ...base, name })).toThrow(/invalid name/);
  });

  it("rejects relative migrationsDir", () => {
    expect(() => defineModule({ ...base, migrationsDir: "migrations" })).toThrow(/absolute/);
  });

  it("rejects bad or duplicate permissions", () => {
    expect(() =>
      defineModule({ ...base, permissions: ["nope"] as unknown as WbModule["permissions"] }),
    ).toThrow(/invalid permission/);
    expect(() =>
      defineModule({ ...base, permissions: ["a:b", "a:b"] as WbModule["permissions"] }),
    ).toThrow(/duplicate/);
  });

  it("rejects non-function routes", () => {
    expect(() => defineModule({ ...base, routes: "x" as unknown as WbModule["routes"] })).toThrow(
      /routes/,
    );
  });
});
