import { generateKeyPair, sign, verify } from "@wise-biz/crypto";
import { createHlc, uuidv7 } from "@wise-biz/ids";

import { commandHash, fromBase64, GENESIS_HASH, toBase64 } from "../../src/chain.ts";
import { createOutbox } from "../../src/outbox.ts";
import { TransportError } from "../../src/push.ts";
import { openLocalDb } from "../../src/schema/migrations.ts";

import { betterSqliteAdapter } from "./better-sqlite.ts";

import type { WireCommand } from "../../src/chain.ts";
import type { KeyStore } from "../../src/outbox.ts";
import type { PushResponse, Transport } from "../../src/push.ts";

/** What the server keeps per command, as modules/sync does: the chain head and a log to replay answers from. */
export interface FakeServer extends Transport {
  readonly applied: string[];
  readonly rejected: string[];
  lastSeq: () => number;
  quarantined: () => boolean;
  /** Forget everything after `seq` (a restore from backup). */
  loseAfter: (seq: number) => void;
  calls: number;
  /** Sequence numbers of every request, in order, for ordering assertions. */
  readonly requests: number[][];
}

/** A server with the same wire behaviour as modules/sync: replay, gap, chain checks, quarantine. */
export function createFakeServer(publicKey: Uint8Array): FakeServer {
  let lastSeq = -1;
  let lastHash = GENESIS_HASH;
  let quarantined = false;
  const log = new Map<number, { hash: string; status: "applied" | "rejected"; id: string }>();
  const applied: string[] = [];
  const rejected: string[] = [];
  const requests: number[][] = [];
  const server: FakeServer = {
    applied,
    rejected,
    requests,
    calls: 0,
    lastSeq: () => lastSeq,
    quarantined: () => quarantined,
    loseAfter(seq) {
      for (const s of [...log.keys()]) if (s > seq) log.delete(s);
      lastSeq = seq;
      lastHash = seq < 0 ? GENESIS_HASH : fromBase64(log.get(seq)?.hash ?? toBase64(GENESIS_HASH));
    },
    push(commands: readonly WireCommand[]): Promise<PushResponse> {
      server.calls++;
      requests.push(commands.map((c) => c.body.meta.deviceSeq));
      if (quarantined) {
        return Promise.reject(
          new TransportError("inactive", { status: 401, code: "DEVICE_INACTIVE" }),
        );
      }
      const acks: PushResponse["acks"][number][] = [];
      const stop = (
        code: "SEQUENCE_GAP" | "CHAIN_BROKEN" | "BAD_SIGNATURE",
        seq: number,
        expectedSeq?: number,
      ): Promise<PushResponse> => {
        if (code !== "SEQUENCE_GAP") quarantined = true;
        if (acks.length === 0) {
          return Promise.reject(
            code === "SEQUENCE_GAP"
              ? new TransportError("gap", {
                  status: 409,
                  code,
                  details: { expectedSeq },
                })
              : new TransportError("chain", { status: 409, code: "CHAIN_BROKEN" }),
          );
        }
        return Promise.resolve({
          acks,
          lastSeq,
          stopped: { seq, code, expectedSeq, quarantined: code !== "SEQUENCE_GAP" },
        });
      };
      for (const cmd of [...commands].sort(
        (a, b) => a.body.meta.deviceSeq - b.body.meta.deviceSeq,
      )) {
        const m = cmd.body.meta;
        if (m.deviceSeq <= lastSeq) {
          const old = log.get(m.deviceSeq);
          if (old?.hash === m.hash) {
            acks.push({
              seq: m.deviceSeq,
              status: old.status === "rejected" ? "rejected" : "replayed",
            });
            continue;
          }
          return stop("CHAIN_BROKEN", m.deviceSeq);
        }
        if (m.deviceSeq !== lastSeq + 1) return stop("SEQUENCE_GAP", m.deviceSeq, lastSeq + 1);
        const want = commandHash(cmd.type, m.deviceSeq, cmd.body, lastHash);
        if (m.prevHash !== toBase64(lastHash) || m.hash !== toBase64(want)) {
          return stop("CHAIN_BROKEN", m.deviceSeq);
        }
        if (!verify(fromBase64(m.signature), want, publicKey)) {
          return stop("BAD_SIGNATURE", m.deviceSeq);
        }
        const id = typeof cmd.body.id === "string" ? cmd.body.id : String(m.deviceSeq);
        const status = cmd.body.reject === true ? "rejected" : "applied";
        (status === "applied" ? applied : rejected).push(id);
        log.set(m.deviceSeq, { hash: m.hash, status, id });
        lastSeq = m.deviceSeq;
        lastHash = want;
        acks.push(
          status === "rejected"
            ? { seq: m.deviceSeq, status, error: { code: "PRICE_MISMATCH", message: "no" } }
            : { seq: m.deviceSeq, status },
        );
      }
      return Promise.resolve({ acks, stopped: null, lastSeq });
    },
  };
  return server;
}

export interface Device {
  outbox: ReturnType<typeof createOutbox>;
  server: FakeServer;
  keys: KeyStore;
  publicKey: Uint8Array;
  close: () => Promise<void>;
  db: Awaited<ReturnType<typeof openLocalDb>>;
}

/** A device database in memory, its key, and a server that knows the key. */
export async function createDevice(
  options: { file?: string; now?: () => number; nodeId?: string } = {},
): Promise<Device> {
  const kp = generateKeyPair();
  const db = await openLocalDb(betterSqliteAdapter(options.file));
  const keys: KeyStore = {
    publicKey: () => Promise.resolve(kp.publicKey),
    sign: (m) => Promise.resolve(sign(m, kp.secretKey)),
  };
  const outbox = createOutbox({
    db,
    keys,
    hlc: createHlc({ node: options.nodeId ?? "dev-1" }),
    ids: { uuidv7 },
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    outbox,
    server: createFakeServer(kp.publicKey),
    keys,
    publicKey: kp.publicKey,
    db,
    close: () => db.close(),
  };
}

/** A sale-shaped command body; `reject: true` makes the fake server refuse it. */
export const saleBody = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `sale-${String(n)}`,
  totalMinor: 1000 + n,
  ...extra,
});
