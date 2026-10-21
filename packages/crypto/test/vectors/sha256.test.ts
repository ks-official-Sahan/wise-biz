// SHA-256 NIST CAVS vectors: byte-aligned entries only (Len % 8 == 0). For Len = 0 the file
// carries Msg = 00, which is treated as the empty message. The 1,000,000 x "a" digest is not in
// the fetched files, so it is not tested.
// Source: pyca/cryptography vectors/cryptography_vectors/hashes/SHA2/
//   https://raw.githubusercontent.com/pyca/cryptography/main/vectors/cryptography_vectors/hashes/SHA2/SHA256ShortMsg.rsp
//   https://raw.githubusercontent.com/pyca/cryptography/main/vectors/cryptography_vectors/hashes/SHA2/SHA256LongMsg.rsp
// Data: ./sha256-short.json, ./sha256-long.json (byte-exact text of each file under "text")
import { describe, expect, it } from "vitest";

import { fromHex, sha256, toHex } from "../../src/index.ts";

import longData from "./sha256-long.json";
import shortData from "./sha256-short.json";

interface ShaCase {
  len: number;
  msg: string;
  md: string;
}

function parseRsp(text: string): ShaCase[] {
  const cases: ShaCase[] = [];
  let len = -1;
  let msg = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Len = ")) len = Number(line.slice("Len = ".length));
    else if (line.startsWith("Msg = ")) msg = line.slice("Msg = ".length);
    else if (line.startsWith("MD = ")) {
      if (len % 8 === 0) {
        // Len bits = Len/4 hex chars; drops the placeholder "00" when Len = 0.
        cases.push({ len, msg: msg.slice(0, len / 4), md: line.slice("MD = ".length) });
      }
    }
  }
  return cases;
}

const shortCases = parseRsp(shortData.text);
const longCases = parseRsp(longData.text);

describe("SHA-256 NIST ShortMsg (byte-aligned)", () => {
  it("loads 65 byte-aligned entries", () => {
    expect(shortCases).toHaveLength(65);
  });

  it.each(shortCases.map((c, i) => ({ ...c, n: i + 1 })))(
    "short $n (Len $len bits): digest matches",
    ({ msg, md }) => {
      expect(toHex(sha256(fromHex(msg)))).toBe(md);
    },
  );
});

describe("SHA-256 NIST LongMsg (byte-aligned)", () => {
  it("loads 64 byte-aligned entries", () => {
    expect(longCases).toHaveLength(64);
  });

  it.each(longCases.map((c, i) => ({ ...c, n: i + 1 })))(
    "long $n (Len $len bits): digest matches",
    ({ msg, md }) => {
      expect(toHex(sha256(fromHex(msg)))).toBe(md);
    },
  );
});
