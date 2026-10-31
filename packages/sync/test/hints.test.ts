import { describe, expect, it } from "vitest";

import {
  createHintStream,
  createSseParser,
  fetchOpenStream,
  StreamHttpError,
} from "../src/hints.ts";

import type { Timers } from "../src/backoff.ts";
import type { Hint, HintState, OpenStream } from "../src/hints.ts";

describe("SSE parser", () => {
  it("parses events split across chunks, CRLF, comments, multi-line data and retry", () => {
    const p = createSseParser();
    expect(p.push("retry: 3000\nevent: ready\nda")).toEqual([]);
    expect(
      p.push('ta: {"channels":[]}\n\n: ping\n\nevent: hint\r\ndata: a\r\ndata: b\r\n\r\n'),
    ).toEqual([
      { event: "ready", data: '{"channels":[]}' },
      { event: "hint", data: "a\nb" },
    ]);
    // A lone \r at the end of a chunk may be half of \r\n.
    expect(p.push("data: x\r")).toEqual([]);
    expect(p.push("\n\r\n")).toEqual([{ event: "message", data: "x" }]);
    expect(p.push("event: only\n\n")).toEqual([{ event: "only", data: "" }]);
    expect(p.push("novalue\n\n")).toEqual([]);
  });
});

const instant: Timers & { delays: number[] } = {
  delays: [],
  set(fn, ms) {
    this.delays.push(ms);
    queueMicrotask(fn);
    return 0;
  },
  clear: () => undefined,
};

async function* chunks(...parts: string[]) {
  await Promise.resolve();
  for (const p of parts) yield p;
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};

const ticket = () => Promise.resolve({ token: "t", url: "https://rt.test" });

describe("hint stream", () => {
  it("calls onReady when live and onHints for each hint event", async () => {
    const hints: Hint[][] = [];
    let ready = 0;
    const states: HintState[] = [];
    const open: OpenStream = () =>
      Promise.resolve(
        chunks(
          "retry: 3000\nevent: ready\ndata: {}\n\n",
          'event: hint\ndata: {"hints":[{"channel":"all:prices","dataset":"prices"}]}\n\n',
          "event: hint\ndata: not json\n\n",
          'event: hint\ndata: {"nothing":true}\n\n',
          // never ends: held open until stop()
        ),
      );
    // Hold the stream open after the chunks.
    const held: OpenStream = async (t, s) => {
      const inner = await open(t, s);
      return (async function* () {
        yield* inner;
        await new Promise((_, rej) => {
          s.addEventListener("abort", () => {
            rej(new Error("aborted"));
          });
        });
      })();
    };
    instant.delays.length = 0;
    const hs = createHintStream({
      ticket,
      open: held,
      onReady: () => ready++,
      onHints: (h) => hints.push([...h]),
      onState: (s) => states.push(s),
      timers: instant,
      random: () => 0.5,
    });
    hs.start();
    hs.start(); // already running
    await waitFor(() => hints.length === 1);
    expect(ready).toBe(1);
    expect(hints[0]).toEqual([{ channel: "all:prices", dataset: "prices" }]);
    expect(hs.state()).toBe("live");
    await hs.stop();
    expect(hs.state()).toBe("stopped");
    expect(states).toContain("connecting");
    hs.start(); // a later sign-in restarts it
    expect(hs.state()).not.toBe("stopped");
    await hs.stop();
  });

  it("reconnects at once with a new ticket after a server reconnect event, with backoff after errors", async () => {
    let opens = 0;
    let tickets = 0;
    instant.delays.length = 0;
    const plan: ("reconnect" | "fail" | "hold")[] = ["reconnect", "fail", "fail", "hold"];
    const open: OpenStream = (_t, s) => {
      const step = plan[opens++] ?? "hold";
      if (step === "fail") return Promise.reject(new StreamHttpError(503));
      if (step === "reconnect")
        return Promise.resolve(
          chunks("event: ready\ndata: {}\n\n", "event: reconnect\ndata: {}\n\n"),
        );
      return Promise.resolve(
        (async function* () {
          yield "event: ready\ndata: {}\n\n";
          await new Promise((_, rej) => {
            s.addEventListener("abort", () => {
              rej(new Error("aborted"));
            });
          });
        })(),
      );
    };
    let ready = 0;
    const hs = createHintStream({
      ticket: () => {
        tickets++;
        return ticket();
      },
      open,
      onReady: () => ready++,
      onHints: () => undefined,
      timers: instant,
      random: () => 0.5,
      baseDelayMs: 1000,
    });
    hs.start();
    await waitFor(() => ready === 2);
    expect(tickets).toBe(4);
    // The deliberate reconnect waits the 1 s minimum (no hot loop); the two failures back off.
    expect(instant.delays).toEqual([1000, 500, 1000]);
    await hs.stop();
  });

  it("an ended stream is reopened after a backoff", async () => {
    let opens = 0;
    const delays: number[] = [];
    // A short real timer: with microtask-instant timers an endlessly ending stream would never yield the event loop.
    const quick: Timers = {
      set: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, 1);
      },
      clear: (h) => {
        clearTimeout(h as never);
      },
    };
    const hs = createHintStream({
      ticket,
      open: () => {
        opens++;
        return Promise.resolve(chunks("event: ready\ndata: {}\n\n"));
      },
      onReady: () => undefined,
      onHints: () => undefined,
      timers: quick,
      random: () => 0.5,
    });
    hs.start();
    await waitFor(() => opens >= 3);
    await hs.stop();
    expect(delays.length).toBeGreaterThanOrEqual(2);
    // The stream went live each time, so the backoff restarted from the base: 500 ms, not growing.
    expect(new Set(delays)).toEqual(new Set([500]));
  });

  it("a rejected ticket (401) pauses for sign-in and resumes afterwards", async () => {
    let signedIn = false;
    let ready = 0;
    const states: HintState[] = [];
    const hs = createHintStream({
      ticket: () =>
        signedIn ? ticket() : Promise.reject(Object.assign(new Error("auth"), { status: 401 })),
      open: (_t, s) =>
        Promise.resolve(
          (async function* () {
            yield "event: ready\ndata: {}\n\n";
            await new Promise((_, rej) => {
              s.addEventListener("abort", () => {
                rej(new Error("aborted"));
              });
            });
          })(),
        ),
      onReady: () => ready++,
      onHints: () => undefined,
      onState: (s) => states.push(s),
      timers: instant,
    });
    hs.start();
    await waitFor(() => hs.state() === "auth");
    signedIn = true;
    hs.resume();
    await waitFor(() => ready === 1);
    await hs.stop();
    expect(states).toContain("auth");
  });
});

describe("fetchOpenStream", () => {
  it("sends the ticket as a bearer header and yields decoded text", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
        c.close();
      },
    });
    const fakeFetch = ((url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.authorization ?? null });
      return Promise.resolve({ status: 200, body });
    }) as unknown as typeof fetch;
    const open = fetchOpenStream(fakeFetch);
    const stream = await open(
      { token: "tok", url: "https://rt.test/" },
      new AbortController().signal,
    );
    let text = "";
    for await (const c of stream) text += c;
    expect(text).toBe("event: ready\ndata: {}\n\n");
    expect(seen).toEqual([{ url: "https://rt.test/v1/stream", auth: "Bearer tok" }]);
  });

  it("throws with the status for a refusal", async () => {
    const open = fetchOpenStream((() =>
      Promise.resolve({ status: 503, body: null })) as unknown as typeof fetch);
    await expect(
      open({ token: "t", url: "https://rt.test" }, new AbortController().signal),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});
