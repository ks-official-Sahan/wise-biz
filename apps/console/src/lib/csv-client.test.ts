import { describe, expect, it } from "vitest";

import { parseCsvAsync } from "./csv-client.ts";

describe("parseCsvAsync", () => {
  it("parses a small file inline, with quoted fields", async () => {
    expect(await parseCsvAsync('a,b\r\n"x, y",2\n')).toEqual([
      ["a", "b"],
      ["x, y", "2"],
    ]);
  });

  it("falls back to inline parsing for a large file when Worker is unavailable", async () => {
    const body = `sku,name\n${"S1,Tea\n".repeat(60_000)}`;
    expect(body.length).toBeGreaterThan(256 * 1024);
    const rows = await parseCsvAsync(body);
    expect(rows).toHaveLength(60_001);
  });

  it("reports a file with too many rows", async () => {
    await expect(parseCsvAsync("a\n".repeat(200_002))).rejects.toThrow(/too many rows/);
  });
});
