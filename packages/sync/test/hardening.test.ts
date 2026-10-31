import { afterEach, describe, expect, it } from "vitest";

import { createHintStream } from "../src/hints.ts";
import { createPullLoop } from "../src/pull.ts";
import { createPushLoop, TransportError } from "../src/push.ts";
import { openLocalDb } from "../src/schema/migrations.ts";
import { createLocalDb } from "../src/storage/local-db.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";
import { createFakeFeed, gunzip } from "./support/fake-feed.ts";
import { createDevice, saleBody } from "./support/fake-server.ts";

import type { Timers } from "../src/backoff.ts";
import type { PushResponse, Transport } from "../src/push.ts";
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
const instant: Timers = {
  set: (fn) => {
    queueMicrotask(fn);
    return 0;
  },
  clear: () => undefined,
};
const real: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => {
    clearTimeout(h as never);
  },
};

describe("push loop hardening", () => {
  it("stop wins over a retry: nothing is sent after sign-out, and start allows a later run", async () => {
    const d = await device();
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(1)));
    let calls = 0;
    let release: (() => void) | undefined;
    const slow: Transport = {
      push: async () => {
        calls++;
        await new Promise<void>((r) => {
          release = r;
        });
        throw new TransportError("down", { status: 503 });
      },
    };
    const l = createPushLoop({
      outbox: d.outbox,
      transport: slow,
      timers: real,
      baseDelayMs: 60_000,
      random: () => 0.9,
    });
    const run = l.trigger();
    await new Promise((r) => setTimeout(r, 20));
    const stopping = l.stop(); // sign-out while a request is in flight
    release?.();
    await Promise.all([run, stopping]);
    expect(l.state()).toBe("stopped");
    expect(calls).toBe(1);
    l.start(); // signed in again
    expect(l.state()).toBe("idle");
  });

  it("a local write does not cut a backoff short, but networkUp does", async () => {
    const d = await device();
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(1)));
    let calls = 0;
    const t: Transport = {
      push: (c) => {
        calls++;
        return calls === 1
          ? Promise.reject(new TransportError("down", { status: 503 }))
          : d.server.push(c);
      },
    };
    const l = createPushLoop({
      outbox: d.outbox,
      transport: t,
      timers: real,
      baseDelayMs: 60_000,
      random: () => 0.9,
    });
    const run = l.trigger();
    await new Promise((r) => setTimeout(r, 20));
    void l.trigger();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    await Promise.all([l.networkUp(), run]);
    expect(calls).toBe(2);
    expect(await d.outbox.unsyncedCount()).toBe(0);
  });

  it("an answer that acknowledges nothing is a failed attempt, not a hot loop", async () => {
    const d = await device();
    await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(1)));
    let n = 0;
    const empty: Transport = {
      push: (c): Promise<PushResponse> =>
        ++n < 3 ? Promise.resolve({ acks: [], stopped: null, lastSeq: -1 }) : d.server.push(c),
    };
    const delays: number[] = [];
    const l = createPushLoop({
      outbox: d.outbox,
      transport: empty,
      timers: { set: (fn, ms) => (delays.push(ms), queueMicrotask(fn), 0), clear: () => undefined },
      random: () => 0.5,
    });
    await l.trigger();
    expect(delays).toEqual([500, 1000]);
    expect(await d.outbox.unsyncedCount()).toBe(0);
  });

  it("a server that keeps repeating the same gap ends as diverged after a few rewinds", async () => {
    const d = await device();
    for (let n = 0; n < 3; n++)
      await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(n)));
    await d.outbox.recordAcks([
      { seq: 0, status: "applied" },
      { seq: 1, status: "applied" },
    ]);
    let calls = 0;
    const stuck: Transport = {
      push: (): Promise<PushResponse> => {
        calls++;
        return Promise.resolve({
          acks: [{ seq: 2, status: "applied" }],
          stopped: { seq: 2, code: "SEQUENCE_GAP", expectedSeq: 0, quarantined: false },
          lastSeq: -1,
        });
      },
    };
    const events: string[] = [];
    const l = createPushLoop({
      outbox: d.outbox,
      transport: stuck,
      timers: instant,
      onEvent: (e) => events.push(e.type),
    });
    await l.trigger();
    expect(l.state()).toBe("blocked");
    expect(calls).toBeLessThanOrEqual(5);
    expect(events).toContain("blocked");
  });

  it("ignores answers about commands that were not in the batch", async () => {
    const d = await device();
    for (let n = 0; n < 3; n++)
      await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(n)));
    const r = await d.outbox.recordAcks(
      [
        { seq: 0, status: "applied" },
        { seq: 2, status: "applied" },
      ],
      [0, 1],
    );
    expect(r).toEqual({ acked: 1, rejected: 0 });
    expect((await d.outbox.allPending()).map((c) => c.seq)).toEqual([1, 2]);
  });
});

describe("pull loop hardening", () => {
  it("a feed that promises more pages without moving the cursor is an error, not an endless loop", async () => {
    const db = await openLocalDb(betterSqliteAdapter());
    try {
      const feed = createFakeFeed();
      feed.changes = () => Promise.resolve({ changes: [], nextCursor: null, hasMore: true });
      const errors: unknown[] = [];
      const loop = createPullLoop({
        db,
        transport: feed,
        gunzip,
        datasets: ["prices"],
        timers: { set: (fn) => (queueMicrotask(fn), 0), clear: () => undefined },
        onEvent: (e) => {
          if (e.type === "error") {
            errors.push(e.error);
            void loop.stop();
          }
        },
      });
      await loop.request();
      expect((errors[0] as Error).message).toMatch(/no progress/);
    } finally {
      await db.close();
    }
  });

  it("refuses a snapshot beyond the device limit", async () => {
    const db = await openLocalDb(betterSqliteAdapter());
    try {
      const feed = createFakeFeed();
      feed.upsert("prices", "price", "a", { n: 1 });
      const errors: unknown[] = [];
      const loop = createPullLoop({
        db,
        transport: feed,
        gunzip: () => Promise.resolve({ length: 300 * 1024 * 1024 } as Uint8Array),
        datasets: ["prices"],
        timers: { set: (fn) => (queueMicrotask(fn), 0), clear: () => undefined },
        onEvent: (e) => {
          if (e.type === "error") {
            errors.push(e.error);
            void loop.stop();
          }
        },
      });
      await loop.request();
      expect((errors[0] as Error).message).toMatch(/larger than the device accepts/);
    } finally {
      await db.close();
    }
  });
});

describe("hint stream and storage hardening", () => {
  it("stop during the ticket request ends the stream instead of hanging", async () => {
    let releaseTicket: (() => void) | undefined;
    let opened = 0;
    const hs = createHintStream({
      ticket: () =>
        new Promise((resolve) => {
          releaseTicket = () => {
            resolve({ token: "t", url: "https://rt.test" });
          };
        }),
      open: () => {
        opened++;
        return Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield "";
          })(),
        );
      },
      onReady: () => undefined,
      onHints: () => undefined,
      timers: real,
    });
    hs.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopping = hs.stop();
    releaseTicket?.();
    await stopping;
    expect(hs.state()).toBe("stopped");
    expect(opened).toBe(0);
    hs.start(); // a later sign-in may start it again
    await new Promise((r) => setTimeout(r, 10));
    const again = hs.stop();
    releaseTicket?.();
    await again;
  });

  it("a failed rollback poisons the connection instead of corrupting later work", async () => {
    const adapter = betterSqliteAdapter();
    const db = createLocalDb(adapter);
    await db.exec("create table t (n integer)");
    adapter.rollback = () => Promise.reject(new Error("disk gone"));
    await expect(
      db.transaction(async (tx) => {
        await tx.run("insert into t values (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(db.run("insert into t values (2)")).rejects.toThrow(
      /unusable after a failed rollback/,
    );
  });
});
