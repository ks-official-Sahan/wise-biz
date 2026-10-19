import { generateKeyPair, canonicalize, sign, toBase64url, utf8 } from "@wise-biz/crypto";
import { describe, expect, it } from "vitest";

import { isValidConditions } from "./conditions.ts";
import { decide } from "./decide.ts";
import { catalog, ctx, matrix, res } from "./fixtures.ts";
import * as api from "./index.ts";
import { matrixFromRows, toAuthKitMatrix } from "./matrix.ts";
import { isTenantRole } from "./roles.ts";
import {
  SNAPSHOT_DOMAIN_TAG,
  signSnapshot,
  verifySnapshot,
  type PolicySnapshot,
} from "./snapshot.ts";

const keys = generateKeyPair();
const base: PolicySnapshot = {
  tenantId: "t1",
  version: 3,
  issuedAt: 1000,
  expiresAt: 2000,
  grants: matrix,
};
const at = { now: 1500, tenantId: "t1" };
const resign = (p: unknown) => signSnapshot(p as PolicySnapshot, keys.secretKey);

describe("1 branch scope fails closed", () => {
  it("scoped user + resource without branchId -> denied", () => {
    expect(
      decide(matrix, ctx({ branchScope: ["b1"], roles: ["owner"] }), "sales:create", res()),
    ).toEqual({
      allow: false,
      reason: "branch_out_of_scope",
    });
  });
  it("scope all still fine without branchId", () => {
    expect(decide(matrix, ctx({ roles: ["owner"] }), "sales:create", res()).allow).toBe(true);
  });
});

describe("2 prototype safety", () => {
  it.each(["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"])(
    "role %s",
    (role) => {
      const d = decide(matrix, ctx({ roles: [role] }), "sales:create", res());
      expect(d).toEqual({ allow: false, reason: "not_granted" });
    },
  );
  it("approver scan ignores inherited props; matrices are null-proto", () => {
    expect(Object.getPrototypeOf(matrix)).toBeNull();
    expect(Object.getPrototypeOf(toAuthKitMatrix(matrix))).toBeNull();
  });
  it("rejects dangerous role names", () => {
    for (const r of ["__proto__", "constructor", "prototype"]) expect(isTenantRole(r)).toBe(false);
    const m = matrixFromRows(catalog, [{ role: "constructor", permission: "sales:create" }]);
    expect(Object.hasOwn(m, "constructor")).toBe(false);
  });
  it("snapshot with constructor role is malformed", () => {
    const s = resign({ ...base, grants: { constructor: [] } });
    expect(verifySnapshot(s, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
  });
  it("matrix lacking role does not match inherited", () => {
    expect(decide({}, ctx({ roles: ["toString"] }), "sales:create", res()).allow).toBe(false);
  });
});

describe("3 snapshot freshness", () => {
  const s = () => signSnapshot(base, keys.secretKey);
  it("non-finite now -> malformed", () => {
    for (const now of [Number.NaN, Infinity]) {
      expect(verifySnapshot(s(), keys.publicKey, { now, tenantId: "t1" })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
  it("stale_version", () => {
    expect(verifySnapshot(s(), keys.publicKey, { ...at, minVersion: 4 })).toEqual({
      ok: false,
      reason: "stale_version",
    });
    expect(verifySnapshot(s(), keys.publicKey, { ...at, minVersion: 3 })).toMatchObject({
      ok: true,
    });
  });
  it("bad versions malformed", () => {
    for (const version of [-1, 1.5, 2 ** 60]) {
      expect(verifySnapshot(resign({ ...base, version }), keys.publicKey, at)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
  it("issuedAt must be < expiresAt", () => {
    expect(
      verifySnapshot(resign({ ...base, issuedAt: 2000 }), keys.publicKey, { ...at, now: 2000 }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
  it("ttl cap, default 7d, overridable", () => {
    const long = resign({ ...base, expiresAt: base.issuedAt + 7 * 86_400_000 + 1 });
    expect(verifySnapshot(long, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
    const ok = resign({ ...base, expiresAt: base.issuedAt + 7 * 86_400_000 });
    expect(verifySnapshot(ok, keys.publicKey, at)).toMatchObject({ ok: true });
    expect(verifySnapshot(s(), keys.publicKey, { ...at, maxTtlMs: 500 })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("4 domain separation", () => {
  it("exports tag; raw-canonical signature fails", () => {
    expect(SNAPSHOT_DOMAIN_TAG).toBe("wb-policy-snapshot-v1\u0000");
    const raw = { payload: base, signature: toBase64url(sign(canonicalize(base), keys.secretKey)) };
    expect(verifySnapshot(raw, keys.publicKey, at)).toEqual({ ok: false, reason: "bad_signature" });
    const tagged = {
      payload: base,
      signature: toBase64url(sign(utf8(SNAPSHOT_DOMAIN_TAG + canonicalize(base)), keys.secretKey)),
    };
    expect(verifySnapshot(tagged, keys.publicKey, at)).toMatchObject({ ok: true });
  });
});

describe("5 strict conditions", () => {
  it("rejects unknown keys", () => {
    expect(isValidConditions({ maxAmountMinor: 1, extra: 1 })).toBe(false);
    expect(isValidConditions({ timeWindow: { startMinute: 1, endMinute: 2, junk: 1 } })).toBe(
      false,
    );
  });
  it("matrixFromRows skips; snapshot malformed", () => {
    const m = matrixFromRows(catalog, [
      {
        role: "cashier",
        permission: "sales:void",
        conditions: { maxAmountMinor: 1, x: 1 } as never,
      },
    ]);
    expect(m.cashier).toEqual([]);
    const s = resign({ ...base, grants: { r: [{ permission: "a:b", conditions: { z: 1 } }] } });
    expect(verifySnapshot(s, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("6 frozen copies", () => {
  it("matrix does not alias caller conditions", () => {
    const cond = {
      maxAmountMinor: 5,
      deviceClass: ["pos" as const],
      timeWindow: { startMinute: 1, endMinute: 2, days: [1 as const] },
    };
    const m = matrixFromRows(catalog, [
      { role: "cashier", permission: "sales:void", conditions: cond },
    ]);
    cond.maxAmountMinor = 9e9;
    cond.deviceClass.push("web" as never);
    const g = m.cashier?.[0];
    expect(g?.conditions?.maxAmountMinor).toBe(5);
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g?.conditions)).toBe(true);
    expect(Object.isFrozen(g?.conditions?.deviceClass)).toBe(true);
    expect(Object.isFrozen(g?.conditions?.timeWindow)).toBe(true);
    expect(Object.isFrozen(g?.conditions?.timeWindow?.days)).toBe(true);
    expect(Object.isFrozen(m.cashier)).toBe(true);
  });
  it("verifySnapshot returns frozen copy; decide grant frozen", () => {
    const signed = signSnapshot(base, keys.secretKey);
    const r = verifySnapshot(signed, keys.publicKey, at);
    if (!r.ok) throw new Error("x");
    expect(r.snapshot).not.toBe(signed.payload);
    expect(Object.isFrozen(r.snapshot)).toBe(true);
    expect(Object.isFrozen(r.snapshot.grants)).toBe(true);
    expect(Object.isFrozen(r.snapshot.grants.cashier?.[0])).toBe(true);
    const d = decide(r.snapshot.grants, ctx(), "sales:discount", res({ discountBps: 1 }));
    expect(d.allow && Object.isFrozen(d.grant)).toBe(true);
    const loose = decide(
      { cashier: [{ permission: "sales:create" }] },
      ctx(),
      "sales:create",
      res(),
    );
    expect(loose.allow && Object.isFrozen(loose.grant)).toBe(true);
  });
});

describe("7 negative amounts use magnitude", () => {
  it("refund -999999 does not bypass maxAmountMinor", () => {
    expect(decide(matrix, ctx(), "sales:void", res({ amountMinor: -999_999 })).allow).toBe(false);
    expect(decide(matrix, ctx(), "sales:void", res({ amountMinor: -5000 })).allow).toBe(true);
  });
  it("negative discount", () => {
    expect(decide(matrix, ctx(), "sales:discount", res({ discountBps: -9000 })).allow).toBe(false);
  });
});

describe("8 tenant ids non-empty", () => {
  it("empty both -> tenant_mismatch", () => {
    expect(decide(matrix, ctx({ tenantId: "" }), "sales:create", res({ tenantId: "" }))).toEqual({
      allow: false,
      reason: "tenant_mismatch",
    });
    expect(
      decide(matrix, ctx({ tenantId: 5 as never }), "sales:create", res({ tenantId: 5 as never }))
        .allow,
    ).toBe(false);
  });
});

describe("9 invalid context", () => {
  it.each([
    { localMinuteOfDay: -1 },
    { localMinuteOfDay: 1440 },
    { localMinuteOfDay: 1.5 },
    { localMinuteOfDay: Number.NaN },
    { localDayOfWeek: 7 as never },
    { localDayOfWeek: -1 as never },
    { localDayOfWeek: 1.2 as never },
  ])("%o", (over) => {
    expect(decide(matrix, ctx({ roles: ["owner"], ...over }), "sales:create", res())).toEqual({
      allow: false,
      reason: "invalid_context",
    });
  });
});

describe("10 platform perms dropped", () => {
  it("toAuthKitMatrix drops", () => {
    const evil = {
      cashier: [
        { permission: "platform:tenants_suspend" as const },
        { permission: "sales:create" as const },
      ],
    };
    expect([...(toAuthKitMatrix(evil).cashier ?? [])]).toEqual(["sales:create"]);
  });
  it("snapshot with platform perm malformed", () => {
    const s = resign({
      ...base,
      grants: { cashier: [{ permission: "platform:tenants_suspend" }] },
    });
    expect(verifySnapshot(s, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("11/12 api surface", () => {
  it("firstFailure not exported", () => {
    expect("firstFailure" in api).toBe(false);
  });
  it("unfrozen matrices still work and see mutations", () => {
    const m: Record<string, { permission: "a:b" }[]> = { r: [] };
    expect(decide(m, ctx({ roles: ["r"] }), "a:b", res()).allow).toBe(false);
    m.r?.push({ permission: "a:b" });
    expect(decide(m, ctx({ roles: ["r"] }), "a:b", res()).allow).toBe(true);
  });
});
