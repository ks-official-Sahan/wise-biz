import { generateKeyPair } from "@wise-biz/crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_SKEW_SECONDS,
  NONCE_TTL_SECONDS,
  contentDigest,
  fromBase64,
  signRequest,
  signatureBase,
  toBase64,
  verifyRequest,
} from "./signatures.ts";

import type { NonceStore, SignedHeaders, VerifyInput } from "./signatures.ts";

const DEVICE = "0192f4a1-7c3e-7a10-8b2c-1d2e3f405162";
const NOW = 1_761_600_000;
const keys = generateKeyPair();
const body = JSON.stringify({ lines: [{ sku: "rice", qty: 2 }] });

function memoryNonces(): NonceStore & { keys: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    keys: map,
    claim(key, ttl) {
      if (map.has(key)) return Promise.resolve(false);
      map.set(key, ttl);
      return Promise.resolve(true);
    },
  };
}

function verifyWith(
  headers: Partial<Record<keyof SignedHeaders, string | undefined>>,
  over: Partial<VerifyInput> = {},
) {
  return verifyRequest({
    method: "POST",
    path: "/v1/sales",
    header: (n) => (headers as Record<string, string | undefined>)[n],
    body,
    publicKeyOf: (id) => Promise.resolve(id === DEVICE ? keys.publicKey : null),
    nonces: memoryNonces(),
    now: NOW,
    ...over,
  });
}

const signed = (over: Partial<Parameters<typeof signRequest>[0]> = {}): SignedHeaders =>
  signRequest({
    method: "post",
    path: "/v1/sales",
    body,
    deviceId: DEVICE,
    secretKey: keys.secretKey,
    now: NOW,
    ...over,
  });

describe("content-digest (RFC 9530)", () => {
  it("matches the RFC 9530 example and the empty body", () => {
    expect(contentDigest('{"hello": "world"}')).toBe(
      "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
    );
    expect(contentDigest(undefined)).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
  });

  it("round-trips standard base64 and rejects other alphabets", () => {
    const b = new Uint8Array([0, 251, 255, 1, 2]);
    expect(fromBase64(toBase64(b))).toEqual(b);
    expect(() => fromBase64("a_b-")).toThrow();
    expect(() => fromBase64("abc")).toThrow();
  });
});

describe("signature base (RFC 9421 §2.5)", () => {
  it("lists every component then @signature-params", () => {
    const h = signed({ nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    const base = signatureBase(
      {
        "@method": "POST",
        "@path": "/v1/sales",
        "content-digest": h["content-digest"],
        "x-wb-timestamp": String(NOW),
        "x-wb-nonce": "AAAAAAAAAAAAAAAAAAAAAA",
        "x-wb-device-id": DEVICE,
      },
      h["signature-input"].slice(3),
    );
    expect(base.split("\n")).toEqual([
      '"@method": POST',
      '"@path": /v1/sales',
      `"content-digest": ${h["content-digest"]}`,
      `"x-wb-timestamp": ${String(NOW)}`,
      '"x-wb-nonce": AAAAAAAAAAAAAAAAAAAAAA',
      `"x-wb-device-id": ${DEVICE}`,
      `"@signature-params": ("@method" "@path" "content-digest" "x-wb-timestamp" "x-wb-nonce" "x-wb-device-id");created=${String(NOW)};keyid="${DEVICE}";alg="ed25519"`,
    ]);
  });
});

describe("verifyRequest", () => {
  it("accepts a signed request and claims its nonce once", async () => {
    const nonces = memoryNonces();
    const h = signed();
    expect(await verifyWith(h, { nonces })).toEqual({ ok: true, deviceId: DEVICE, created: NOW });
    expect([...nonces.keys]).toEqual([[`${DEVICE}:${h["x-wb-nonce"]}`, NONCE_TTL_SECONDS]]);
  });

  it("rejects an unsigned request", async () => {
    expect(await verifyWith({})).toEqual({ ok: false, reason: "missing" });
    expect(await verifyWith({ ...signed(), signature: undefined })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects a wrong key", async () => {
    const other = generateKeyPair();
    expect(await verifyWith(signed({ secretKey: other.secretKey }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered body", async () => {
    expect(await verifyWith(signed(), { body: body.replace("2", "9") })).toEqual({
      ok: false,
      reason: "digest_mismatch",
    });
  });

  it("rejects a tampered digest header even when it matches the new body", async () => {
    const tampered = body.replace("2", "9");
    const h = { ...signed(), "content-digest": contentDigest(tampered) };
    expect(await verifyWith(h, { body: tampered })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a replayed nonce", async () => {
    const nonces = memoryNonces();
    const h = signed();
    expect((await verifyWith(h, { nonces })).ok).toBe(true);
    expect(await verifyWith(h, { nonces })).toEqual({ ok: false, reason: "replay" });
  });

  it("rejects a skewed timestamp either way, and accepts the edge", async () => {
    expect(await verifyWith(signed({ now: NOW - MAX_SKEW_SECONDS - 1 }))).toEqual({
      ok: false,
      reason: "skew",
    });
    expect(await verifyWith(signed({ now: NOW + MAX_SKEW_SECONDS + 1 }))).toEqual({
      ok: false,
      reason: "skew",
    });
    expect((await verifyWith(signed({ now: NOW - MAX_SKEW_SECONDS }))).ok).toBe(true);
  });

  it("rejects another method or path", async () => {
    expect((await verifyWith(signed(), { method: "PUT" })).ok).toBe(false);
    expect((await verifyWith(signed(), { path: "/v1/sales/x" })).ok).toBe(false);
  });

  it("rejects an unknown device without claiming the nonce", async () => {
    const nonces = memoryNonces();
    const id = "0192f4a1-7c3e-7a10-8b2c-ffffffffffff";
    expect(await verifyWith(signed({ deviceId: id }), { nonces })).toEqual({
      ok: false,
      reason: "unknown_device",
    });
    expect(nonces.keys.size).toBe(0);
  });

  it("does not burn a nonce on a bad signature", async () => {
    const nonces = memoryNonces();
    const h = signed({ secretKey: generateKeyPair().secretKey });
    await verifyWith(h, { nonces });
    expect(nonces.keys.size).toBe(0);
  });

  it("rejects any change to the signed parameters", async () => {
    const h = signed();
    const cases: Partial<SignedHeaders>[] = [
      { "signature-input": h["signature-input"].replace('alg="ed25519"', 'alg="hmac-sha256"') },
      { "signature-input": h["signature-input"].replace('"@path" ', "") },
      { "x-wb-timestamp": String(NOW + 1) },
      { "x-wb-device-id": "not-a-uuid" },
      { "x-wb-nonce": "short" },
      { "x-wb-timestamp": "12.5" },
      { signature: "wb=:not base64:" },
      { signature: "other=:AAAA:" },
      { signature: "wb=:AAAAA===:" },
    ];
    for (const c of cases) expect((await verifyWith({ ...h, ...c })).ok).toBe(false);
  });

  it("signs an empty body", async () => {
    const h = signed({ body: undefined, method: "GET", path: "/v1/devices/me" });
    expect(
      (await verifyWith(h, { body: undefined, method: "GET", path: "/v1/devices/me" })).ok,
    ).toBe(true);
  });

  it("uses the clock and a random nonce by default", async () => {
    const h = signRequest({
      method: "POST",
      path: "/v1/x",
      body: "{}",
      deviceId: DEVICE,
      secretKey: keys.secretKey,
    });
    expect(h["x-wb-nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const r = await verifyRequest({
      method: "POST",
      path: "/v1/x",
      header: (n) => (h as Record<string, string>)[n],
      body: new TextEncoder().encode("{}"),
      publicKeyOf: () => Promise.resolve(keys.publicKey),
      nonces: memoryNonces(),
    });
    expect(r.ok).toBe(true);
  });
});
