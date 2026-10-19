import { canonicalize, fromBase64url, sign, toBase64url, utf8, verify } from "@wise-biz/crypto";

import { isValidConditions } from "./conditions.ts";
import { isPermission } from "./permissions.ts";

import type { PolicyMatrix } from "./matrix.ts";

export type PolicySnapshot = Readonly<{
  tenantId: string;
  version: number;
  /** Epoch ms. */
  issuedAt: number;
  expiresAt: number;
  grants: PolicyMatrix;
}>;

export type SignedSnapshot = Readonly<{ payload: PolicySnapshot; signature: string }>;

export type SnapshotFailure =
  "bad_signature" | "expired" | "not_yet_valid" | "tenant_mismatch" | "malformed";
export type SnapshotResult =
  | Readonly<{ ok: true; snapshot: PolicySnapshot }>
  | Readonly<{ ok: false; reason: SnapshotFailure }>;

export function signSnapshot(snapshot: PolicySnapshot, secretKey: Uint8Array): SignedSnapshot {
  return { payload: snapshot, signature: toBase64url(sign(canonicalize(snapshot), secretKey)) };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isSnapshot(v: unknown): v is PolicySnapshot {
  if (!isRecord(v)) return false;
  const { tenantId, version, issuedAt, expiresAt, grants } = v;
  if (typeof tenantId !== "string" || tenantId === "") return false;
  if (![version, issuedAt, expiresAt].every((n) => typeof n === "number" && Number.isFinite(n)))
    return false;
  if (!isRecord(grants)) return false;
  return Object.values(grants).every(
    (list) =>
      Array.isArray(list) &&
      list.every(
        (g) =>
          isRecord(g) &&
          isPermission(g.permission) &&
          (g.conditions === undefined || isValidConditions(g.conditions)),
      ),
  );
}

/** Signature first, then shape, tenant, validity window. Never throws. */
export function verifySnapshot(
  signed: unknown,
  publicKey: Uint8Array,
  expect: Readonly<{ now: number; tenantId: string }>,
): SnapshotResult {
  const fail = (reason: SnapshotFailure): SnapshotResult => ({ ok: false, reason });
  try {
    if (!isRecord(signed) || !isRecord(signed.payload) || typeof signed.signature !== "string") {
      return fail("malformed");
    }
    const payload = signed.payload;
    let valid: boolean;
    try {
      valid = verify(fromBase64url(signed.signature), utf8(canonicalize(payload)), publicKey);
    } catch {
      return fail("bad_signature");
    }
    if (!valid) return fail("bad_signature");
    if (!isSnapshot(payload)) return fail("malformed");
    if (payload.tenantId !== expect.tenantId) return fail("tenant_mismatch");
    if (expect.now >= payload.expiresAt) return fail("expired");
    if (expect.now < payload.issuedAt) return fail("not_yet_valid");
    return { ok: true, snapshot: payload };
  } catch {
    return fail("malformed");
  }
}
