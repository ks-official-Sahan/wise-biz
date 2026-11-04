import { afterEach, describe, expect, it } from "vitest";

import { createPushLoop, TransportError } from "../src/push.ts";

import { createDevice, saleBody } from "./support/fake-server.ts";

import type { Timers } from "../src/backoff.ts";
import type { WireCommand } from "../src/chain.ts";
import type { LoopEvent, PushResponse, Transport } from "../src/push.ts";
import type { Device } from "./support/fake-server.ts";

const open: Device[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close().catch(() => undefined);
});
const device = async () => {
  const d = await createDevice();
  open.push(d);
  return d;
};
const enqueue = async (d: Device, n: number, extra: Record<string, unknown> = {}) => {
  for (let i = 0; i < n; i++) {
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(i, extra)));
  }
};

/** Timers that fire at once and remember the delays they were asked for. */
const instantTimers = (): Timers & { delays: number[] } => {
  const delays: number[] = [];
  return {
    delays,
    set: (fn, ms) => {
      delays.push(ms);
      queueMicrotask(fn);
      return 0;
    },
    clear: () => undefined,
  };
};

const loop = (
  d: Device,
  transport: Transport,
  extra: Partial<Parameters<typeof createPushLoop>[0]> = {},
) => {
  const events: LoopEvent[] = [];
  const timers = instantTimers();
  const l = createPushLoop({
    outbox: d.outbox,
    transport,
    onEvent: (e) => events.push(e),
    random: () => 0.5,
    timers,
    ...extra,
  });
  return { l, events, timers };
};

const fail = (
  status: number,
  code?: string,
  more: { retryAfterMs?: number; details?: unknown } = {},
) => new TransportError("boom", { status, ...(code ? { code } : {}), ...more });

describe("push loop", () => {
  it(
    "sends the outbox oldest first in batches of 100 and acknowledges everything",
    { timeout: 60_000 },
    async () => {
      const d = await device();
      await enqueue(d, 250);
      const { l, events } = loop(d, d.server);
      await l.trigger();
      expect(d.server.requests.map((r) => [r.length, r[0], r.at(-1)])).toEqual([
        [100, 0, 99],
        [100, 100, 199],
        [50, 200, 249],
      ]);
      expect(d.server.applied).toHaveLength(250);
      expect(await d.outbox.unsyncedCount()).toBe(0);
      expect(l.state()).toBe("idle");
      expect(events.at(-1)).toEqual({ type: "idle" });
      expect(events.filter((e) => e.type === "pushed")).toHaveLength(3);
    },
  );

  it("does nothing, and sends nothing, when the outbox is empty", async () => {
    const d = await device();
    const { l } = loop(d, d.server);
    await l.trigger();
    expect(d.server.calls).toBe(0);
  });

  it("a lost answer is recovered by resending: the server replays, nothing is applied twice", async () => {
    const d = await device();
    await enqueue(d, 5);
    let lose = true;
    const lossy: Transport = {
      push: async (c) => {
        const res = await d.server.push(c);
        if (lose) {
          lose = false;
          throw fail(0);
        }
        return res;
      },
    };
    const { l, events, timers } = loop(d, lossy);
    await l.trigger();
    expect(d.server.applied).toEqual(["sale-0", "sale-1", "sale-2", "sale-3", "sale-4"]);
    expect(await d.outbox.unsyncedCount()).toBe(0);
    expect(events.find((e) => e.type === "backoff")).toMatchObject({ attempt: 1 });
    expect(timers.delays).toHaveLength(1);
  });

  it("backs off exponentially with jitter on 5xx and network errors, and resets after a success", async () => {
    const d = await device();
    await enqueue(d, 1);
    let failures = 4;
    const flaky: Transport = {
      push: (c) =>
        failures-- > 0 ? Promise.reject(fail(failures % 2 ? 503 : 0)) : d.server.push(c),
    };
    const { l, timers } = loop(d, flaky, { baseDelayMs: 1000, maxDelayMs: 5000 });
    await l.trigger();
    // random() = 0.5: half of min(cap, base * 2^attempt)
    expect(timers.delays).toEqual([500, 1000, 2000, 2500]);
    expect(await d.outbox.unsyncedCount()).toBe(0);
  });

  it("honours Retry-After when it is longer than the backoff", async () => {
    const d = await device();
    await enqueue(d, 1);
    let first = true;
    const limited: Transport = {
      push: (c) => {
        if (first) {
          first = false;
          return Promise.reject(fail(429, "RATE_LIMITED", { retryAfterMs: 30_000 }));
        }
        return d.server.push(c);
      },
    };
    const { l, timers } = loop(d, limited);
    await l.trigger();
    expect(timers.delays).toEqual([30_000]);
  });

  it("stops on 401 (auth) without losing anything, and resumes after a new sign-in", async () => {
    const d = await device();
    await enqueue(d, 3);
    let signedIn = false;
    const t: Transport = {
      push: (c) => (signedIn ? d.server.push(c) : Promise.reject(fail(401, "UNAUTHENTICATED"))),
    };
    const { l, events } = loop(d, t);
    await l.trigger();
    expect(l.state()).toBe("auth");
    expect(events.some((e) => e.type === "auth_required")).toBe(true);
    await l.trigger(); // a trigger does not retry while waiting for sign-in
    expect(d.server.calls).toBe(0);
    signedIn = true;
    await l.resume();
    expect(l.state()).toBe("idle");
    expect(await d.outbox.unsyncedCount()).toBe(0);
  });

  it("blocks when the server suspends the device, keeps the outbox, and resumes after re-enrolment", async () => {
    const d = await device();
    await enqueue(d, 2);
    const revoked: Transport = {
      push: () => Promise.reject(fail(401, "DEVICE_INACTIVE")),
    };
    const { l, events } = loop(d, revoked);
    await l.trigger();
    expect(l.state()).toBe("blocked");
    expect(events.find((e) => e.type === "blocked")).toMatchObject({
      reason: "quarantined",
      code: "DEVICE_INACTIVE",
    });
    expect(await d.outbox.unsyncedCount()).toBe(2);
    await l.stop();
    expect(l.state()).toBe("stopped");
  });

  it("a response that stops the batch after some acks keeps those acks and blocks", async () => {
    const d = await device();
    await enqueue(d, 3);
    const half: Transport = {
      push: (c): Promise<PushResponse> =>
        Promise.resolve({
          acks: [{ seq: c[0]?.body.meta.deviceSeq ?? 0, status: "applied" }],
          stopped: { seq: 1, code: "BAD_SIGNATURE", quarantined: true },
          lastSeq: 0,
        }),
    };
    const { l, events } = loop(d, half);
    await l.trigger();
    expect(l.state()).toBe("blocked");
    expect(events.find((e) => e.type === "blocked")).toMatchObject({ code: "BAD_SIGNATURE" });
    expect(await d.outbox.unsyncedCount()).toBe(2);
  });

  it("a server that lost its tail gets the missing commands again, in order", async () => {
    const d = await device();
    await enqueue(d, 6);
    const { l, events } = loop(d, d.server);
    await l.trigger();
    d.server.loseAfter(2); // restored from a backup: it only knows seq 0..2
    for (const n of [100, 101])
      await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(n))); // new work: seq 6, 7 -> the server answers SEQUENCE_GAP expecting 3
    await l.trigger();
    expect(events.find((e) => e.type === "rewound")).toEqual({
      type: "rewound",
      fromSeq: 3,
      commands: 3,
    });
    expect(d.server.lastSeq()).toBe(7);
    expect(await d.outbox.unsyncedCount()).toBe(0);
  });

  it("a gap it cannot fill is reported as diverged instead of looping", async () => {
    const d = await device();
    await enqueue(d, 3);
    const gap: Transport = {
      push: () => Promise.reject(fail(409, "SEQUENCE_GAP", { details: { expectedSeq: 99 } })),
    };
    const { l, events } = loop(d, gap);
    await l.trigger();
    expect(events.find((e) => e.type === "blocked")).toMatchObject({ reason: "diverged" });
    expect(d.server.calls).toBe(0);
    // A rejected command is not rewound either: same outcome, no hot loop.
    const noRows: Transport = {
      push: () => Promise.reject(fail(409, "SEQUENCE_GAP", { details: {} })),
    };
    const second = loop(d, noRows);
    await second.l.trigger();
    expect(second.events.find((e) => e.type === "blocked")).toMatchObject({ reason: "diverged" });
    const sameSeq: Transport = {
      push: () => Promise.reject(fail(409, "SEQUENCE_GAP", { details: { expectedSeq: 0 } })),
    };
    const third = loop(d, sameSeq);
    await third.l.trigger();
    expect(third.events.find((e) => e.type === "blocked")).toMatchObject({ reason: "diverged" });
  });

  it("halves the batch on 413 and never reorders", async () => {
    const d = await device();
    await enqueue(d, 40, { pad: "x".repeat(100) });
    const picky: Transport = {
      push: (c) =>
        c.length > 10 ? Promise.reject(fail(413, "PAYLOAD_TOO_LARGE")) : d.server.push(c),
    };
    const { l } = loop(d, picky);
    await l.trigger();
    expect(await d.outbox.unsyncedCount()).toBe(0);
    const flat = d.server.requests.flat();
    expect(flat).toEqual([...flat].sort((a, b) => a - b));
    expect(d.server.requests.every((r) => r.length <= 10)).toBe(true);
  });

  it("blocks on a request-level refusal (422) rather than skipping a command", async () => {
    const d = await device();
    await enqueue(d, 2);
    const { l, events } = loop(d, { push: () => Promise.reject(fail(422, "VALIDATION_FAILED")) });
    await l.trigger();
    expect(events.find((e) => e.type === "blocked")).toMatchObject({ reason: "refused" });
    expect(await d.outbox.unsyncedCount()).toBe(2);
  });

  it("a command the server rejects stays visible and the chain moves on", async () => {
    const d = await device();
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(0)));
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(1, { reject: true })));
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(2)));
    const { l, events } = loop(d, d.server);
    await l.trigger();
    expect(events.find((e) => e.type === "pushed")).toMatchObject({ acked: 2, rejected: 1 });
    expect((await d.outbox.rejected()).map((r) => r.id)).toEqual(["sale-1"]);
    expect(d.server.applied).toEqual(["sale-0", "sale-2"]);
    expect(await d.outbox.unsyncedCount()).toBe(0);
  });

  it(
    "coalesces triggers while running, wakes a backoff early, yields to the UI between batches",
    { timeout: 60_000 },
    async () => {
      const d = await device();
      await enqueue(d, 150);
      let yields = 0;
      let first = true;
      const t: Transport = {
        push: (c: readonly WireCommand[]) => {
          if (first) {
            first = false;
            return Promise.reject(fail(503));
          }
          return d.server.push(c);
        },
      };
      // Real timers with a long delay: only trigger() can end the wait.
      const real: Timers = {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => {
          clearTimeout(h as never);
        },
      };
      const { l } = loop(d, t, {
        timers: real,
        baseDelayMs: 60_000,
        random: () => 0.99,
        yieldToUi: () => {
          yields++;
          return Promise.resolve();
        },
      });
      const run = l.trigger();
      await new Promise((r) => setTimeout(r, 30));
      expect(l.state()).toBe("backoff");
      const again = l.networkUp(); // network is back
      await Promise.all([run, again]);
      expect(await d.outbox.unsyncedCount()).toBe(0);
      expect(yields).toBeGreaterThanOrEqual(1);
    },
  );

  it("stop ends a backoff wait and later triggers do nothing", async () => {
    const d = await device();
    await enqueue(d, 1);
    const real: Timers = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => {
        clearTimeout(h as never);
      },
    };
    const { l } = loop(
      d,
      { push: () => Promise.reject(fail(503)) },
      { timers: real, baseDelayMs: 60_000, random: () => 0.99 },
    );
    const run = l.trigger();
    await new Promise((r) => setTimeout(r, 30));
    await l.stop();
    await run;
    expect(l.state()).toBe("stopped");
    await l.trigger();
    expect(await d.outbox.unsyncedCount()).toBe(1);
  });

  it("a trigger that arrives while pushing leads to another pass over new work", async () => {
    const d = await device();
    await enqueue(d, 1);
    let injected = false;
    const t: Transport = {
      push: async (c) => {
        if (!injected) {
          injected = true;
          await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(50)));
          void l.trigger();
        }
        return d.server.push(c);
      },
    };
    const { l } = loop(d, t);
    await l.trigger();
    expect(d.server.applied).toEqual(["sale-0", "sale-50"]);
  });
});
