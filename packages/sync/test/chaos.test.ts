import { describe, expect, it } from "vitest";

import { createPushLoop, TransportError } from "../src/push.ts";

import { chaosRuns } from "./support/budget.ts";
import { createDevice, saleBody } from "./support/fake-server.ts";

import type { Timers } from "../src/backoff.ts";
import type { PushResponse, Transport } from "../src/push.ts";

/** mulberry32: a seeded PRNG so every failing run can be replayed from its number. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const instant: Timers = {
  set: (fn) => {
    queueMicrotask(fn);
    return 0;
  },
  clear: () => undefined,
};

/**
 * Randomized chaos over the whole client path: commands are enqueued while the loop runs, requests fail before or
 * after the server applied them (lost answers), batches are cut short, 5xx and network errors come at random.
 * Invariant after the dust settles: the server applied every command exactly once, in order, and the outbox is empty.
 */
describe("push chaos", () => {
  it(
    "zero lost or duplicated commands across randomized runs (1,000; fewer on shared CI)",
    { timeout: 300_000 },
    async () => {
      for (let seed = 1; seed <= chaosRuns; seed++) {
        const rnd = prng(seed);
        const d = await createDevice();
        try {
          const total = 3 + Math.floor(rnd() * 40);
          const rejectAt = new Set(
            Array.from({ length: Math.floor(rnd() * 3) }, () => Math.floor(rnd() * total)),
          );
          const faulty: Transport = {
            push: async (cmds): Promise<PushResponse> => {
              const roll = rnd();
              if (roll < 0.15) throw new TransportError("down", { status: 0 }); // never reached the server
              if (roll < 0.25) throw new TransportError("busy", { status: 503 });
              // A shorter prefix reaches the server (a batch cut by a proxy), in order.
              const cut = rnd() < 0.2 ? Math.max(1, Math.floor(rnd() * cmds.length)) : cmds.length;
              const res = await d.server.push(cmds.slice(0, cut));
              if (rnd() < 0.2) throw new TransportError("answer lost", { status: 0 }); // applied, answer lost
              return res;
            },
          };
          const loop = createPushLoop({
            outbox: d.outbox,
            transport: faulty,
            random: rnd,
            timers: instant,
            batchLimit: 1 + Math.floor(rnd() * 20),
          });
          let enqueued = 0;
          while (enqueued < total) {
            const burst = 1 + Math.floor(rnd() * 5);
            for (let i = 0; i < burst && enqueued < total; i++, enqueued++) {
              await d.outbox.transaction((tx) =>
                tx.enqueue(
                  "complete_sale",
                  saleBody(enqueued, rejectAt.has(enqueued) ? { reject: true } : {}),
                ),
              );
            }
            if (rnd() < 0.6) void loop.trigger(); // overlapping triggers while commands keep arriving
            if (rnd() < 0.3) await loop.trigger();
          }
          await loop.trigger();
          for (let i = 0; i < 50 && (await d.outbox.unsyncedCount()) > 0; i++) await loop.trigger();

          const ids = [...d.server.applied, ...d.server.rejected];
          expect(await d.outbox.unsyncedCount(), `seed ${String(seed)}`).toBe(0);
          expect(new Set(ids).size, `seed ${String(seed)}: duplicates`).toBe(ids.length);
          expect(ids.length, `seed ${String(seed)}: lost`).toBe(total);
          expect(d.server.lastSeq(), `seed ${String(seed)}`).toBe(total - 1);
          // Applied in sequence order: ids are sale-N with N = seq.
          const order = [...d.server.applied, ...d.server.rejected]
            .map((id) => Number(id.slice(5)))
            .sort((a, b) => a - b);
          expect(order).toEqual(Array.from({ length: total }, (_, i) => i));
          expect(d.server.quarantined()).toBe(false);
        } finally {
          await d.close();
        }
      }
    },
  );
});
