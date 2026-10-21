import fc from "fast-check";
import { describe, it } from "vitest";

import { GENESIS_HASH, link, verifyChain } from "./index.ts";

import type { ChainRow } from "./index.ts";

const chainArb = fc.array(fc.jsonValue(), { minLength: 1, maxLength: 40 }).map((payloads) => {
  const rows: ChainRow[] = [];
  let prev: string = GENESIS_HASH;
  for (const payload of payloads) {
    const hash = link(prev, payload);
    rows.push({ payload, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
});

const detected = (orig: readonly ChainRow[], mutated: readonly ChainRow[]): boolean => {
  const head = at(orig, orig.length - 1).hash;
  return !verifyChain(mutated, { expectedHead: head, expectedLength: orig.length }).ok;
};

describe("tamper detection", () => {
  it("any single edit / delete / insert / swap is detected", () => {
    fc.assert(
      fc.property(
        chainArb,
        fc.nat(),
        fc.constantFrom("edit", "delete", "insert", "swap"),
        fc.jsonValue(),
        (rows, r, kind, junk) => {
          const i = r % rows.length;
          const row = at(rows, i);
          let m: ChainRow[];
          if (kind === "edit") {
            m = rows.map((x, j) =>
              j === i ? { ...x, payload: { edited: junk, orig: x.payload } } : x,
            );
          } else if (kind === "delete") {
            m = rows.filter((_, j) => j !== i);
          } else if (kind === "insert") {
            const forged: ChainRow = {
              payload: junk,
              prevHash: row.prevHash,
              hash: link(row.prevHash, junk),
            };
            m = [...rows.slice(0, i), forged, ...rows.slice(i)];
          } else {
            const k = (i + 1) % rows.length;
            if (k === i) return true;
            m = [...rows];
            m[i] = at(rows, k);
            m[k] = row;
          }
          return detected(rows, m);
        },
      ),
      { seed: 20260101, numRuns: 300 },
    );
  });
});

function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error("index out of range");
  return v;
}
