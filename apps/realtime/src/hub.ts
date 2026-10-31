import { DATASETS } from "@wise-biz/module-sync";

import type { Dataset } from "@wise-biz/module-sync";

/** A terminal gets at most 4 messages a second (events.md); hints inside one window are coalesced into one message. */
export const MIN_GAP_MS = 250;
/** A client that cannot drain this much is dropped; it reconnects and pulls. */
export const MAX_BACKLOG_BYTES = 64 * 1024;

/** Pub/sub surface the hub needs (the redis adapter lives in start.ts; tests pass a fake). */
export interface Subscriber {
  subscribe: (
    pattern: string,
    onMessage: (channel: string, message: string) => void,
  ) => Promise<void>;
  unsubscribe: (pattern: string) => Promise<void>;
}

/** Where a stream writes. `backlog` is the bytes the socket has not flushed yet. */
export interface Sink {
  write: (chunk: string) => void;
  end: () => void;
  backlog: () => number;
}

export interface Stats {
  streams: number;
  tenants: number;
  hintsIn: number;
  messagesOut: number;
  /** Hints folded into an already pending one. */
  coalesced: number;
  droppedSlow: number;
}

export class Stream {
  private readonly pending = new Map<string, Dataset>();
  private lastFlush = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  readonly channels: ReadonlySet<string>;
  readonly tenantId: string;
  private readonly sink: Sink;
  private readonly hub: Hub;

  constructor(channels: ReadonlySet<string>, tenantId: string, sink: Sink, hub: Hub) {
    this.channels = channels;
    this.tenantId = tenantId;
    this.sink = sink;
    this.hub = hub;
  }

  hint(channel: string, dataset: Dataset): void {
    if (this.closed) return;
    if (this.pending.has(channel)) this.hub.stats.coalesced++;
    this.pending.set(channel, dataset);
    if (this.timer !== undefined) return;
    const wait = Math.max(0, this.lastFlush + MIN_GAP_MS - Date.now());
    this.timer = setTimeout(() => {
      this.flush();
    }, wait);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.closed || this.pending.size === 0) return;
    const hints = [...this.pending].map(([channel, dataset]) => ({ channel, dataset }));
    this.pending.clear();
    this.lastFlush = Date.now();
    this.write(`event: hint\ndata: ${JSON.stringify({ hints })}\n\n`);
  }

  /** Any write: a client that stopped draining is dropped instead of growing the server's memory. */
  write(chunk: string): void {
    if (this.closed) return;
    this.sink.write(chunk);
    this.hub.stats.messagesOut++;
    if (this.sink.backlog() > MAX_BACKLOG_BYTES) {
      this.hub.stats.droppedSlow++;
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.pending.clear();
    this.sink.end();
    this.hub.release(this);
  }
}

interface TenantState {
  streams: Set<Stream>;
  byChannel: Map<string, Set<Stream>>;
  ready: Promise<void>;
}

const isDataset = (s: unknown): s is Dataset =>
  typeof s === "string" && (DATASETS as readonly string[]).includes(s);

/**
 * Fans Redis notices out to open streams. One pattern subscription per tenant per instance (`rt:{tenant}:*`),
 * reference-counted by its streams, and dispatch is a map lookup by channel: cost scales with the streams that care.
 */
export class Hub {
  readonly stats = { hintsIn: 0, messagesOut: 0, coalesced: 0, droppedSlow: 0 };
  private readonly tenants = new Map<string, TenantState>();
  private streamCount = 0;
  /** Last subscribe/unsubscribe of each tenant: a reopen waits for a pending unsubscribe, never crosses it. */
  private readonly chains = new Map<string, Promise<void>>();

  private readonly sub: Subscriber;

  constructor(sub: Subscriber) {
    this.sub = sub;
  }

  get size(): number {
    return this.streamCount;
  }

  snapshot(): Stats {
    return { streams: this.streamCount, tenants: this.tenants.size, ...this.stats };
  }

  /** Resolves once the tenant's subscription is live, so nothing published after this returns is missed. */
  async open(tenantId: string, channels: readonly string[], sink: Sink): Promise<Stream> {
    const stream = new Stream(new Set(channels), tenantId, sink, this);
    let t = this.tenants.get(tenantId);
    if (t === undefined) {
      const state: TenantState = {
        streams: new Set(),
        byChannel: new Map(),
        ready: Promise.resolve(),
      };
      t = state;
      this.tenants.set(tenantId, state);
      const after = this.chains.get(tenantId) ?? Promise.resolve();
      state.ready = after.then(() =>
        this.sub.subscribe(`rt:${tenantId}:*`, (channel, message) => {
          this.dispatch(state, channel, message);
        }),
      );
      this.chains.set(
        tenantId,
        state.ready.catch(() => undefined),
      );
    }
    t.streams.add(stream);
    for (const c of stream.channels) {
      let set = t.byChannel.get(c);
      if (set === undefined) t.byChannel.set(c, (set = new Set()));
      set.add(stream);
    }
    this.streamCount++;
    try {
      await t.ready;
    } catch (err) {
      stream.close();
      throw err;
    }
    return stream;
  }

  /** Called by a closing stream. */
  release(stream: Stream): void {
    const t = this.tenants.get(stream.tenantId);
    if (!t?.streams.delete(stream)) return;
    this.streamCount--;
    for (const c of stream.channels) {
      const set = t.byChannel.get(c);
      set?.delete(stream);
      if (set?.size === 0) t.byChannel.delete(c);
    }
    if (t.streams.size > 0) return;
    this.tenants.delete(stream.tenantId);
    const pattern = `rt:${stream.tenantId}:*`;
    // After the subscribe settles; a failed subscribe was already reported to its opener.
    const done = t.ready
      .then(
        () => this.sub.unsubscribe(pattern),
        () => undefined,
      )
      .catch(() => undefined);
    this.chains.set(stream.tenantId, done);
    void done.then(() => {
      if (this.chains.get(stream.tenantId) === done) this.chains.delete(stream.tenantId);
    });
  }

  /** `rt:{tenant}:{channel}` + `{"dataset":...}`. Anything malformed is ignored (the bus is not an auth boundary). */
  private dispatch(t: TenantState, redisChannel: string, message: string): void {
    const first = redisChannel.indexOf(":");
    const second = redisChannel.indexOf(":", first + 1);
    if (second < 0) return;
    const channel = redisChannel.slice(second + 1);
    const targets = t.byChannel.get(channel);
    if (targets === undefined) return;
    let dataset: unknown;
    try {
      dataset = (JSON.parse(message) as { dataset?: unknown }).dataset;
    } catch {
      return;
    }
    if (!isDataset(dataset)) return;
    this.stats.hintsIn++;
    for (const s of targets) s.hint(channel, dataset);
  }

  /** Comment line that keeps proxies from closing idle streams; not counted against the message budget. */
  heartbeat(): void {
    for (const t of this.tenants.values()) for (const s of t.streams) s.write(": ping\n\n");
  }

  /** Close every stream (shutdown). */
  closeAll(): void {
    for (const t of [...this.tenants.values()]) for (const s of [...t.streams]) s.close();
  }
}
