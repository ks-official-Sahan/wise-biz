import { describe, expect, it } from "vitest";

import { buildCsp, generateNonce, SECURITY_HEADERS } from "./csp.ts";
import { diffJson, show } from "./diff.ts";
import { COMMANDS, filterCommands, NAV } from "./nav.ts";
import { diffGrants, KNOWN_PERMISSIONS } from "./permissions.ts";
import { safeNext } from "./safe-next.ts";

describe("csp", () => {
  it("production policy: nonce, strict-dynamic, no unsafe-*, framing denied, upgrades", () => {
    const csp = buildCsp("abc123", { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("style-src 'self' 'nonce-abc123'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-");
    expect(csp).toMatch(/connect-src 'self'(;|$)/);
  });

  it("dev policy allows eval and websockets for React Refresh only", () => {
    const csp = buildCsp("n", { dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("nonces are 128-bit base64 and unique", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
  });

  it("static headers cover HSTS, nosniff, framing, referrer and permissions", () => {
    const names = SECURITY_HEADERS.map((h) => h.key.toLowerCase());
    for (const n of [
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "permissions-policy",
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe("nav and command palette", () => {
  it("every nav item has a palette command; phone bar fits five", () => {
    for (const n of NAV) expect(COMMANDS.some((c) => c.href === n.href)).toBe(true);
    expect(NAV.filter((n) => n.primary).length).toBeLessThanOrEqual(5);
  });

  it("matches label and keywords, case-insensitive, all words required", () => {
    expect(filterCommands("").length).toBe(COMMANDS.length);
    expect(filterCommands("STAFF").map((c) => c.id)).toEqual(
      expect.arrayContaining(["nav:/people", "act:invite"]),
    );
    expect(filterCommands("export csv").map((c) => c.id)).toEqual(["act:export"]);
    expect(filterCommands("zzz")).toEqual([]);
  });
});

describe("audit diff", () => {
  it("lists changed fields only, with dotted paths for nested objects", () => {
    expect(
      diffJson(
        { name: "Old", address: { city: "Kandy", zip: "20000" }, tags: ["a"] },
        { name: "New", address: { city: "Kandy", zip: "20001" }, tags: ["a"], kind: "store" },
      ),
    ).toEqual([
      { path: "address.zip", before: "20000", after: "20001" },
      { path: "kind", before: undefined, after: "store" },
      { path: "name", before: "Old", after: "New" },
    ]);
  });

  it("handles created and deleted records and scalar values", () => {
    expect(diffJson(null, { a: 1 })).toEqual([{ path: "(value)", before: null, after: { a: 1 } }]);
    expect(diffJson(undefined, { a: 1 })).toEqual([{ path: "a", before: undefined, after: 1 }]);
    expect(diffJson({ a: 1 }, undefined)).toEqual([{ path: "a", before: 1, after: undefined }]);
    expect(diffJson(1, 1)).toEqual([]);
    expect(show(undefined)).toBe("—");
    expect(show("x")).toBe("x");
    expect(show({ a: 1 })).toBe('{"a":1}');
  });
});

describe("permissions", () => {
  it("diffGrants reports sorted additions and removals", () => {
    expect(
      diffGrants(
        new Set(["tenancy:read", "audit:read"]),
        new Set(["tenancy:read", "tenancy:manage"]),
      ),
    ).toEqual({
      added: ["tenancy:manage"],
      removed: ["audit:read"],
    });
  });

  it("the matrix covers the tenancy and audit catalogs", () => {
    for (const p of ["tenancy:read", "tenancy:manage", "audit:read", "audit:export"]) {
      expect(KNOWN_PERMISSIONS.has(p)).toBe(true);
    }
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/people?x=1#a")).toBe("/people?x=1#a");
    expect(safeNext(null)).toBe("/");
  });
  it.each(["//evil.com", "/\\evil.com", "/\t/evil.com", "https://evil.com", "evil"])(
    "rejects %s",
    (raw) => {
      expect(safeNext(raw)).toBe("/");
    },
  );
});
