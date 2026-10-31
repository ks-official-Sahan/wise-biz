import { signTicket } from "@wise-biz/module-sync";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRealtimeServer } from "../src/server.ts";

import type { Subscriber } from "../src/hub.ts";
import type { RealtimeServer } from "../src/server.ts";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";

const SECRET = "r".repeat(32);
const TENANT = "0192f2a0-0000-7000-8000-0000000000aa";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const logger = { error: () => undefined } as unknown as Logger;

const ticket = (over: Partial<{ ch: string[]; exp: number; tid: string }> = {}) =>
  signTicket(SECRET, {
    v: 1,
    tid: over.tid ?? TENANT,
    sub: "device-1",
    ch: over.ch ?? ["all:prices", "l:L1:stock_branch"],
    exp: over.exp ?? Math.floor(Date.now() / 1000) + 60,
  });

let sub: ReturnType<typeof createClient>;
let pub: ReturnType<typeof createClient>;
let rt: RealtimeServer;
let base: string;
let isReady = true;

beforeAll(async () => {
  sub = createClient({ url: REDIS_URL });
  pub = createClient({ url: REDIS_URL });
  await Promise.all([sub.connect(), pub.connect()]);
  const subscriber: Subscriber = {
    subscribe: (pattern, onMessage) =>
      sub.pSubscribe(pattern, (message, channel) => {
        onMessage(channel, message);
      }),
    unsubscribe: (pattern) => sub.pUnsubscribe(pattern),
  };
  rt = createRealtimeServer({
    secret: SECRET,
    subscriber,
    logger,
    maxConnections: 3,
    maxAgeMs: 1500,
    heartbeatMs: 200,
    ready: () => isReady,
  });
  await new Promise<void>((resolve) => rt.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((rt.server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await rt.stop();
  await Promise.all([sub.close(), pub.close()]);
});

/** Pumps an SSE response into a buffer; `until` resolves once the text satisfies the predicate (or time runs out). */
function sse(res: Response) {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value !== undefined) text += dec.decode(value);
        if (done) break;
      }
    } catch {
      // aborted
    }
    ended = true;
  })();
  return {
    until: async (done: (t: string) => boolean, timeoutMs = 5000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      while (!done(text) && !ended && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      return text;
    },
    cancel: () => reader.cancel(),
  };
}
const open = (token: string, signal?: AbortSignal) =>
  fetch(`${base}/v1/stream`, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });

describe("realtime stream", () => {
  it("refuses a missing, forged, expired or foreign ticket and any other route or method", async () => {
    expect((await fetch(`${base}/v1/stream`)).status).toBe(401);
    expect((await open("garbage")).status).toBe(401);
    expect((await open(ticket({ exp: 1 }))).status).toBe(401);
    expect((await open(signTicketWith("x".repeat(32)))).status).toBe(401);
    // The ticket is never read from the URL.
    expect((await fetch(`${base}/v1/stream?ticket=${ticket()}`)).status).toBe(401);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/stream`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("delivers a published notice to the terminal that holds the channel, in well under a second", async () => {
    const res = await open(ticket());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const s = sse(res);
    // `ready` marks the live subscription: publish after it, as a terminal does after its first pull.
    await s.until((t) => t.includes("event: ready"));
    const sent = Date.now();
    await pub.publish(`rt:${TENANT}:all:prices`, JSON.stringify({ dataset: "prices" }));
    const body = await s.until((t) => t.includes("event: hint"));
    expect(Date.now() - sent).toBeLessThan(1000);
    expect(body).toContain("event: ready");
    expect(body).toContain('"channels":["all:prices","l:L1:stock_branch"]');
    await s.cancel();
    expect(body).toContain(
      'event: hint\ndata: {"hints":[{"channel":"all:prices","dataset":"prices"}]}',
    );
  });

  it("does not leak another channel or tenant", async () => {
    const res = await open(ticket({ ch: ["all:tax"] }));
    const s = sse(res);
    await s.until((t) => t.includes("event: ready"));
    await pub.publish(`rt:${TENANT}:all:prices`, JSON.stringify({ dataset: "prices" }));
    await pub.publish(
      `rt:0192f2a0-0000-7000-8000-0000000000bb:all:tax`,
      JSON.stringify({ dataset: "tax" }),
    );
    const body = await s.until((t) => t.includes("event: hint"), 600);
    await s.cancel();
    expect(body).not.toContain("event: hint");
  });

  it("heartbeats an idle stream and ends it at max age with a reconnect event", async () => {
    const res = await open(ticket());
    const body = await sse(res).until((t) => t.includes("event: reconnect"), 4000);
    expect(body).toContain(": ping");
    expect(body).toContain("event: reconnect");
    await waitFor(() => rt.hub.size === 0);
  });

  it("caps connections and reports not-ready with 503", async () => {
    const aborts = [new AbortController(), new AbortController(), new AbortController()];
    const open3 = await Promise.all(aborts.map((a) => open(ticket(), a.signal)));
    expect(open3.map((r) => r.status)).toEqual([200, 200, 200]);
    await waitFor(() => rt.hub.size === 3);
    const full = await open(ticket());
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("5");
    for (const a of aborts) a.abort();
    await waitFor(() => rt.hub.size === 0);
    isReady = false;
    expect((await open(ticket())).status).toBe(503);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    isReady = true;
    expect((await fetch(`${base}/ready`)).status).toBe(200);
  });
});

describe("per-device cap", () => {
  it("one terminal cannot hold more than 4 streams, and a hang-up frees its slot at once", async () => {
    const big = createRealtimeServer({
      secret: SECRET,
      subscriber: rt2sub(),
      logger,
      maxConnections: 100,
    });
    await new Promise<void>((resolve) => big.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${String((big.server.address() as AddressInfo).port)}/v1/stream`;
    const get = (signal?: AbortSignal) =>
      fetch(url, {
        headers: { authorization: `Bearer ${ticket()}` },
        ...(signal ? { signal } : {}),
      });
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    try {
      const ok = await Promise.all(aborts.map((a) => get(a.signal)));
      expect(ok.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect((await get()).status).toBe(503);
      aborts[0]?.abort();
      await waitFor(() => big.hub.size === 3);
      const again = new AbortController();
      expect((await get(again.signal)).status).toBe(200);
      again.abort();
    } finally {
      for (const a of aborts) a.abort();
      await big.stop();
    }
  });
});

/** Subscriber that acknowledges at once (the per-device cap does not need Redis). */
function rt2sub(): Subscriber {
  return { subscribe: () => Promise.resolve(), unsubscribe: () => Promise.resolve() };
}

function signTicketWith(secret: string): string {
  return signTicket(secret, {
    v: 1,
    tid: TENANT,
    sub: "d",
    ch: [],
    exp: Math.floor(Date.now() / 1000) + 60,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
