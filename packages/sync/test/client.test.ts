import { createHlc, uuidv7 } from "@wise-biz/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createSyncClient } from "../src/client.ts";
import { TransportError } from "../src/push.ts";

import { createFakeFeed, gunzip } from "./support/fake-feed.ts";
import { createDevice, saleBody } from "./support/fake-server.ts";

import type { SyncClient } from "../src/client.ts";
import type { OpenStream } from "../src/hints.ts";
import type { Device } from "./support/fake-server.ts";

const open: Device[] = [];
const clients: SyncClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop().catch(() => undefined);
  for (const d of open.splice(0)) await d.close().catch(() => undefined);
});
const waitFor = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
  expect(await cond()).toBe(true);
};

/** An SSE source the test pushes text into. */
function controllableStream() {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const openStream: OpenStream = (_t, signal) =>
    Promise.resolve(
      (async function* () {
        signal.addEventListener("abort", () => wake?.());
        while (!signal.aborted) {
          const next = queue.shift();
          if (next === undefined) {
            await new Promise<void>((r) => {
              wake = r;
            });
            continue;
          }
          yield next;
        }
      })(),
    );
  return {
    open: openStream,
    send: (text: string) => {
      queue.push(text);
      wake?.();
    },
  };
}

async function build(extra: { pollMs?: number } = {}) {
  const d = await createDevice();
  open.push(d);
  const feed = createFakeFeed();
  const stream = controllableStream();
  const metrics: string[] = [];
  const client = createSyncClient({
    db: d.db,
    keys: d.keys,
    hlc: createHlc({ node: "dev-1" }),
    ids: { uuidv7 },
    push: d.server,
    pull: feed,
    gunzip,
    datasets: ["catalog", "prices"],
    realtime: {
      ticket: () => Promise.resolve({ token: "t", url: "https://rt.test" }),
      open: stream.open,
    },
    onMetric: (n) => metrics.push(n),
    ...extra,
  });
  clients.push(client);
  return { d, feed, stream, client, metrics };
}

describe("sync client", () => {
  it("first sync fills the catalog and indexes, a sale goes out, a hint pulls fresh data", async () => {
    const { d, feed, stream, client, metrics } = await build();
    feed.upsert("catalog", "variant", "v1", {
      variantId: "v1",
      name: "Green Tea",
      sku: "GT",
      archived: false,
    });
    feed.upsert("catalog", "barcodes", "v1", { variantId: "v1", codes: ["4006381333931"] });
    await client.start();
    expect(await client.health()).toMatchObject({
      unsyncedCount: 0,
      push: "idle",
      pendingBootstrap: [],
    });
    expect(client.indexes.variantForBarcode("4006381333931")).toBe("v1");
    expect((await client.indexes.search("green")).map((h) => h.variantId)).toEqual(["v1"]);

    // Selling: the domain row and the signed command commit together; the push loop sends it on its own.
    await d.db.exec("create table sales (id text primary key)");
    await client.transaction(async (tx) => {
      await tx.run("insert into sales values ('sale-1')");
      await tx.enqueue("complete_sale", saleBody(1));
    });
    await waitFor(() => d.server.applied.length === 1);
    await waitFor(async () => (await client.health()).unsyncedCount === 0);

    // The server's price changed: a hint says so, the client pulls only that dataset.
    feed.upsert("prices", "price", "v1", { priceMinor: 500 });
    stream.send("event: ready\ndata: {}\n\n");
    stream.send('event: hint\ndata: {"hints":[{"channel":"all:prices","dataset":"prices"}]}\n\n');
    await waitFor(async () => {
      const r = await d.db.get(
        "select 1 from entities where dataset = 'prices' and entity_id = 'v1'",
      );
      return r !== undefined;
    });
    expect(new Set(metrics)).toContain("push_batch_ms");
    expect(new Set(metrics)).toContain("bootstrap_ms");
    expect(new Set(metrics)).toContain("sync_lag_ms");
  });

  it("reports unsynced work and lag while the server is unreachable, and recovers on nudge", async () => {
    const { d, client } = await build();
    let up = false;
    const realPush = d.server.push.bind(d.server);
    d.server.push = (c) =>
      up ? realPush(c) : Promise.reject(new TransportError("offline", { status: 0 }));
    await client.start();
    await client.transaction((tx) => tx.enqueue("complete_sale", saleBody(1)));
    await waitFor(() => client.pushLoop.state() === "backoff");
    const h = await client.health();
    expect(h.unsyncedCount).toBe(1);
    expect(h.oldestUnsyncedAt).toBeDefined();
    expect(h.lagMs).toBeGreaterThanOrEqual(0);
    await expect(client.outbox.assertSafeToSignOut()).rejects.toThrow(/have not reached/);
    up = true;
    client.nudge();
    await waitFor(() => d.server.applied.length === 1);
    await client.outbox.assertSafeToSignOut();
  });

  it("resume after sign-in restarts push, pull and the hint stream", async () => {
    const { d, feed, client } = await build();
    let signedIn = false;
    const realPush = d.server.push.bind(d.server);
    d.server.push = (c) =>
      signedIn
        ? realPush(c)
        : Promise.reject(new TransportError("auth", { status: 401, code: "UNAUTHENTICATED" }));
    feed.beforeChanges = () => {
      if (!signedIn) throw new TransportError("auth", { status: 401, code: "UNAUTHENTICATED" });
    };
    feed.upsert("prices", "price", "a", { n: 1 });
    await client.start();
    await client.transaction((tx) => tx.enqueue("complete_sale", saleBody(1)));
    await waitFor(() => client.pushLoop.state() === "auth");
    signedIn = true;
    client.resume();
    await waitFor(() => d.server.applied.length === 1);
    await waitFor(async () => (await client.health()).pendingBootstrap.length === 0);
  });

  it("works without a realtime source (poll only) and stops cleanly", async () => {
    const d = await createDevice();
    open.push(d);
    const client = createSyncClient({
      db: d.db,
      keys: d.keys,
      hlc: createHlc({ node: "dev-1" }),
      ids: { uuidv7 },
      push: d.server,
      pull: createFakeFeed(),
      gunzip,
      datasets: ["catalog"],
      pollMs: 10_000,
    });
    await client.start();
    await client.stop();
    expect(client.pushLoop.state()).toBe("stopped");
  });
});
