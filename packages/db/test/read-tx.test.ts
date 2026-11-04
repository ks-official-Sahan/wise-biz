import { describe, expect, it, vi } from "vitest";

import { isReplicaUnavailable, withReadTx } from "../src/read-tx.ts";

import type pg from "pg";

const ctx = { tenantId: "01900000-0000-7000-8000-000000000001", requestId: "req-12345678" };

/** A pool whose connect() hands out one client that answers every query with `answer`, or throws `fail`. */
function fakePool(opts: { connectFail?: Error; queryFail?: Error }): pg.Pool & { used: number } {
  const state = { used: 0 };
  const client = {
    query: vi.fn((sql: string) => {
      if (
        opts.queryFail !== undefined &&
        !/^(begin|commit|rollback)/i.test(sql) &&
        !sql.includes("set_config")
      )
        return Promise.reject(opts.queryFail);
      return Promise.resolve({ rows: [{ ok: true }], rowCount: 1 });
    }),
    release: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    get used() {
      return state.used;
    },
    connect: () => {
      state.used += 1;
      return opts.connectFail === undefined
        ? Promise.resolve(client)
        : Promise.reject(opts.connectFail);
    },
  } as unknown as pg.Pool & { used: number };
}

const err = (code: string | undefined, message = "boom") =>
  Object.assign(new Error(message), { code });

describe("isReplicaUnavailable", () => {
  it("is true for network, connection and shutdown errors, false for query errors", () => {
    expect(isReplicaUnavailable(err("ECONNREFUSED"))).toBe(true);
    expect(isReplicaUnavailable(err("57P01"))).toBe(true);
    expect(isReplicaUnavailable(err("08006"))).toBe(true);
    expect(isReplicaUnavailable(err("53300"))).toBe(true);
    expect(isReplicaUnavailable(err(undefined, "Connection terminated unexpectedly"))).toBe(true);
    expect(isReplicaUnavailable(err("42601", "syntax error"))).toBe(false);
    expect(isReplicaUnavailable(err("42501", "permission denied"))).toBe(false);
    expect(isReplicaUnavailable("nope")).toBe(false);
  });
});

describe("withReadTx", () => {
  it("reads from the replica when there is one", async () => {
    const primary = fakePool({});
    const replica = fakePool({});
    await withReadTx(primary, replica, ctx, (tx) => tx.query("select 1"));
    expect(replica.used).toBe(1);
    expect(primary.used).toBe(0);
  });

  it("uses the primary when there is no replica", async () => {
    const primary = fakePool({});
    await withReadTx(primary, undefined, ctx, (tx) => tx.query("select 1"));
    expect(primary.used).toBe(1);
  });

  it("falls back to the primary once when the replica is unreachable, and says so", async () => {
    const primary = fakePool({});
    const replica = fakePool({ connectFail: err("ECONNREFUSED") });
    const onFallback = vi.fn();
    const r = await withReadTx(primary, replica, ctx, (tx) => tx.query("select 1"), onFallback);
    expect(r.rows).toEqual([{ ok: true }]);
    expect(primary.used).toBe(1);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("does not hide a query error by retrying it on the primary", async () => {
    const primary = fakePool({});
    const replica = fakePool({ queryFail: err("42601", "syntax error") });
    await expect(
      withReadTx(primary, replica, ctx, (tx) => tx.query("select nope")),
    ).rejects.toThrow(/syntax/);
    expect(primary.used).toBe(0);
  });
});
