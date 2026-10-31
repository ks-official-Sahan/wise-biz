import { afterEach, describe, expect, it } from "vitest";

import { applySnapshot, createPullLoop, parseSnapshot } from "../src/pull.ts";
import { TransportError } from "../src/push.ts";
import { openLocalDb } from "../src/schema/migrations.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";
import { createFakeFeed, gunzip } from "./support/fake-feed.ts";

import type { Timers } from "../src/backoff.ts";
import type { PullChange, PullEvent, PullOptions } from "../src/pull.ts";
import type { LocalDb } from "../src/storage/local-db.ts";

const dbs: LocalDb[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close().catch(() => undefined);
});
const newDb = async () => {
  const db = await openLocalDb(betterSqliteAdapter());
  dbs.push(db);
  return db;
};

const instant: Timers & { delays: number[] } = {
  delays: [],
  set(fn, ms) {
    this.delays.push(ms);
    queueMicrotask(fn);
    return 0;
  },
  clear: () => undefined,
};

const variant = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  variantId: id,
  productId: "p1",
  name,
  sku: `SKU-${id}`,
  archived: false,
  ...extra,
});

async function setup(extra: Partial<PullOptions> = {}) {
  const db = await newDb();
  const feed = createFakeFeed();
  const events: PullEvent[] = [];
  const applied: { dataset: string; changes: readonly PullChange[] }[] = [];
  const resets: string[] = [];
  instant.delays.length = 0;
  const loop = createPullLoop({
    db,
    transport: feed,
    gunzip,
    datasets: ["catalog", "prices"],
    onEvent: (e) => events.push(e),
    onChanges: (dataset, changes) => applied.push({ dataset, changes }),
    onReset: (d) => resets.push(d),
    timers: instant,
    random: () => 0.5,
    ...extra,
  });
  return { db, feed, loop, events, applied, resets };
}

const localState = async (db: LocalDb, dataset: string) => {
  const rows = await db.all<{ entity: string; entity_id: string; payload: string }>(
    "select entity, entity_id, payload from entities where dataset = ? order by entity, entity_id",
    [dataset],
  );
  return new Map(rows.map((r) => [`${r.entity}/${r.entity_id}`, JSON.parse(r.payload) as unknown]));
};

describe("pull loop", () => {
  it("bootstraps from the snapshot on first run, then continues from its cursor", async () => {
    const { db, feed, loop, events, resets } = await setup();
    feed.upsert("catalog", "variant", "v1", variant("v1", "Green Tea"));
    feed.upsert("catalog", "variant", "v2", variant("v2", "Black Tea"));
    await loop.request(["catalog"]);
    expect(feed.calls).toMatchObject({ bootstrap: 1, download: 1 });
    expect(await localState(db, "catalog")).toEqual(feed.state("catalog"));
    expect(resets).toEqual(["catalog"]);
    expect(events).toContainEqual({ type: "bootstrapped", dataset: "catalog", entities: 2 });
    // New server data arrives as a delta, not another snapshot.
    feed.upsert("catalog", "variant", "v3", variant("v3", "Oolong"));
    await loop.request(["catalog"]);
    expect(feed.calls.bootstrap).toBe(1);
    expect(await localState(db, "catalog")).toEqual(feed.state("catalog"));
    expect(await loop.pendingBootstrap()).toEqual(["prices"]);
  });

  it("pages through thousands of changes without repeats, committing the cursor with each page", async () => {
    const { db, feed, loop, applied } = await setup({ pageSize: 500 });
    await loop.request(["prices"]); // bootstrapped empty
    for (let i = 0; i < 2500; i++) feed.upsert("prices", "price", `p${String(i)}`, { n: i });
    await loop.request(["prices"]);
    expect(applied.map((a) => a.changes.length)).toEqual([500, 500, 500, 500, 500]);
    expect((await localState(db, "prices")).size).toBe(2500);
    expect(await localState(db, "prices")).toEqual(feed.state("prices"));
  });

  it("a failure between pages resumes at the last committed page, never re-applying or skipping", async () => {
    const { db, feed, loop } = await setup({ pageSize: 100 });
    await loop.request(["prices"]);
    for (let i = 0; i < 450; i++) feed.upsert("prices", "price", `p${String(i)}`, { n: i });
    let calls = 0;
    feed.beforeChanges = () => {
      calls++;
      if (calls === 3) throw new TransportError("down", { status: 0 });
    };
    await loop.request(["prices"]);
    expect(await localState(db, "prices")).toEqual(feed.state("prices"));
    expect(instant.delays).toHaveLength(1);
  });

  it("does nothing when the server answers not modified", async () => {
    const { feed, loop, events, applied } = await setup();
    await loop.request(["prices"]);
    events.length = 0;
    await loop.request(["prices"]);
    expect(applied).toEqual([]);
    expect(events).toEqual([]);
    expect(feed.calls.changes).toBeGreaterThanOrEqual(2);
  });

  it("applies deletes, and archived or deleted variants leave the search index", async () => {
    const { db, feed, loop } = await setup();
    feed.upsert("catalog", "variant", "v1", variant("v1", "Green Tea"));
    feed.upsert("catalog", "variant", "v2", variant("v2", "Green Apple"));
    await loop.request(["catalog"]);
    const hits = () =>
      db.all("select rowid from variant_search where variant_search match 'green*'");
    expect(await hits()).toHaveLength(2);
    feed.upsert("catalog", "variant", "v1", variant("v1", "Green Tea", { archived: true }));
    feed.remove("catalog", "variant", "v2");
    await loop.request(["catalog"]);
    expect(await hits()).toHaveLength(0);
    expect((await localState(db, "catalog")).has("variant/v2")).toBe(false);
  });

  it("starts again from a snapshot when the server no longer knows the cursor", async () => {
    const { db, feed, loop, events } = await setup();
    feed.upsert("prices", "price", "a", { n: 1 });
    await loop.request(["prices"]);
    feed.upsert("prices", "price", "b", { n: 2 });
    feed.upsert("prices", "price", "a", { n: 3 });
    feed.compact();
    await loop.request(["prices"]);
    expect(feed.calls.bootstrap).toBe(2);
    expect(events.filter((e) => e.type === "bootstrapped")).toHaveLength(2);
    expect(await localState(db, "prices")).toEqual(feed.state("prices"));
  });

  it("bootstraps an empty dataset without downloading anything", async () => {
    const { feed, loop } = await setup();
    await loop.request(["prices"]);
    expect(feed.calls.download).toBe(0);
    expect(await loop.pendingBootstrap()).toEqual(["catalog"]);
  });

  it("stops quietly on 401 and works again after the next request", async () => {
    const { db, feed, loop, events } = await setup();
    feed.upsert("prices", "price", "a", { n: 1 });
    let signedIn = false;
    feed.beforeChanges = () => {
      if (!signedIn) throw new TransportError("auth", { status: 401, code: "UNAUTHENTICATED" });
    };
    await loop.request(["prices"]);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(instant.delays).toEqual([]);
    signedIn = true;
    await loop.request(["prices"]);
    expect(await localState(db, "prices")).toEqual(feed.state("prices"));
  });

  it("retries with backoff after other errors", async () => {
    const { db, feed, loop, events } = await setup();
    feed.upsert("prices", "price", "a", { n: 1 });
    let failures = 2;
    feed.beforeChanges = () => {
      if (failures-- > 0) throw new TransportError("oops", { status: 503 });
    };
    await loop.request(["prices"]);
    expect(events.filter((e) => e.type === "backoff")).toHaveLength(2);
    expect(instant.delays).toEqual([500, 1000]);
    expect(await localState(db, "prices")).toEqual(feed.state("prices"));
  });

  it("a hint pulls only the datasets it names; start pulls all and polls as a fallback", async () => {
    const polls: (() => void)[] = [];
    const manual: Timers = {
      set: (fn) => {
        polls.push(fn);
        return polls.length;
      },
      clear: () => undefined,
    };
    const { feed, loop, db } = await setup({ pollMs: 30_000, timers: manual });
    await loop.start();
    expect(feed.calls.bootstrap).toBe(2);
    feed.upsert("catalog", "variant", "v1", variant("v1", "Tea"));
    feed.upsert("prices", "price", "p", { n: 1 });
    feed.calls.changes = 0;
    await loop.hint(["catalog"]);
    expect(feed.calls.changes).toBe(1);
    expect((await localState(db, "prices")).size).toBe(0);
    // Unknown datasets are ignored.
    await loop.hint(["tax"]);
    expect(feed.calls.changes).toBe(1);
    // The fallback poll finds the rest.
    polls.at(-1)?.();
    await loop.request([]);
    await new Promise((r) => setTimeout(r, 20));
    expect((await localState(db, "prices")).size).toBe(1);
    await loop.stop();
    await loop.request(); // after stop: ignored
  });

  it("a broken snapshot changes nothing", async () => {
    const db = await newDb();
    await applySnapshot(
      db,
      "prices",
      { cursor: "c1", rows: [{ entity: "price", id: "a", version: 0, payload: { n: 1 } }] },
      0,
    );
    expect(() => parseSnapshot("not json")).toThrow();
    expect(() => parseSnapshot('{"nothing":1}')).toThrow(/header/);
    await expect(
      applySnapshot(
        db,
        "prices",
        {
          cursor: "c2",
          rows: [{ entity: "price", id: "b", version: 0, payload: { n: BigInt(1) } }],
        },
        0,
      ),
    ).rejects.toThrow();
    expect([...(await localState(db, "prices")).keys()]).toEqual(["price/a"]);
    expect(await db.get("select value from kv where key = 'cursor:prices'")).toEqual({
      value: "c1",
    });
  });

  it("emits timings for pages, applies and bootstraps", async () => {
    const seen: string[] = [];
    const { feed, loop } = await setup({ onMetric: (n) => seen.push(n) });
    feed.upsert("prices", "price", "a", { n: 1 });
    await loop.request(["prices"]);
    feed.upsert("prices", "price", "b", { n: 2 });
    await loop.request(["prices"]);
    expect(new Set(seen)).toEqual(new Set(["bootstrap_ms", "pull_page_ms", "pull_apply_ms"]));
  });
});
