import { canonicalize, fromBase64url, sign, toBase64url, utf8, verify } from "@wise-biz/crypto";

import { isValidConditions } from "./conditions.ts";
import { freezeMatrix } from "./matrix.ts";
import { isPermission, isPlatformPermission } from "./permissions.ts";
import { isTenantRole } from "./roles.ts";

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
  "bad_signature" | "expired" | "not_yet_valid" | "tenant_mismatch" | "stale_version" | "malformed";
export type SnapshotResult =
  | Readonly<{ ok: true; snapshot: PolicySnapshot }>
  | Readonly<{ ok: false; reason: SnapshotFailure }>;

/** Domain-separation prefix: a signature over snapshot bytes can never be valid for another message type. */
export const SNAPSHOT_DOMAIN_TAG = "wb-policy-snapshot-v1\u0000";
const DEFAULT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const signedBytes = (payload: unknown): Uint8Array =>
  utf8(SNAPSHOT_DOMAIN_TAG + canonicalize(payload));

export function signSnapshot(snapshot: PolicySnapshot, secretKey: Uint8Array): SignedSnapshot {
  return { payload: snapshot, signature: toBase64url(sign(signedBytes(snapshot), secretKey)) };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isSnapshot(v: unknown): v is PolicySnapshot {
  if (!isRecord(v)) return false;
  const { tenantId, version, issuedAt, expiresAt, grants } = v;
  if (typeof tenantId !== "string" || tenantId === "") return false;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return false;
  if (![issuedAt, expiresAt].every((n) => typeof n === "number" && Number.isFinite(n)))
    return false;
  if (!isRecord(grants)) return false;
  return Object.keys(grants).every((role) => {
    const list = grants[role];
    return (
      isTenantRole(role) &&
      Array.isArray(list) &&
      list.every(
        (g) =>
          isRecord(g) &&
          isPermission(g.permission) &&
          !isPlatformPermission(g.permission) &&
          (g.conditions === undefined || isValidConditions(g.conditions)),
      )
    );
  });
}

/** Frozen deep copy so nothing the caller (or JSON parser) owns stays reachable. */
function freezeSnapshot(p: PolicySnapshot): PolicySnapshot {
  return Object.freeze({
    tenantId: p.tenantId,
    version: p.version,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    grants: freezeMatrix(Object.entries(p.grants)),
  });
}

/**
 * Signature first, then shape, tenant, validity window, version. Never throws.
 * Rollback/replay defence: the caller persists the highest `version` it has accepted per tenant
 * and passes it as `minVersion`; an older (e.g. pre-revocation) snapshot then fails `stale_version`.
 * `maxTtlMs` (default 7 days) caps `expiresAt - issuedAt`. Returns a frozen copy.
 */
export function verifySnapshot(
  signed: unknown,
  publicKey: Uint8Array,
  expect: Readonly<{ now: number; tenantId: string; minVersion?: number; maxTtlMs?: number }>,
): SnapshotResult {
  const fail = (reason: SnapshotFailure): SnapshotResult => ({ ok: false, reason });
  try {
    if (!Number.isFinite(expect.now)) return fail("malformed");
    if (!isRecord(signed) || !isRecord(signed.payload) || typeof signed.signature !== "string") {
      return fail("malformed");
    }
    const payload = signed.payload;
    let valid: boolean;
    try {
      valid = verify(fromBase64url(signed.signature), signedBytes(payload), publicKey);
    } catch {
      return fail("bad_signature");
    }
    if (!valid) return fail("bad_signature");
    if (!isSnapshot(payload)) return fail("malformed");
    if (payload.issuedAt >= payload.expiresAt) return fail("malformed");
    if (payload.expiresAt - payload.issuedAt > (expect.maxTtlMs ?? DEFAULT_MAX_TTL_MS)) {
      return fail("malformed");
    }
    if (payload.tenantId !== expect.tenantId) return fail("tenant_mismatch");
    if (expect.now >= payload.expiresAt) return fail("expired");
    if (expect.now < payload.issuedAt) return fail("not_yet_valid");
    if (expect.minVersion !== undefined && payload.version < expect.minVersion) {
      return fail("stale_version");
    }
    return { ok: true, snapshot: freezeSnapshot(payload) };
  } catch {
    return fail("malformed");
  }
}
