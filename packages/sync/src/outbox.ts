import { commandHash, fromBase64, GENESIS_HASH, toBase64 } from "./chain.ts";

import type { WireCommand } from "./chain.ts";
import type { LocalDb, Tx } from "./storage/local-db.ts";
import type { Hlc } from "@wise-biz/ids";

/**
 * Signs with the device key. The secret never leaves the platform keystore (Secure Enclave, Android Keystore,
 * Electron safeStorage); platform implementations arrive with P1-08 and P1-12.
 */
export interface KeyStore {
  publicKey: () => Promise<Uint8Array>;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface OutboxDeps {
  db: LocalDb;
  keys: KeyStore;
  hlc: Hlc;
  ids: { uuidv7: () => string };
  now?: () => number;
}

export interface Enqueued {
  readonly seq: number;
  readonly id: string;
  readonly hash: string;
}

/** A transaction body's handle: the database plus `enqueue`, so domain rows and their command commit together. */
export type OutboxTx = Tx & {
  enqueue: (type: string, body: Readonly<Record<string, unknown>>) => Promise<Enqueued>;
};

export type CommandStatus = "pending" | "acked" | "rejected";

export interface StoredCommand {
  readonly seq: number;
  readonly id: string;
  readonly command: WireCommand;
  readonly createdAt: number;
  readonly attempts: number;
}

export interface RejectedCommand extends StoredCommand {
  readonly error: { code: string; message: string; details?: unknown } | undefined;
}

export interface Ack {
  readonly seq: number;
  readonly status: "applied" | "replayed" | "rejected";
  readonly error?: { code: string; message: string; details?: unknown } | undefined;
  readonly result?: unknown;
}

export class UnsyncedWorkError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`${String(count)} command(s) have not reached the server yet`);
    this.name = "UnsyncedWorkError";
    this.count = count;
  }
}

interface Head {
  /** Sequence number the next command gets. */
  next: number;
  /** Base64 hash of the last command. */
  hash: string;
}

const HEAD_KEY = "chain.head";
const GENESIS_B64 = toBase64(GENESIS_HASH);

interface Row {
  seq: number;
  id: string;
  type: string;
  body: string;
  created_at: number;
  attempts: number;
  ack: string | null;
}

const toStored = (r: Row): StoredCommand => ({
  seq: r.seq,
  id: r.id,
  command: { type: r.type, body: JSON.parse(r.body) as WireCommand["body"] },
  createdAt: r.created_at,
  attempts: r.attempts,
});

const hlcText = (t: { wallMs: number; counter: number; node: string }) =>
  `${String(t.wallMs)}:${String(t.counter)}:${t.node}`;

/**
 * The device's signed, hash-chained command log. A command is written in the same local transaction as the rows it
 * describes (`transaction`), so there is never a sale without its command or a command without its sale, and a crash
 * between local commit and push loses nothing: the row is still `pending` after restart and goes out in order.
 */
export function createOutbox(deps: OutboxDeps) {
  const { db, keys, hlc, ids } = deps;
  const now = deps.now ?? Date.now;

  async function enqueue(
    tx: Tx,
    type: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Enqueued> {
    if (Object.hasOwn(body, "meta")) throw new Error("a command body must not carry `meta`");
    const stored = await tx.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", [
      HEAD_KEY,
    ]);
    const head: Head =
      stored === undefined ? { next: 0, hash: GENESIS_B64 } : (JSON.parse(stored.value) as Head);
    const seq = head.next;
    const hash = commandHash(type, seq, body, fromBase64(head.hash));
    const signature = await keys.sign(hash);
    const meta = {
      deviceSeq: seq,
      prevHash: head.hash,
      hash: toBase64(hash),
      signature: toBase64(signature),
    };
    const id = typeof body.id === "string" ? body.id : ids.uuidv7();
    await tx.run(
      `INSERT INTO device_outbox (seq, id, type, body, hash, prev_hash, hlc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seq,
        id,
        type,
        JSON.stringify({ ...body, meta }),
        meta.hash,
        meta.prevHash,
        hlcText(hlc.now()),
        now(),
      ],
    );
    await tx.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [HEAD_KEY, JSON.stringify({ next: seq + 1, hash: meta.hash } satisfies Head)],
    );
    return { seq, id, hash: meta.hash };
  }

  async function unsyncedCount(): Promise<number> {
    const r = await db.get<{ n: number }>(
      "SELECT count(*) AS n FROM device_outbox WHERE status = 'pending'",
    );
    return r?.n ?? 0;
  }

  return {
    /** `await outbox.transaction(async (tx) => { await tx.run(...domain rows...); await tx.enqueue("complete_sale", body); })` */
    transaction: <T>(fn: (tx: OutboxTx) => Promise<T>): Promise<T> =>
      db.transaction((tx) =>
        fn({
          ...tx,
          enqueue: (type, body) => enqueue(tx, type, body),
        }),
      ),

    /** Oldest pending commands in sequence order, at most `limit` and about `maxBytes` of JSON (at least one). */
    async pending(limit: number, maxBytes: number): Promise<StoredCommand[]> {
      const rows = await db.all<Row>(
        "SELECT seq, id, type, body, created_at, attempts, ack FROM device_outbox WHERE status = 'pending' ORDER BY seq LIMIT ?",
        [limit],
      );
      const out: StoredCommand[] = [];
      let bytes = 0;
      for (const r of rows) {
        bytes += r.body.length;
        if (out.length > 0 && bytes > maxBytes) break;
        out.push(toStored(r));
      }
      return out;
    },

    /** All pending commands (support export, diagnostics). */
    async allPending(): Promise<StoredCommand[]> {
      const rows = await db.all<Row>(
        "SELECT seq, id, type, body, created_at, attempts, ack FROM device_outbox WHERE status = 'pending' ORDER BY seq",
      );
      return rows.map(toStored);
    },

    /** Records the server's answers. Idempotent: only commands still pending change. */
    async recordAcks(
      acks: readonly Ack[],
      /** The sequence numbers just sent: an answer about any other command is ignored. */
      sent?: readonly number[],
    ): Promise<{ acked: number; rejected: number }> {
      let acked = 0;
      let rejected = 0;
      const allowed = sent === undefined ? undefined : new Set(sent);
      await db.transaction(async (tx) => {
        for (const a of acks) {
          if (allowed !== undefined && !allowed.has(a.seq)) continue;
          const status: CommandStatus = a.status === "rejected" ? "rejected" : "acked";
          const r = await tx.run(
            "UPDATE device_outbox SET status = ?, ack = ? WHERE seq = ? AND status = 'pending'",
            [status, JSON.stringify({ status: a.status, error: a.error, result: a.result }), a.seq],
          );
          if (r.changes === 1) {
            if (status === "acked") acked++;
            else rejected++;
          }
        }
      });
      return { acked, rejected };
    },

    /** A push attempt that failed: bump the counter on what was sent (diagnostics, poison detection). */
    async recordAttempt(seqs: readonly number[]): Promise<void> {
      if (seqs.length === 0) return;
      await db.run(
        `UPDATE device_outbox SET attempts = attempts + 1 WHERE seq IN (${seqs.map(() => "?").join(",")})`,
        seqs,
      );
    },

    /**
     * The server says it expects `seq` next, but we hold later commands as acked (it lost them, e.g. a restore from
     * backup). If they are still in the outbox they go out again, in order. Returns how many came back to pending.
     */
    async rewindTo(seq: number): Promise<number> {
      const r = await db.run(
        "UPDATE device_outbox SET status = 'pending', ack = NULL WHERE seq >= ? AND status = 'acked'",
        [seq],
      );
      return r.changes;
    },

    async hasSeq(seq: number): Promise<boolean> {
      return (await db.get("SELECT 1 FROM device_outbox WHERE seq = ?", [seq])) !== undefined;
    },

    unsyncedCount,

    async oldestUnsyncedAt(): Promise<number | undefined> {
      const r = await db.get<{ t: number | null }>(
        "SELECT created_at AS t FROM device_outbox WHERE status = 'pending' ORDER BY seq LIMIT 1",
      );
      return r?.t ?? undefined;
    },

    /** Commands the server refused (business rule). They stay for the operator to see and for support. */
    async rejected(): Promise<RejectedCommand[]> {
      const rows = await db.all<Row>(
        "SELECT seq, id, type, body, created_at, attempts, ack FROM device_outbox WHERE status = 'rejected' ORDER BY seq",
      );
      return rows.map((r) => ({
        ...toStored(r),
        error:
          r.ack === null
            ? undefined
            : (JSON.parse(r.ack) as { error?: RejectedCommand["error"] }).error,
      }));
    },

    /** Signing out with unsynced work would strand it: refuse. */
    async assertSafeToSignOut(): Promise<void> {
      const n = await unsyncedCount();
      if (n > 0) throw new UnsyncedWorkError(n);
    },

    /** Deletes acknowledged commands older than `beforeMs` (the chain head lives in `kv`, not in these rows). */
    async pruneAcked(beforeMs: number): Promise<number> {
      const r = await db.run(
        "DELETE FROM device_outbox WHERE status = 'acked' AND created_at < ?",
        [beforeMs],
      );
      return r.changes;
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
