import { afterEach, describe, expect, it } from "vitest";

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

describe("parseCsvAsync with a Worker", () => {
  const big = `sku,name\n${"S1,Tea\n".repeat(60_000)}`;
  const original = globalThis.Worker;
  afterEach(() => {
    globalThis.Worker = original;
  });

  /** A Worker whose script fails to load. */
  class BrokenWorker {
    onerror: ((e: { preventDefault(): void }) => void) | null = null;
    onmessage: unknown = null;
    postMessage(): void {
      queueMicrotask(() => this.onerror?.({ preventDefault: () => undefined }));
    }
    terminate = (): undefined => undefined;
  }

  it("parses inline when the worker fails to start", async () => {
    globalThis.Worker = BrokenWorker as unknown as typeof Worker;
    expect(await parseCsvAsync(big)).toHaveLength(60_001);
  });

  it("does not start a worker for an already aborted signal", async () => {
    let started = 0;
    globalThis.Worker = class {
      readonly started = ++started;
    } as unknown as typeof Worker;
    const ctl = new AbortController();
    ctl.abort();
    await expect(parseCsvAsync(big, ctl.signal)).rejects.toThrow(/aborted/i);
    expect(started).toBe(0);
  });
});

describe("parseCsv row cap", () => {
  it("applies to an unterminated final row", async () => {
    await expect(parseCsvAsync("a\n".repeat(200_000) + "a")).rejects.toThrow(/too many rows/);
  });
});
