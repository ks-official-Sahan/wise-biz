import { isDomainError } from "@wise-biz/errors";
import { describe, expect, it, vi } from "vitest";

import {
  billingPeriod,
  classOf,
  createMemoryStore,
  createQuotaGate,
  createUsageReader,
  guardFromEnv,
  guardStore,
  r2AccountOf,
} from "../src/index.ts";

import type { QuotaEnv, QuotaLimits } from "../src/index.ts";

const small: QuotaLimits = { storageBytes: 1000, classA: 10, classB: 20 };
const ACCOUNT = "0123456789abcdef0123456789abcdef";

function clock(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

describe("billingPeriod", () => {
  it("runs from the anchor day to the same day next month, in UTC", () => {
    const p = billingPeriod(new Date("2026-11-20T10:00:00Z"), 6);
    expect(p.start.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-12-06T00:00:00.000Z");
  });
  it("is still the previous month before the anchor day, and wraps the year", () => {
    const p = billingPeriod(new Date("2027-01-03T00:00:00Z"), 6);
    expect(p.start.toISOString()).toBe("2026-12-06T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2027-01-06T00:00:00.000Z");
  });
  it("clamps the anchor to 1..28", () => {
    expect(billingPeriod(new Date("2026-11-30T00:00:00Z"), 31).start.getUTCDate()).toBe(28);
    expect(billingPeriod(new Date("2026-11-30T00:00:00Z"), 0).start.getUTCDate()).toBe(1);
  });
});

describe("classOf", () => {
  it("follows the R2 pricing page; unknown actions count as the dearer class", () => {
    expect(classOf("PutObject")).toBe("classA");
    expect(classOf("ListObjectsV2")).toBe("classA");
    expect(classOf("GetObject")).toBe("classB");
    expect(classOf("HeadObject")).toBe("classB");
    expect(classOf("DeleteObject")).toBe("free");
    expect(classOf("SomethingNew")).toBe("classA");
  });
});

describe("quota gate", () => {
  it("refuses the call that would pass the cap, with a stable code", () => {
    const gate = createQuotaGate({ limits: small });
    for (let i = 0; i < 10; i++) gate.admit("classA");
    let err: unknown;
    try {
      gate.admit("classA");
    } catch (e) {
      err = e;
    }
    expect(isDomainError(err) && err.code).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(isDomainError(err) && err.details).toEqual({ metric: "classA", limit: 10 });
    gate.admit("classB");
  });

  it("refuses an upload whose bytes would pass the storage cap, but not a read", () => {
    const gate = createQuotaGate({ limits: small });
    gate.admit("classA", 900);
    expect(() => {
      gate.admit("classA", 200);
    }).toThrow(/monthly limit/);
    gate.admit("classB");
  });

  it("reports ok, warn at 80%, blocked at the cap, and calls onLevel once per change", () => {
    const onLevel = vi.fn<(m: string, l: string, s: unknown) => void>();
    const gate = createQuotaGate({ limits: small, onLevel });
    for (let i = 0; i < 7; i++) gate.admit("classA");
    expect(gate.status().level).toBe("ok");
    gate.admit("classA");
    expect(gate.status().metrics.classA.level).toBe("warn");
    gate.admit("classA");
    gate.admit("classA");
    expect(gate.status().level).toBe("blocked");
    expect(onLevel.mock.calls.map(([m, l]) => [m, l])).toEqual([
      ["classA", "warn"],
      ["classA", "blocked"],
    ]);
  });

  it("takes Cloudflare's reading as the base and adds its own recent calls on top", () => {
    const c = clock("2026-11-10T12:00:00Z");
    const gate = createQuotaGate({ limits: small, now: c.now, lagMs: 10 * 60_000 });
    gate.admit("classA", 100);
    c.advance(30 * 60_000);
    gate.apply({ classA: 4, classB: 0, storageBytes: 500 });
    // the call above is 30 minutes old: the reading has it, so it is not added again
    expect(gate.status().metrics.classA.used).toBe(4);
    expect(gate.status().metrics.storage.used).toBe(500);
    gate.admit("classA", 50);
    expect(gate.status().metrics.classA.used).toBe(5);
    expect(gate.status().metrics.storage.used).toBe(550);
    // a reading taken now may not include the call just made: it stays counted
    gate.apply({ classA: 4, classB: 0, storageBytes: 500 });
    expect(gate.status().metrics.classA.used).toBe(5);
  });

  it("resets operation counts, not stored bytes, when the billing period turns", () => {
    const c = clock("2026-12-05T23:59:00Z");
    const gate = createQuotaGate({ limits: small, now: c.now, periodAnchorDay: 6 });
    gate.apply({ classA: 10, classB: 5, storageBytes: 700 });
    expect(gate.status().level).toBe("blocked");
    c.advance(2 * 60_000);
    const s = gate.status();
    expect(s.periodStart).toBe("2026-12-06T00:00:00.000Z");
    expect(s.metrics.classA.used).toBe(0);
    expect(s.metrics.classB.used).toBe(0);
    expect(s.metrics.storage.used).toBe(700);
    expect(s.measuredAt).not.toBeNull();
  });

  it("starts with no reading: measuredAt is null", () => {
    expect(createQuotaGate({ limits: small }).status().measuredAt).toBeNull();
  });
});

describe("guardStore", () => {
  it("counts reads and writes, refuses past the cap, and never blocks a delete", async () => {
    const gate = createQuotaGate({ limits: { storageBytes: 100, classA: 2, classB: 2 } });
    const mem = createMemoryStore();
    const s = guardStore(mem, gate);
    await s.put("k", "hello", "text/plain");
    expect(
      s.presignPut("k2", { contentType: "a", contentLength: 10, expiresSeconds: 5 }),
    ).toContain("memory://put/");
    expect(() =>
      s.presignPut("k3", { contentType: "a", contentLength: 1, expiresSeconds: 5 }),
    ).toThrow();
    await expect(s.put("k4", new Uint8Array(1), "a")).rejects.toThrow();
    await s.get("k");
    s.presignGet("k", 5);
    expect(() => s.presignGet("k", 5)).toThrow();
    await s.delete("k");
    expect(mem.objects.has("k")).toBe(false);
  });
});

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("createUsageReader", () => {
  const ops = {
    data: {
      viewer: {
        accounts: [
          {
            r2OperationsAdaptiveGroups: [
              { sum: { requests: 100 }, dimensions: { actionType: "PutObject" } },
              { sum: { requests: 40 }, dimensions: { actionType: "ListObjectsV2" } },
              { sum: { requests: 900 }, dimensions: { actionType: "GetObject" } },
              { sum: { requests: 5000 }, dimensions: { actionType: "DeleteObject" } },
            ],
          },
        ],
      },
    },
  };
  const storage = {
    data: {
      viewer: {
        accounts: [
          {
            r2StorageAdaptiveGroups: [
              {
                max: { payloadSize: 10, metadataSize: 1 },
                dimensions: { datetime: "2026-11-10T00:00:00Z", bucketName: "a" },
              },
              {
                max: { payloadSize: 500, metadataSize: 5 },
                dimensions: { datetime: "2026-11-11T00:00:00Z", bucketName: "a" },
              },
              {
                max: { payloadSize: 200, metadataSize: 0 },
                dimensions: { datetime: "2026-11-11T00:00:00Z", bucketName: "b" },
              },
            ],
          },
        ],
      },
    },
  };

  it("sums operations by class and the newest storage sample of every bucket", async () => {
    const calls: { auth: string | null; vars: unknown }[] = [];
    const f = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { query: string; variables: unknown };
      calls.push({ auth: new Headers(init?.headers).get("authorization"), vars: body.variables });
      return reply(body.query.includes("r2Operations") ? ops : storage);
    });
    const read = createUsageReader({
      accountId: ACCOUNT,
      apiToken: "tok",
      periodAnchorDay: 6,
      fetch: f,
      now: () => new Date("2026-11-12T00:00:00Z"),
    });
    expect(await read()).toEqual({ classA: 140, classB: 900, storageBytes: 705 });
    expect(calls[0]?.auth).toBe("Bearer tok");
    expect(calls[0]?.vars).toMatchObject({ account: ACCOUNT, from: "2026-11-06T00:00:00.000Z" });
  });

  it("fails on an HTTP error and on a GraphQL error", async () => {
    const mk = (r: () => Promise<Response>) =>
      createUsageReader({
        accountId: ACCOUNT,
        apiToken: "t",
        periodAnchorDay: 1,
        fetch: r,
      });
    await expect(mk(() => reply({}, 403))()).rejects.toThrow("403");
    await expect(mk(() => reply({ errors: [{ message: "denied" }] }))()).rejects.toThrow("denied");
    // errors: null is Cloudflare's normal success shape; an answer with no account is not zero usage
    await expect(mk(() => reply({ data: null, errors: null }))()).rejects.toThrow("no account");
    await expect(mk(() => reply({ data: { viewer: { accounts: [] } } }))()).rejects.toThrow(
      "no account",
    );
    expect(await mk(() => reply({ data: { viewer: { accounts: [{}] } }, errors: null }))()).toEqual(
      { classA: 0, classB: 0, storageBytes: 0 },
    );
  });
});

describe("createUsageReader timeout", () => {
  it("gives every request a deadline", async () => {
    let signal: AbortSignal | null | undefined;
    const f = vi.fn((_u: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return reply({ data: { viewer: { accounts: [{}] } } });
    });
    await createUsageReader({
      accountId: ACCOUNT,
      apiToken: "t",
      periodAnchorDay: 1,
      fetch: f,
    })();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("r2AccountOf", () => {
  it("reads the account from an R2 endpoint and nothing else", () => {
    expect(r2AccountOf(`https://${ACCOUNT}.r2.cloudflarestorage.com`)).toBe(ACCOUNT);
    expect(r2AccountOf(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`)).toBe(ACCOUNT);
    expect(r2AccountOf("http://localhost:9000")).toBeUndefined();
    expect(r2AccountOf(undefined)).toBeUndefined();
  });
});

describe("guardFromEnv", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const env: QuotaEnv = {
    STORAGE_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    R2_LIMIT_STORAGE_BYTES: 1000,
    R2_LIMIT_CLASS_A: 2,
    R2_LIMIT_CLASS_B: 2,
    R2_PERIOD_ANCHOR_DAY: 1,
  };

  it("leaves a store that is not R2 alone", async () => {
    const mem = createMemoryStore();
    const g = guardFromEnv(mem, { ...env, STORAGE_ENDPOINT: "http://localhost:9000" }, { logger });
    expect(g.store).toBe(mem);
    await g.start();
    g.stop();
  });

  it("without a token guards on its own calls and warns once", async () => {
    const onBlocked = vi.fn();
    const g = guardFromEnv(createMemoryStore(), env, { logger, onBlocked });
    await g.start();
    expect(logger.warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("CLOUDFLARE_ANALYTICS_TOKEN"),
    );
    g.store.presignGet("k", 1);
    g.store.presignGet("k", 1);
    expect(() => g.store.presignGet("k", 1)).toThrow();
    expect(onBlocked).toHaveBeenCalledWith("classB", expect.objectContaining({ limit: 2 }));
  });

  it("drops operation counts read across a period change, and keeps the storage level", async () => {
    let t = Date.UTC(2026, 10, 5, 23, 59); // the period turns on the 6th
    const f = vi.fn((_u: unknown, init?: RequestInit) => {
      const q = (JSON.parse(init?.body as string) as { query: string }).query;
      t = Date.UTC(2026, 10, 6, 0, 1); // the read finishes after midnight
      const acct = (g: object) => reply({ data: { viewer: { accounts: [g] } } });
      return q.includes("r2Operations")
        ? acct({
            r2OperationsAdaptiveGroups: [
              { sum: { requests: 2 }, dimensions: { actionType: "GetObject" } },
            ],
          })
        : acct({
            r2StorageAdaptiveGroups: [
              {
                max: { payloadSize: 400, metadataSize: 0 },
                dimensions: { datetime: "2026-11-05T23:00:00Z", bucketName: "b" },
              },
            ],
          });
    });
    const g = guardFromEnv(
      createMemoryStore(),
      { ...env, R2_PERIOD_ANCHOR_DAY: 6, CLOUDFLARE_ANALYTICS_TOKEN: "t" },
      { logger, fetch: f, now: () => new Date(t) },
    );
    await g.start();
    g.stop();
    const m = g.gate.status().metrics;
    expect(m.classB.used).toBe(0);
    expect(m.storage.used).toBe(400);
  });

  it("reads Cloudflare at start and keeps going when a read fails", async () => {
    let fail = false;
    const f = vi.fn((_u: unknown, init?: RequestInit) => {
      if (fail) return reply({}, 500);
      const q = (JSON.parse(init?.body as string) as { query: string }).query;
      return reply(
        q.includes("r2Operations")
          ? {
              data: {
                viewer: {
                  accounts: [
                    {
                      r2OperationsAdaptiveGroups: [
                        { sum: { requests: 2 }, dimensions: { actionType: "GetObject" } },
                      ],
                    },
                  ],
                },
              },
            }
          : { data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [] }] } } },
      );
    });
    const g = guardFromEnv(
      createMemoryStore(),
      { ...env, CLOUDFLARE_ANALYTICS_TOKEN: "t" },
      { logger, fetch: f, everyMs: 5 },
    );
    await g.start();
    expect(g.gate.status().metrics.classB.used).toBe(2);
    expect(() => g.store.presignGet("k", 1)).toThrow();
    fail = true;
    await new Promise((r) => setTimeout(r, 30));
    g.stop();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      expect.stringContaining("could not read"),
    );
    expect(g.gate.status().metrics.classB.used).toBe(2);
  });
});
