import { fromBase64url, sha256, sign, toBase64url, utf8, verify } from "@wise-biz/crypto";

import type { Bytes } from "@wise-biz/crypto";

/**
 * A fixed RFC 9421 (HTTP Message Signatures) profile for terminal requests, with an RFC 9530 `Content-Digest`.
 * One label (`wb`), one algorithm (`ed25519`) and one covered component list, so the server never negotiates
 * what a client chose to sign. The signature base is built exactly as RFC 9421 §2.5 specifies.
 */

export const LABEL = "wb";
export const ALG = "ed25519";
export const COMPONENTS = [
  "@method",
  "@path",
  "content-digest",
  "x-wb-timestamp",
  "x-wb-nonce",
  "x-wb-device-id",
] as const;
/** RFC 9421 leaves skew to the verifier; terminals sync their clock with each heartbeat. */
export const MAX_SKEW_SECONDS = 300;
/** Nonces live a little longer than the skew window, so a replay inside the window is always caught. */
export const NONCE_TTL_SECONDS = 2 * MAX_SKEW_SECONDS + 60;

const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SignInput {
  readonly method: string;
  /** Path only (`@path`): no query, no origin. */
  readonly path: string;
  readonly body?: Bytes | string | undefined;
  readonly deviceId: string;
  readonly secretKey: Bytes;
  /** Seconds since the epoch. Defaults to the clock. */
  readonly now?: number;
  /** Defaults to 16 random bytes, base64url. */
  readonly nonce?: string;
}

export type SignedHeaders = Readonly<
  Record<
    | "content-digest"
    | "x-wb-timestamp"
    | "x-wb-nonce"
    | "x-wb-device-id"
    | "signature-input"
    | "signature",
    string
  >
>;

export type VerifyFailure =
  | "missing"
  | "malformed"
  | "skew"
  | "digest_mismatch"
  | "unknown_device"
  | "bad_signature"
  | "replay";

export type VerifyResult =
  | { readonly ok: true; readonly deviceId: string; readonly created: number }
  | { readonly ok: false; readonly reason: VerifyFailure };

export interface NonceStore {
  /** Records the key for `ttlSeconds`; false when it already exists (Redis `SET key 1 NX EX ttl`). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface VerifyInput {
  readonly method: string;
  readonly path: string;
  readonly header: (name: string) => string | null | undefined;
  readonly body?: Bytes | string | undefined;
  /** The device's active public key, or null when unknown. Status checks belong to the caller. */
  readonly publicKeyOf: (deviceId: string) => Promise<Bytes | null>;
  readonly nonces: NonceStore;
  readonly now?: number;
  readonly maxSkewSeconds?: number;
}

/** Standard base64 with padding, as RFC 8941 byte sequences require. */
export function toBase64(b: Bytes): string {
  const s = toBase64url(b).replace(/-/g, "+").replace(/_/g, "/");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

export function fromBase64(s: string): Bytes {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error("bad base64");
  return fromBase64url(s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
}

const bodyBytes = (body: Bytes | string | undefined): Bytes =>
  body === undefined ? new Uint8Array(0) : typeof body === "string" ? utf8(body) : body;

/** RFC 9530 `Content-Digest` for the body (an empty body digests the empty string). */
export function contentDigest(body: Bytes | string | undefined): string {
  return `sha-256=:${toBase64(sha256(bodyBytes(body)))}:`;
}

function signatureParams(created: number, keyid: string): string {
  const list = COMPONENTS.map((c) => `"${c}"`).join(" ");
  return `(${list});created=${String(created)};keyid="${keyid}";alg="${ALG}"`;
}

/** RFC 9421 §2.5 signature base: one line per covered component, then `@signature-params`. */
export function signatureBase(
  values: Readonly<Record<(typeof COMPONENTS)[number], string>>,
  params: string,
): string {
  const lines = COMPONENTS.map((c) => `"${c}": ${values[c]}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toBase64url(b);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function signRequest(input: SignInput): SignedHeaders {
  const created = input.now ?? nowSeconds();
  const nonce = input.nonce ?? randomNonce();
  const digest = contentDigest(input.body);
  const params = signatureParams(created, input.deviceId);
  const base = signatureBase(
    {
      "@method": input.method.toUpperCase(),
      "@path": input.path,
      "content-digest": digest,
      "x-wb-timestamp": String(created),
      "x-wb-nonce": nonce,
      "x-wb-device-id": input.deviceId,
    },
    params,
  );
  return {
    "content-digest": digest,
    "x-wb-timestamp": String(created),
    "x-wb-nonce": nonce,
    "x-wb-device-id": input.deviceId,
    "signature-input": `${LABEL}=${params}`,
    signature: `${LABEL}=:${toBase64(sign(base, input.secretKey))}:`,
  };
}

const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });

/**
 * Verifies a signed terminal request. Cheap checks run first (shape, skew, digest), then the key lookup and the
 * signature, and the nonce is claimed last, so a forged request can never burn a real device's nonce.
 */
export async function verifyRequest(input: VerifyInput): Promise<VerifyResult> {
  const get = (n: string): string | undefined => input.header(n) ?? undefined;
  const digest = get("content-digest");
  const ts = get("x-wb-timestamp");
  const nonce = get("x-wb-nonce");
  const deviceId = get("x-wb-device-id");
  const sigInput = get("signature-input");
  const sig = get("signature");
  if (
    digest === undefined ||
    ts === undefined ||
    nonce === undefined ||
    deviceId === undefined ||
    sigInput === undefined ||
    sig === undefined
  ) {
    return fail("missing");
  }

  if (!/^\d{1,12}$/.test(ts) || !NONCE.test(nonce) || !DEVICE_ID.test(deviceId))
    return fail("malformed");
  const created = Number(ts);
  // The client's parameters must be exactly the fixed profile: no other components, algorithm or key.
  const params = signatureParams(created, deviceId);
  if (sigInput !== `${LABEL}=${params}`) return fail("malformed");
  const sigMatch = /^wb=:([A-Za-z0-9+/]+={0,2}):$/.exec(sig);
  if (sigMatch?.[1] === undefined) return fail("malformed");

  const now = input.now ?? nowSeconds();
  if (Math.abs(now - created) > (input.maxSkewSeconds ?? MAX_SKEW_SECONDS)) return fail("skew");
  if (digest !== contentDigest(input.body)) return fail("digest_mismatch");

  let signature: Bytes;
  try {
    signature = fromBase64(sigMatch[1]);
  } catch {
    return fail("malformed");
  }
  const publicKey = await input.publicKeyOf(deviceId);
  if (publicKey === null) return fail("unknown_device");

  const base = signatureBase(
    {
      "@method": input.method.toUpperCase(),
      "@path": input.path,
      "content-digest": digest,
      "x-wb-timestamp": ts,
      "x-wb-nonce": nonce,
      "x-wb-device-id": deviceId,
    },
    params,
  );
  if (!verify(signature, base, publicKey)) return fail("bad_signature");
  if (!(await input.nonces.claim(`${deviceId}:${nonce}`, NONCE_TTL_SECONDS))) return fail("replay");
  return { ok: true, deviceId, created };
}
