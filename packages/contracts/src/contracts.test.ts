import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Currency,
  Cursor,
  EventEnvelope,
  Money,
  PageQuery,
  PlatformContractsPingV1,
  Problem,
  Timestamp,
  Uuid7,
  defineEvent,
  listEvents,
  pageOf,
  registerRoute,
} from "./index.ts";

const ID = "0192f8c6-1234-7abc-8def-0123456789ab";

function table(schema: z.ZodType, ok: unknown[], bad: unknown[]) {
  for (const v of ok) expect(schema.safeParse(v).success, `accept ${JSON.stringify(v)}`).toBe(true);
  for (const v of bad)
    expect(schema.safeParse(v).success, `reject ${JSON.stringify(v)}`).toBe(false);
}

describe("common schemas", () => {
  it("Uuid7", () => {
    table(
      Uuid7,
      [ID],
      [ID.replace("-7abc", "-4abc"), ID.toUpperCase(), "x", 1, ID.replace("-8def", "-cdef")],
    );
  });
  it("Currency", () => {
    table(Currency, ["USD", "JPY", "KWD"], ["usd", "US", "USDD", "ZZZ", 1]);
  });
  it("Money", () => {
    table(
      Money,
      [
        { minor: 0, currency: "USD" },
        { minor: -5, currency: "JPY" },
      ],
      [
        { minor: 1.5, currency: "USD" },
        { minor: Number.MAX_SAFE_INTEGER + 1, currency: "USD" },
        { minor: 1, currency: "XXX9" },
        { minor: "1", currency: "USD" },
        { minor: 1 },
      ],
    );
  });
  it("Timestamp", () => {
    table(
      Timestamp,
      ["2026-10-18T09:21:44.120Z", "2026-10-18T09:21:44Z"],
      ["2026-10-18T09:21:44+02:00", "2026-10-18", "2026-13-18T09:21:44Z", 5],
    );
  });
  it("Cursor", () => {
    table(Cursor, ["abc_-123", "a".repeat(512)], ["", "a".repeat(513), "a+b/c=", 1]);
  });
  it("pageOf", () => {
    const P = pageOf(z.string());
    table(
      P,
      [
        { items: [], nextCursor: null },
        { items: ["a"], nextCursor: "abc" },
      ],
      [{ items: [1], nextCursor: null }, { items: [] }],
    );
  });
  it("PageQuery", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 50 });
    expect(PageQuery.parse({ limit: "200", after: "abc" })).toEqual({ limit: 200, after: "abc" });
    table(PageQuery, [], [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { after: "a b" }]);
  });
  it("Problem", () => {
    const base = {
      type: "https://errors.wise-biz.dev/internal",
      title: "Internal error",
      status: 500,
      code: "INTERNAL",
      detail: "Internal error",
      requestId: "r",
    };
    table(
      Problem,
      [base, { ...base, errors: [{ path: "a", message: "b" }] }],
      [
        { ...base, status: 200 },
        { ...base, code: "lower" },
        { ...base, errors: [{ path: "a" }] },
      ],
    );
  });
});

const envelope = {
  id: ID,
  type: "platform.contracts.ping",
  version: 1,
  source: "api/platform",
  tenantId: ID,
  branchId: null,
  subject: "ping/1",
  time: "2026-10-18T09:21:44.120Z",
  correlationId: "c1",
  actor: { type: "system", id: "cron" },
  data: { note: "hi" },
};

describe("events", () => {
  it("EventEnvelope accepts and rejects", () => {
    table(
      EventEnvelope,
      [
        envelope,
        { ...envelope, branchId: ID, causationId: "x" },
        { ...envelope, branchId: undefined },
      ],
      [
        { ...envelope, type: "Bad.Type" },
        { ...envelope, type: "a.b" },
        { ...envelope, version: 0 },
        { ...envelope, tenantId: "t" },
        { ...envelope, actor: { type: "robot", id: "x" } },
        { ...envelope, time: "yesterday" },
      ],
    );
  });

  it("defineEvent parses typed data and pins type/version", () => {
    const e = PlatformContractsPingV1.parse(envelope);
    expect(e.data.note).toBe("hi");
    expect(PlatformContractsPingV1.key).toBe("platform.contracts.ping@v1");
    expect(() => PlatformContractsPingV1.parse({ ...envelope, data: { note: 1 } })).toThrow();
    expect(() => PlatformContractsPingV1.parse({ ...envelope, version: 2 })).toThrow();
    expect(() => PlatformContractsPingV1.parse({ ...envelope, type: "a.b.c" })).toThrow();
    expect(Object.isFrozen(PlatformContractsPingV1)).toBe(true);
  });

  it("throws on duplicate, bad type, bad version", () => {
    expect(() => defineEvent("platform.contracts.ping", 1, z.object({}))).toThrow(/duplicate/);
    expect(() => defineEvent("nope", 1, z.object({}))).toThrow(/invalid event type/);
    expect(() => defineEvent("a.b.c", 0, z.object({}))).toThrow(/invalid event version/);
  });

  it("listEvents is sorted by key", () => {
    defineEvent("platform.contracts.zeta", 1, z.object({}));
    defineEvent("platform.contracts.alpha", 2, z.object({}));
    const keys = listEvents().map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("platform.contracts.ping@v1");
  });
});

describe("registerRoute", () => {
  it("returns its input", () => {
    const r = { method: "get", path: "/x", request: z.object({}), response: z.object({}) } as const;
    expect(registerRoute(r)).toBe(r);
  });
});
