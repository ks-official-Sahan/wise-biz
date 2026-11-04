import { describe, expect, it } from "vitest";

import { createPullLoop } from "../src/pull.ts";
import { TransportError } from "../src/push.ts";
import { openLocalDb } from "../src/schema/migrations.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";
import { createFakeFeed, gunzip } from "./support/fake-feed.ts";

import type { Timers } from "../src/backoff.ts";

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
 * Randomized chaos over pulling: the server keeps changing (upserts, deletes, compaction that invalidates cursors),
 * requests fail at random, pages are small. After the server goes quiet and one more pull succeeds, the device must
 * hold exactly the server's state, whatever happened on the way.
 */
describe("pull chaos", () => {
  it("converges to the server state across 300 randomized runs", { timeout: 300_000 }, async () => {
    for (let seed = 1; seed <= Number(process.env.CHAOS_RUNS ?? 300); seed++) {
      const rnd = prng(seed);
      const db = await openLocalDb(betterSqliteAdapter());
      try {
        const feed = createFakeFeed();
        feed.etag = rnd() < 0.5;
        feed.beforeChanges = () => {
          const r = rnd();
          if (r < 0.1) throw new TransportError("down", { status: 0 });
          if (r < 0.15) throw new TransportError("busy", { status: 503 });
        };
        const loop = createPullLoop({
          db,
          transport: feed,
          gunzip,
          datasets: ["catalog", "prices"],
          pageSize: 1 + Math.floor(rnd() * 12),
          timers: instant,
          random: rnd,
        });
        const steps = 5 + Math.floor(rnd() * 25);
        for (let s = 0; s < steps; s++) {
          const dataset = rnd() < 0.5 ? "catalog" : "prices";
          const entity = dataset === "catalog" ? "variant" : "price";
          const id = `e${String(Math.floor(rnd() * 15))}`;
          const r = rnd();
          if (r < 0.7) {
            feed.upsert(
              dataset,
              entity,
              id,
              dataset === "catalog"
                ? { variantId: id, name: `item ${String(s)}`, sku: id, archived: rnd() < 0.1 }
                : { n: s },
            );
          } else if (r < 0.9) feed.remove(dataset, entity, id);
          else feed.compact();
          if (rnd() < 0.4) void loop.request(rnd() < 0.5 ? [dataset] : undefined);
          if (rnd() < 0.2) await loop.request();
        }
        feed.beforeChanges = undefined;
        await loop.request();
        for (const dataset of ["catalog", "prices"] as const) {
          const rows = await db.all<{ entity: string; entity_id: string; payload: string }>(
            "select entity, entity_id, payload from entities where dataset = ?",
            [dataset],
          );
          const local = new Map(
            rows.map((r) => [`${r.entity}/${r.entity_id}`, JSON.parse(r.payload) as unknown]),
          );
          expect(local, `seed ${String(seed)} ${dataset}`).toEqual(feed.state(dataset));
        }
        // The search index agrees with the catalog: one row per live, unarchived variant.
        const want = [...feed.state("catalog").values()].filter(
          (v) => !(v as { archived: boolean }).archived,
        ).length;
        const got = await db.get<{ n: number }>("select count(*) as n from variant_search");
        expect(got?.n, `seed ${String(seed)} search`).toBe(want);
      } finally {
        await db.close();
      }
    }
  });
});
