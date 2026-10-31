import { backoffDelay, createSleeper, defaultTimers } from "./backoff.ts";

import type { OnClientMetric, Timers } from "./backoff.ts";
import type { WireCommand } from "./chain.ts";
import type { Ack, Outbox } from "./outbox.ts";

export interface PushResponse {
  readonly acks: readonly Ack[];
  readonly stopped: {
    readonly seq: number;
    readonly code: "SEQUENCE_GAP" | "CHAIN_BROKEN" | "BAD_SIGNATURE" | "UNKNOWN_DEVICE";
    readonly expectedSeq?: number | undefined;
    readonly quarantined: boolean;
  } | null;
  readonly lastSeq: number;
}

/** How a failed request looks to the loop. `status` 0 means no response (network, timeout). */
export class TransportError extends Error {
  readonly status: number;
  /** The API's problem `code` (UNAUTHENTICATED, SEQUENCE_GAP, DEVICE_REVOKED, ...). */
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;
  constructor(
    message: string,
    init: { status: number; code?: string; retryAfterMs?: number; details?: unknown },
  ) {
    super(message);
    this.name = "TransportError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
    this.details = init.details;
  }
}

/** The network edge: signs the HTTP request (RFC 9421) and posts to `/v1/sync/commands`. Built in P1-08. */
export interface Transport {
  push: (commands: readonly WireCommand[]) => Promise<PushResponse>;
}

export type LoopState = "idle" | "running" | "backoff" | "auth" | "blocked" | "stopped";

export type BlockReason =
  /** The server suspended or revoked this device (chain or signature failure, revoked, inactive). */
  | "quarantined"
  /** The server's history is behind ours and the commands it lacks are gone from the outbox. */
  | "diverged"
  /** The server refuses the request itself (not a business rejection): retrying cannot help. */
  | "refused";

export type LoopEvent =
  | { type: "pushed"; acked: number; rejected: number; remaining: number }
  | { type: "backoff"; attempt: number; delayMs: number; code: string | undefined }
  | { type: "auth_required" }
  | { type: "blocked"; reason: BlockReason; code: string | undefined }
  | { type: "rewound"; fromSeq: number; commands: number }
  | { type: "idle" };

export interface LoopOptions {
  outbox: Outbox;
  transport: Transport;
  onEvent?: (e: LoopEvent) => void;
  onMetric?: OnClientMetric;
  /** Commands per request; the server accepts at most 100. */
  batchLimit?: number;
  /** Request body budget; the server accepts 256 KB. */
  maxBytes?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1, injectable for tests. */
  random?: () => number;
  timers?: Timers;
  /** Awaited between batches so selling work keeps the thread (e.g. `InteractionManager.runAfterInteractions`). */
  yieldToUi?: () => Promise<void>;
}

const MAX_GAP_REWINDS = 3;
const BLOCKING = new Set([
  "CHAIN_BROKEN",
  "BAD_SIGNATURE",
  "UNKNOWN_DEVICE",
  "DEVICE_REVOKED",
  "DEVICE_INACTIVE",
]);

/**
 * Pushes the outbox to the server, oldest first, one request in flight, never reordering. Everything the server can
 * answer maps to one of: more to send, wait and retry (exponential backoff with full jitter, `Retry-After` honored),
 * wait for a new sign-in (`auth`), or stop for a human (`blocked`). A command is never skipped: the chain depends on
 * every sequence number, so a command the server refuses at the request level blocks the device instead.
 */
export function createPushLoop(opts: LoopOptions) {
  const { outbox, transport } = opts;
  const emit = (e: LoopEvent) => opts.onEvent?.(e);
  const limit = Math.min(opts.batchLimit ?? 100, 100);
  const maxBytes = opts.maxBytes ?? 200_000;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const timers = opts.timers ?? defaultTimers;

  let state: LoopState = "idle";
  // A function, not a bare comparison: state changes across awaits and from other calls, which control-flow narrowing cannot see.
  const is = (x: LoopState): boolean => state === x;
  const sleeper = createSleeper(timers);
  // Mutated by trigger() while drain() awaits: a property, so the compiler does not assume it stays false.
  const flags = { again: false };
  const wantsAgain = (): boolean => flags.again;
  let current: Promise<void> | undefined;
  let attempt = 0;
  let batch = limit;
  let gapStreak = 0;

  const backoff = (e: TransportError | undefined): number =>
    backoffDelay({ attempt, baseMs: base, capMs: cap, random, retryAfterMs: e?.retryAfterMs });

  /** One request. Returns true when there may be more to send right away. */
  async function pushOnce(): Promise<boolean> {
    const pending = await outbox.pending(batch, maxBytes);
    if (pending.length === 0) return false;
    let res: PushResponse;
    const started = performance.now();
    try {
      res = await transport.push(pending.map((p) => p.command));
    } catch (err) {
      return handleFailure(err, pending);
    }
    opts.onMetric?.("push_batch_ms", performance.now() - started, {
      commands: String(pending.length),
    });
    if (res.acks.length === 0 && res.stopped === null) {
      // A 200 that acknowledges nothing would spin us: treat it as a failed attempt.
      return handleFailure(new TransportError("empty answer", { status: 502 }), pending);
    }
    attempt = 0;
    batch = limit;
    const { acked, rejected } = await outbox.recordAcks(
      res.acks,
      pending.map((p) => p.seq),
    );
    if (res.stopped !== null) {
      const s = res.stopped;
      if (s.code === "SEQUENCE_GAP") return handleGap(s.expectedSeq);
      state = "blocked";
      emit({ type: "blocked", reason: "quarantined", code: s.code });
      return false;
    }
    gapStreak = 0;
    emit({ type: "pushed", acked, rejected, remaining: await outbox.unsyncedCount() });
    return true;
  }

  async function handleGap(expected: number | undefined): Promise<boolean> {
    // A server that keeps answering the same gap after we resent what it lacks is not healing: stop, do not spin.
    gapStreak++;
    if (gapStreak > MAX_GAP_REWINDS || expected === undefined || !(await outbox.hasSeq(expected))) {
      state = "blocked";
      emit({ type: "blocked", reason: "diverged", code: "SEQUENCE_GAP" });
      return false;
    }
    const n = await outbox.rewindTo(expected);
    if (n === 0) {
      // Nothing to resend (the missing command was rejected, not acked): looping would repeat the same gap forever.
      state = "blocked";
      emit({ type: "blocked", reason: "diverged", code: "SEQUENCE_GAP" });
      return false;
    }
    emit({ type: "rewound", fromSeq: expected, commands: n });
    return true;
  }

  async function handleFailure(
    err: unknown,
    pending: readonly { seq: number }[],
  ): Promise<boolean> {
    // stop() (sign-out) wins over any retry: never overwrite "stopped" or send again.
    if (is("stopped")) return false;
    const e = err instanceof TransportError ? err : undefined;
    const code = e?.code;
    const status = e?.status ?? 0;
    if (code === "SEQUENCE_GAP") {
      const expected = (e?.details as { expectedSeq?: number } | undefined)?.expectedSeq;
      return handleGap(expected);
    }
    if (code !== undefined && BLOCKING.has(code)) {
      state = "blocked";
      emit({ type: "blocked", reason: "quarantined", code });
      return false;
    }
    if (status === 401 || code === "UNAUTHENTICATED") {
      state = "auth";
      emit({ type: "auth_required" });
      return false;
    }
    if (status === 413 && pending.length > 1) {
      // Too big for a proxy or the server: halve the batch and try again at once.
      batch = Math.max(1, Math.floor(pending.length / 2));
      return true;
    }
    const retryable =
      e === undefined || status === 0 || status === 408 || status === 429 || status >= 500;
    if (!retryable) {
      state = "blocked";
      emit({ type: "blocked", reason: "refused", code });
      return false;
    }
    await outbox.recordAttempt(pending.map((p) => p.seq));
    const delayMs = backoff(e);
    attempt++;
    state = "backoff";
    emit({ type: "backoff", attempt, delayMs, code });
    await sleeper.sleep(delayMs);
    return is("backoff");
  }

  async function drain(): Promise<void> {
    do {
      flags.again = false;
      if (is("stopped") || is("blocked") || is("auth")) return;
      state = "running";
      let more = true;
      while (more && is("running")) {
        more = await pushOnce().catch((err: unknown) => handleFailure(err, []));
        if (more && is("running")) await opts.yieldToUi?.();
        if (is("backoff")) state = "running";
      }
      if (is("running")) {
        state = "idle";
        emit({ type: "idle" });
      }
    } while (wantsAgain() && is("idle"));
  }

  return {
    state: (): LoopState => state,
    /** Something may have changed (a command was enqueued, the network came back): push if idle, else note it. */
    trigger(): Promise<void> {
      if (is("stopped")) return Promise.resolve();
      if (current !== undefined) {
        flags.again = true;
        return current;
      }
      current = drain().finally(() => {
        current = undefined;
      });
      return current;
    },
    /** The network came back: skip the rest of a backoff wait and push now. (A local write must not do this.) */
    networkUp(): Promise<void> {
      sleeper.wake();
      return this.trigger();
    },
    /** Allows a loop that was stopped (sign-out) to run again (sign-in). */
    start(): void {
      if (is("stopped")) state = "idle";
    },
    /** After a fresh sign-in (auth) or an owner's re-enrolment (blocked): push again. */
    resume(): Promise<void> {
      if (is("auth") || is("blocked")) state = "idle";
      attempt = 0;
      return this.trigger();
    },
    async stop(): Promise<void> {
      state = "stopped";
      sleeper.wake();
      await current;
    },
  };
}

export type PushLoop = ReturnType<typeof createPushLoop>;
