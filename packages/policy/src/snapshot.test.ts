import { generateKeyPair } from "@wise-biz/crypto";
import { describe, expect, it } from "vitest";

import { matrix } from "./fixtures.ts";
import { signSnapshot, verifySnapshot, type PolicySnapshot } from "./snapshot.ts";

const keys = generateKeyPair();
const other = generateKeyPair();
const snap: PolicySnapshot = {
  tenantId: "t1",
  version: 3,
  issuedAt: 1000,
  expiresAt: 2000,
  grants: matrix,
};
const at = { now: 1500, tenantId: "t1" };

describe("policy snapshot", () => {
  it("round-trips", () => {
    const r = verifySnapshot(signSnapshot(snap, keys.secretKey), keys.publicKey, at);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.snapshot).toEqual(snap);
  });
  it("rejects expired (boundary inclusive) and not yet valid", () => {
    const s = signSnapshot(snap, keys.secretKey);
    expect(verifySnapshot(s, keys.publicKey, { ...at, now: 2000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifySnapshot(s, keys.publicKey, { ...at, now: 999 })).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
  });
  it("rejects tampered payload", () => {
    const s = signSnapshot(snap, keys.secretKey);
    const evil = { ...s, payload: { ...s.payload, expiresAt: 9e12 } };
    expect(verifySnapshot(evil, keys.publicKey, at)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const grants = { ...matrix, cashier: [{ permission: "sales:refund" }] };
    expect(verifySnapshot({ ...s, payload: { ...s.payload, grants } }, keys.publicKey, at)).toEqual(
      { ok: false, reason: "bad_signature" },
    );
  });
  it("rejects wrong key, garbage signature", () => {
    const s = signSnapshot(snap, keys.secretKey);
    expect(verifySnapshot(s, other.publicKey, at)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySnapshot({ ...s, signature: "!!!" }, keys.publicKey, at)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifySnapshot({ ...s, signature: "AAAA" }, keys.publicKey, at)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
  it("rejects tenant mismatch", () => {
    const s = signSnapshot(snap, keys.secretKey);
    expect(verifySnapshot(s, keys.publicKey, { ...at, tenantId: "t2" })).toEqual({
      ok: false,
      reason: "tenant_mismatch",
    });
  });
  it("malformed input never throws", () => {
    for (const bad of [
      null,
      1,
      "x",
      {},
      { payload: 1, signature: "a" },
      { payload: {}, signature: 5 },
    ]) {
      expect(verifySnapshot(bad, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
    }
    // validly signed but wrong shape
    const weird = signSnapshot(
      { ...snap, grants: { r: [{ permission: "bad" }] } } as unknown as PolicySnapshot,
      keys.secretKey,
    );
    expect(verifySnapshot(weird, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
    const noTenant = signSnapshot({ ...snap, tenantId: "" }, keys.secretKey);
    expect(verifySnapshot(noTenant, keys.publicKey, at)).toEqual({
      ok: false,
      reason: "malformed",
    });
    const badCond = signSnapshot(
      { ...snap, grants: { r: [{ permission: "a:b", conditions: { maxAmountMinor: -1 } }] } },
      keys.secretKey,
    );
    expect(verifySnapshot(badCond, keys.publicKey, at)).toEqual({ ok: false, reason: "malformed" });
    const nanVersion = { payload: { ...snap, version: Number.NaN }, signature: "AAAA" };
    expect(verifySnapshot(nanVersion, keys.publicKey, at)).toMatchObject({ ok: false });
    expect(
      verifySnapshot({ payload: { a: undefined }, signature: "AA" }, keys.publicKey, at),
    ).toMatchObject({ ok: false });
  });
});
