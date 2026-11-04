import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub, MAX_BACKLOG_BYTES, MIN_GAP_MS } from "../src/hub.ts";

import type { Sink, Subscriber } from "../src/hub.ts";

const T1 = "0192f2a0-0000-7000-8000-000000000001";
const T2 = "0192f2a0-0000-7000-8000-000000000002";

function fakeSubscriber() {
  const handlers = new Map<string, (channel: string, message: string) => void>();
  const calls: string[] = [];
  const sub: Subscriber = {
    subscribe: (pattern, onMessage) => {
      calls.push(`sub ${pattern}`);
      handlers.set(pattern, onMessage);
      return Promise.resolve();
    },
    unsubscribe: (pattern) => {
      calls.push(`unsub ${pattern}`);
      handlers.delete(pattern);
      return Promise.resolve();
    },
  };
  /** What Redis does for a PSUBSCRIBE: deliver to the matching tenant pattern. */
  const publish = (tenantId: string, channel: string, message: string) => {
    handlers.get(`rt:${tenantId}:*`)?.(`rt:${tenantId}:${channel}`, message);
  };
  return { sub, publish, calls, handlers };
}

function fakeSink(backlog = 0) {
  const chunks: string[] = [];
  let ended = false;
  const sink: Sink = {
    write: (c) => chunks.push(c),
    end: () => {
      ended = true;
    },
    backlog: () => backlog,
  };
  return {
    sink,
    chunks,
    get ended() {
      return ended;
    },
  };
}

const hints = (chunk: string | undefined) =>
  (JSON.parse((chunk ?? "").split("data: ")[1] ?? "null") as { hints: unknown[] }).hints;
const msg = (dataset: string) => JSON.stringify({ dataset });

describe("Hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers a hint only to streams that hold the channel, within the tenant", async () => {
    const { sub, publish } = fakeSubscriber();
    const hub = new Hub(sub);
    const a = fakeSink();
    const b = fakeSink();
    const other = fakeSink();
    await hub.open(T1, ["all:prices"], a.sink);
    await hub.open(T1, ["all:catalog"], b.sink);
    await hub.open(T2, ["all:prices"], other.sink);
    publish(T1, "all:prices", msg("prices"));
    await vi.advanceTimersByTimeAsync(1);
    expect(hints(a.chunks[0])).toEqual([{ channel: "all:prices", dataset: "prices" }]);
    expect(b.chunks).toEqual([]);
    expect(other.chunks).toEqual([]);
  });

  it("sends the first hint at once, then at most 4 messages a second with hints coalesced", async () => {
    const { sub, publish } = fakeSubscriber();
    const hub = new Hub(sub);
    const s = fakeSink();
    await hub.open(T1, ["all:prices", "all:tax"], s.sink);
    publish(T1, "all:prices", msg("prices"));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.chunks).toHaveLength(1);
    // A burst of 100 hints inside the window: nothing is sent early, then one message carries the last of each channel.
    for (let i = 0; i < 100; i++)
      publish(T1, i % 2 === 0 ? "all:prices" : "all:tax", msg(i % 2 === 0 ? "prices" : "tax"));
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS - 10);
    expect(s.chunks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.chunks).toHaveLength(2);
    expect(hints(s.chunks[1])).toHaveLength(2);
    expect(hub.stats.coalesced).toBe(98);
    // Over 10 seconds of a steady 1 kHz stream the message rate stays at 4/s.
    s.chunks.length = 0;
    for (let ms = 0; ms < 10_000; ms++) {
      publish(T1, "all:prices", msg("prices"));
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(s.chunks.length).toBeLessThanOrEqual(41);
    expect(s.chunks.length).toBeGreaterThanOrEqual(38);
  });

  it("subscribes once per tenant and unsubscribes when its last stream closes", async () => {
    const { sub, calls } = fakeSubscriber();
    const hub = new Hub(sub);
    const a = await hub.open(T1, ["all:prices"], fakeSink().sink);
    const b = await hub.open(T1, ["all:tax"], fakeSink().sink);
    expect(calls).toEqual([`sub rt:${T1}:*`]);
    a.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([`sub rt:${T1}:*`]);
    b.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([`sub rt:${T1}:*`, `unsub rt:${T1}:*`]);
    expect(hub.snapshot()).toMatchObject({ streams: 0, tenants: 0 });
    // Closing twice is harmless.
    b.close();
    expect(hub.size).toBe(0);
  });

  it("ignores malformed or unknown notices", async () => {
    const { sub, publish, handlers } = fakeSubscriber();
    const hub = new Hub(sub);
    const s = fakeSink();
    await hub.open(T1, ["all:prices"], s.sink);
    publish(T1, "all:prices", "not json");
    publish(T1, "all:prices", msg("secrets"));
    publish(T1, "all:prices", JSON.stringify({ other: 1 }));
    publish(T1, "all:tax", msg("tax"));
    handlers.get(`rt:${T1}:*`)?.("garbage", msg("prices"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.chunks).toEqual([]);
    expect(hub.stats.hintsIn).toBe(0);
  });

  it("drops a client that cannot drain, and reports a failed subscription to the opener", async () => {
    const { sub, publish } = fakeSubscriber();
    const hub = new Hub(sub);
    const slow = fakeSink(MAX_BACKLOG_BYTES + 1);
    await hub.open(T1, ["all:prices"], slow.sink);
    publish(T1, "all:prices", msg("prices"));
    await vi.advanceTimersByTimeAsync(1);
    expect(slow.ended).toBe(true);
    expect(hub.stats.droppedSlow).toBe(1);
    expect(hub.size).toBe(0);

    const failing = new Hub({
      subscribe: () => Promise.reject(new Error("redis down")),
      unsubscribe: () => Promise.resolve(),
    });
    const s = fakeSink();
    await expect(failing.open(T1, ["all:prices"], s.sink)).rejects.toThrow("redis down");
    expect(s.ended).toBe(true);
    expect(failing.size).toBe(0);
  });

  it("heartbeats every open stream and closes all on shutdown", async () => {
    const { sub } = fakeSubscriber();
    const hub = new Hub(sub);
    const a = fakeSink();
    const b = fakeSink();
    await hub.open(T1, [], a.sink);
    await hub.open(T2, [], b.sink);
    hub.heartbeat();
    expect(a.chunks).toEqual([": ping\n\n"]);
    expect(b.chunks).toEqual([": ping\n\n"]);
    hub.closeAll();
    expect(a.ended && b.ended).toBe(true);
    expect(hub.size).toBe(0);
  });
});
