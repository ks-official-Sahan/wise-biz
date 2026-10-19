// HMAC-SHA256 test cases (RFC 4231 section 4, cases 1-4, 6, 7). Case 5 (truncated) is absent
// from the fetched file, so no truncated case runs; the comparison is still prefix-based.
// Source: pyca/cryptography vectors/cryptography_vectors/HMAC/rfc-4231-sha256.txt
//   https://raw.githubusercontent.com/pyca/cryptography/main/vectors/cryptography_vectors/HMAC/rfc-4231-sha256.txt
// Data: ./rfc4231-sha256.json (byte-exact text of the source file under "text")
import { describe, expect, it } from "vitest";

import { fromHex, hmacSha256, toHex } from "../../src/index.ts";

import rfc4231 from "./rfc4231-sha256.json";

interface HmacCase {
  key: string;
  msg: string;
  md: string;
}

function parseCases(text: string): HmacCase[] {
  const cases: HmacCase[] = [];
  let key = "";
  let msg = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Key = ")) key = line.slice("Key = ".length);
    else if (line.startsWith("Msg = ")) msg = line.slice("Msg = ".length);
    else if (line.startsWith("MD = ")) cases.push({ key, msg, md: line.slice("MD = ".length) });
  }
  return cases;
}

const cases = parseCases(rfc4231.text);

describe("HMAC-SHA256 RFC 4231 vectors", () => {
  it("loads cases 1-4, 6 and 7", () => {
    expect(cases).toHaveLength(6);
  });

  it.each(cases.map((c, i) => ({ ...c, n: i + 1 })))(
    "case $n: HMAC matches the MD (prefix for truncated)",
    ({ key, msg, md }) => {
      const mac = toHex(hmacSha256(fromHex(key), fromHex(msg)));
      expect(mac.slice(0, md.length)).toBe(md);
    },
  );
});
