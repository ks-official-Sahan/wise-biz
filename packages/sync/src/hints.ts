import { backoffDelay, createSleeper, defaultTimers } from "./backoff.ts";

import type { Timers } from "./backoff.ts";
import type { Dataset } from "./pull.ts";

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Incremental Server-Sent Events parser (WHATWG): feed text chunks, get complete events. */
const MAX_BUFFER = 1_000_000;
const MIN_RECONNECT_MS = 1000;

export function createSseParser() {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER) throw new Error("SSE event too large");
      const out: SseEvent[] = [];
      for (;;) {
        const nl = /\r\n|\n|\r/.exec(buffer);
        // A lone trailing \r may be the first half of \r\n: wait for more.
        if (nl === null || (nl[0] === "\r" && nl.index === buffer.length - 1)) break;
        const line = buffer.slice(0, nl.index);
        buffer = buffer.slice(nl.index + nl[0].length);
        if (line === "") {
          if (data.length > 0 || event !== "")
            out.push({ event: event || "message", data: data.join("\n") });
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
      return out;
    },
  };
}

export interface Hint {
  readonly channel: string;
  readonly dataset: Dataset;
}

export interface StreamTicket {
  readonly token: string;
  /** Base URL of apps/realtime. */
  readonly url: string;
}

/**
 * Opens the stream and yields its text. The default uses `fetch` streaming (browsers, Node, Electron); React Native
 * hosts pass their own (its fetch does not stream). Throws `TransportError`-like objects with a numeric `status` for
 * non-200 answers.
 */
export type OpenStream = (
  ticket: StreamTicket,
  signal: AbortSignal,
) => Promise<AsyncIterable<string>>;

export class StreamHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`realtime answered ${String(status)}`);
    this.name = "StreamHttpError";
    this.status = status;
  }
}

export function fetchOpenStream(fetchFn: typeof fetch): OpenStream {
  return async (ticket, signal) => {
    const res = await fetchFn(`${ticket.url.replace(/\/$/, "")}/v1/stream`, {
      headers: { authorization: `Bearer ${ticket.token}`, accept: "text/event-stream" },
      signal,
    });
    if (res.status !== 200 || res.body === null) throw new StreamHttpError(res.status);
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    const decoder = new TextDecoder();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            yield decoder.decode(value, { stream: true });
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  };
}

export type HintState = "idle" | "connecting" | "live" | "backoff" | "auth" | "stopped";

export interface HintStreamOptions {
  /** A fresh ticket from `POST /v1/sync/stream-ticket` (signed terminal request). */
  ticket: () => Promise<StreamTicket>;
  open: OpenStream;
  /** The subscription is live: pull once now to close any gap, then rely on hints. */
  onReady: () => void;
  onHints: (hints: readonly Hint[]) => void;
  onState?: (s: HintState) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  timers?: Timers;
}

const isStatus = (e: unknown): number | undefined =>
  typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number"
    ? (e as { status: number }).status
    : undefined;

/**
 * Keeps a hint stream open: new ticket per connection, reconnect with backoff, immediate reconnect when the server
 * ends a stream on purpose (`event: reconnect`, every few minutes), stop for sign-in on 401. A hint only says "pull
 * now"; losing the stream costs nothing but latency, because the pull loop also polls.
 */
export function createHintStream(opts: HintStreamOptions) {
  const timers = opts.timers ?? defaultTimers;
  const random = opts.random ?? Math.random;
  const sleeper = createSleeper(timers);
  let state: HintState = "idle";
  let abort: AbortController | undefined;
  let running: Promise<void> | undefined;
  const set = (s: HintState) => {
    state = s;
    opts.onState?.(s);
  };
  const is = (s: HintState): boolean => state === s;

  async function once(): Promise<"reconnect" | "ended"> {
    if (is("stopped")) return "ended";
    set("connecting");
    const ticket = await opts.ticket();
    if (is("stopped")) return "ended";
    abort = new AbortController();
    const chunks = await opts.open(ticket, abort.signal);
    if (is("stopped")) {
      abort.abort();
      return "ended";
    }
    const parser = createSseParser();
    let outcome: "reconnect" | "ended" = "ended";
    for await (const chunk of chunks) {
      for (const ev of parser.push(chunk)) {
        if (ev.event === "ready" && !is("stopped")) {
          set("live");
          attempt = 0;
          opts.onReady();
        } else if (ev.event === "hint") {
          try {
            const body = JSON.parse(ev.data) as { hints?: Hint[] };
            if (Array.isArray(body.hints)) opts.onHints(body.hints);
          } catch {
            // a malformed hint is ignored: the poll covers it
          }
        } else if (ev.event === "reconnect") outcome = "reconnect";
      }
      if (outcome === "reconnect") break;
    }
    return outcome;
  }

  let attempt = 0;
  async function run(): Promise<void> {
    while (!is("stopped") && !is("auth")) {
      try {
        const outcome = await once();
        if (outcome === "reconnect") {
          // Deliberate server reconnect: no backoff, but never a hot loop of ticket requests.
          await sleeper.sleep(MIN_RECONNECT_MS);
          continue;
        }
      } catch (e) {
        if (is("stopped")) return;
        const status = isStatus(e);
        if (status === 401 || status === 403) {
          set("auth");
          return;
        }
      }
      if (is("stopped")) return;
      set("backoff");
      const delay = backoffDelay({
        attempt,
        baseMs: opts.baseDelayMs ?? 1000,
        capMs: opts.maxDelayMs ?? 60_000,
        random,
      });
      attempt++;
      await sleeper.sleep(delay);
    }
  }

  return {
    state: (): HintState => state,
    start(): void {
      if (running !== undefined) return;
      if (is("stopped")) set("idle");
      running = run().finally(() => {
        running = undefined;
      });
    },
    /** After a fresh sign-in. */
    resume(): void {
      if (is("auth")) set("idle");
      attempt = 0;
      this.start();
    },
    async stop(): Promise<void> {
      set("stopped");
      abort?.abort();
      sleeper.wake();
      await running;
    },
  };
}

export type HintStream = ReturnType<typeof createHintStream>;
