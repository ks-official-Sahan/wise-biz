// Ed25519 vectors.
//
// 1. pyca/cryptography Ed25519/sign.input, first 64 lines (djb SUPERCOP set). Entry 1 is stated
//    to equal RFC 8032 section 7.1 TEST 1; rfc-editor.org was unreachable so that was not
//    cross-checked. Line format: sk||pk:pk:msg:sig:
//    https://raw.githubusercontent.com/pyca/cryptography/main/vectors/cryptography_vectors/asymmetric/Ed25519/sign.input
//    Data: ./ed25519-sign-first64.json
// 2. Wycheproof ed25519_test.json (valid/invalid only; "acceptable" skipped).
//    https://raw.githubusercontent.com/C2SP/wycheproof/main/testvectors_v1/ed25519_test.json
//    Data: ./ed25519-wycheproof.json
import { describe, expect, it } from "vitest";

import { fromHex, publicKeyFrom, sign, toHex, verify } from "../../src/index.ts";

import signData from "./ed25519-sign-first64.json";
import wycheproof from "./ed25519-wycheproof.json";

import type { Bytes } from "../../src/index.ts";

interface SignEntry {
  line: number;
  seed: Bytes;
  pk: Bytes;
  msg: Bytes;
  sig: Bytes;
  tailMsg: string;
}

// Line format: sk||pk:pk:msg:sig||msg: (sig is the first 128 hex chars of field 4).
function parseSignLines(text: string): SignEntry[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l, i) => {
      const [skpk = "", pk = "", msg = "", sigAndMsg = ""] = l.split(":");
      return {
        line: i + 1,
        seed: fromHex(skpk.slice(0, 64)),
        pk: fromHex(pk),
        msg: fromHex(msg),
        sig: fromHex(sigAndMsg.slice(0, 128)),
        tailMsg: sigAndMsg.slice(128),
      };
    });
}

/** Returns a copy with the lowest bit of byte 0 flipped. */
function flipFirstBit(b: Bytes): Bytes {
  const out = new Uint8Array(b);
  out[0] = (out[0] ?? 0) ^ 1;
  return out;
}

const entries = parseSignLines(signData.text);

describe("Ed25519 sign.input (first 64 entries)", () => {
  it("loads exactly 64 entries", () => {
    expect(entries).toHaveLength(64);
  });

  it.each(entries)("line $line: sig||msg tail equals the message field", ({ msg, tailMsg }) => {
    expect(tailMsg).toBe(toHex(msg));
  });

  it.each(entries)("line $line: publicKeyFrom(seed) equals pk", ({ seed, pk }) => {
    expect(publicKeyFrom(seed)).toEqual(pk);
  });

  it.each(entries)(
    "line $line: sign(msg, seed) is deterministic and equals sig",
    ({ msg, seed, sig }) => {
      expect(sign(msg, seed)).toEqual(sig);
    },
  );

  it.each(entries)("line $line: verify accepts the published signature", ({ msg, pk, sig }) => {
    expect(verify(sig, msg, pk)).toBe(true);
  });

  it.each(entries)(
    "line $line: a one-bit flip in the signature is rejected",
    ({ msg, pk, sig }) => {
      expect(verify(flipFirstBit(sig), msg, pk)).toBe(false);
    },
  );

  it.each(entries.filter((e) => e.msg.length > 0))(
    "line $line: a one-bit flip in the message is rejected",
    ({ msg, pk, sig }) => {
      expect(verify(sig, flipFirstBit(msg), pk)).toBe(false);
    },
  );
});

interface WycheproofCase {
  id: number;
  comment: string;
  msg: Bytes;
  sig: Bytes;
  pk: Bytes;
  valid: boolean;
}

const wycheproofCases: WycheproofCase[] = wycheproof.testGroups.flatMap((group) =>
  group.tests
    .filter((t) => t.result === "valid" || t.result === "invalid")
    .map((t) => ({
      id: t.tcId,
      comment: t.comment,
      msg: fromHex(t.msg),
      sig: fromHex(t.sig),
      pk: fromHex(group.publicKey.pk),
      valid: t.result === "valid",
    })),
);

describe("Ed25519 Wycheproof valid/invalid cases", () => {
  it.each(wycheproofCases)(
    "tcId $id ($comment): verify matches expected result",
    ({ msg, sig, pk, valid }) => {
      expect(verify(sig, msg, pk)).toBe(valid);
    },
  );
});
