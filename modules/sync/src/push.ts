import { canonicalize, constantTimeEqual, sha256, utf8, verify } from "@wise-biz/crypto";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";

import { COMMAND_SCHEMAS, isCommandType } from "./commands.ts";

import type { CommandHandlers, TerminalContext } from "./commands.ts";
import type { TxHandle } from "@wise-biz/db";
import type pg from "pg";

export interface QuarantineInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly reason: "bad_signature" | "chain_broken";
  readonly seq: number;
  readonly requestId: string;
  readonly now: Date;
  readonly ids: { uuidv7(): string };
}

/** What push needs from the rest of the system, wired at the composition root. */
export type SyncMetricName =
  /** Wall time of one command's transaction, labels: type, status (applied | replayed | rejected | stopped). */
  | "sync_apply_ms"
  /** Commands acknowledged by one batch (a size histogram: how far behind terminals run). */
  | "sync_batch_commands"
  /** A batch that stopped early, labels: code. */
  | "sync_stopped";
export type OnSyncMetric = (
  name: SyncMetricName,
  value: number,
  labels: Record<string, string>,
) => void;

export interface PushPorts {
  /** Optional metrics sink; a throwing sink never fails a batch. */
  readonly onMetric?: OnSyncMetric;
  readonly handlers: CommandHandlers;
  /** The terminal's Ed25519 public key (raw 32 bytes). */
  deviceKey(tx: TxHandle, tenantId: string, deviceId: string): Promise<Uint8Array | undefined>;
  /** Suspends the device with an audit row and the quarantine event, in the given transaction. */
  quarantine(tx: TxHandle, input: QuarantineInput): Promise<void>;
}

export interface PushDeps extends PushPorts {
  readonly pool: pg.Pool;
  readonly clock: { now(): number };
  readonly ids: { uuidv7(): string };
}

export interface DeviceRef {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly branchId: string;
}

export interface RawCommand {
  readonly type: string;
  /** The command exactly as the device built, hashed and signed it (including `meta`). */
  readonly body: Record<string, unknown> & {
    meta: { deviceSeq: number; prevHash: string; hash: string; signature: string };
  };
}

export interface Ack {
  readonly seq: number;
  readonly id: string | null;
  readonly type: string;
  readonly status: "applied" | "replayed" | "rejected";
  readonly result?: unknown;
  readonly error?: { code: string; message: string; details?: unknown } | undefined;
}

export type StopReason = "SEQUENCE_GAP" | "CHAIN_BROKEN" | "BAD_SIGNATURE" | "UNKNOWN_DEVICE";
export interface Stop {
  readonly seq: number;
  readonly code: StopReason;
  readonly expectedSeq?: number;
  readonly quarantined: boolean;
}

export interface BatchResult {
  readonly acks: Ack[];
  readonly stopped: Stop | null;
  /** The last sequence number the server holds for the device: the device may drop its outbox up to here. */
  readonly lastSeq: number;
}

const GENESIS = new Uint8Array(32);
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/**
 * hash = sha256(canonical({ type, seq, body without meta }) || prev_hash): exactly what the device signs. The command
 * type and sequence number are inside the hash, so a signed command cannot be relabelled or renumbered in transit.
 */
export function commandHash(
  type: string,
  seq: number,
  body: RawCommand["body"],
  prevHash: Uint8Array,
): Uint8Array {
  const rest: Record<string, unknown> = { ...body };
  delete rest.meta;
  const canon = utf8(canonicalize({ type, seq, body: rest }));
  const data = new Uint8Array(canon.length + prevHash.length);
  data.set(canon, 0);
  data.set(prevHash, canon.length);
  return sha256(data);
}

/**
 * A deterministic refusal of a validly signed command: a business rule (DomainError) or a data/integrity error from
 * the database (SQLSTATE class 22 or 23, e.g. a dangling reference). Retrying either would fail the same way forever,
 * so it is logged `rejected` and the chain moves on. Anything else is infrastructure and is rethrown (retry is safe).
 */
function refusalOf(e: unknown): Ack["error"] | undefined {
  if (e instanceof DomainError) {
    return {
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    };
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("22") || code.startsWith("23"))) {
    return {
      code: code.startsWith("23") ? "CONFLICT" : "VALIDATION_FAILED",
      message: "The command conflicts with existing data.",
    };
  }
  return undefined;
}

interface State {
  last_seq: string;
  last_hash: Buffer;
}
interface LogRow {
  command_id: string | null;
  type: string;
  hash: Buffer;
  status: "applied" | "replayed" | "rejected";
  result: unknown;
  error: Ack["error"] | null;
}

type Outcome =
  { kind: "ack"; ack: Ack; lastSeq: number } | { kind: "stop"; stop: Stop; lastSeq: number };

const idOf = (body: RawCommand["body"]): string | null =>
  typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : null;

/**
 * One command, one transaction: lock the device's chain row, check order, chain and signature, run the handler under
 * a savepoint, write the log row and move the chain. Tampering (a bad signature or hash, a chain break, the same
 * sequence number with a different hash) suspends the device in this same transaction and stops the batch. A gap
 * only stops it. A business-rule refusal rolls the handler's rows back, is logged `rejected`, and the chain moves on.
 */
async function applyOne(
  tx: TxHandle,
  deps: PushDeps,
  device: DeviceRef,
  requestId: string,
  cmd: RawCommand,
): Promise<Outcome> {
  const { tenantId, deviceId } = device;
  const seq = cmd.body.meta.deviceSeq;
  const now = new Date(deps.clock.now());
  await tx.query(
    `insert into sync.device_sync_state (tenant_id, device_id) values ($1, $2) on conflict do nothing`,
    [tenantId, deviceId],
  );
  const st = await tx.query<State>(
    `select last_seq::text, last_hash from sync.device_sync_state where tenant_id = $1 and device_id = $2 for update`,
    [tenantId, deviceId],
  );
  const state = st.rows[0];
  /* v8 ignore next -- inserted just above */
  if (state === undefined) throw new Error("internal: device sync state missing");
  const lastSeq = Number(state.last_seq);
  const lastHash = new Uint8Array(state.last_hash);
  const hash = b64(cmd.body.meta.hash);
  const quarantine = async (reason: QuarantineInput["reason"]): Promise<Outcome> => {
    await deps.quarantine(tx, { tenantId, deviceId, reason, seq, requestId, now, ids: deps.ids });
    return {
      kind: "stop",
      lastSeq,
      stop: {
        seq,
        code: reason === "chain_broken" ? "CHAIN_BROKEN" : "BAD_SIGNATURE",
        quarantined: true,
      },
    };
  };

  if (seq <= lastSeq) {
    // A resent command: the same hash replays the stored answer, any other hash is tampering.
    const log = await tx.query<LogRow>(
      `select command_id, type, hash, status, result, error from sync.sync_log
       where tenant_id = $1 and device_id = $2 and seq = $3`,
      [tenantId, deviceId, seq],
    );
    const row = log.rows[0];
    if (row === undefined || !constantTimeEqual(new Uint8Array(row.hash), hash)) {
      return quarantine("chain_broken");
    }
    return {
      kind: "ack",
      lastSeq,
      ack: {
        seq,
        id: row.command_id,
        type: row.type,
        status: row.status === "rejected" ? "rejected" : "replayed",
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.error === null ? {} : { error: row.error }),
      },
    };
  }
  if (seq > lastSeq + 1) {
    return {
      kind: "stop",
      lastSeq,
      stop: { seq, code: "SEQUENCE_GAP", expectedSeq: lastSeq + 1, quarantined: false },
    };
  }

  const prevHash = b64(cmd.body.meta.prevHash);
  if (!constantTimeEqual(prevHash, lastHash.length === 32 ? lastHash : GENESIS)) {
    return quarantine("chain_broken");
  }
  const key = await deps.deviceKey(tx, tenantId, deviceId);
  if (key === undefined) {
    return {
      kind: "stop",
      lastSeq,
      stop: { seq, code: "UNKNOWN_DEVICE", quarantined: false },
    };
  }
  const expected = commandHash(cmd.type, seq, cmd.body, prevHash);
  if (!constantTimeEqual(expected, hash) || !verify(b64(cmd.body.meta.signature), hash, key)) {
    return quarantine("bad_signature");
  }

  const terminal: TerminalContext = {
    tenantId,
    terminalId: deviceId,
    branchId: device.branchId,
    requestId,
    now,
    ids: deps.ids,
  };
  let status: Ack["status"];
  let result: unknown = null;
  let error: Ack["error"] | undefined;
  if (!isCommandType(cmd.type)) {
    status = "rejected";
    error = {
      code: "VALIDATION_FAILED",
      message: `Unknown command type "${cmd.type.slice(0, 40)}".`,
    };
  } else {
    const parsed = COMMAND_SCHEMAS[cmd.type].safeParse(cmd.body);
    if (!parsed.success) {
      status = "rejected";
      error = {
        code: "VALIDATION_FAILED",
        message: "The command does not match its schema.",
        details: {
          fieldErrors: parsed.error.issues
            .slice(0, 20)
            .map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      };
    } else {
      await tx.query("savepoint command");
      try {
        const run = deps.handlers[cmd.type] as (
          tx: TxHandle,
          t: TerminalContext,
          c: unknown,
        ) => Promise<{ body: unknown; replayed: boolean }>;
        const applied = await run(tx, terminal, parsed.data);
        await tx.query("release savepoint command");
        status = applied.replayed ? "replayed" : "applied";
        result = applied.body;
      } catch (e) {
        const refusal = refusalOf(e);
        if (refusal === undefined) throw e;
        await tx.query("rollback to savepoint command");
        status = "rejected";
        error = refusal;
      }
    }
  }
  const id = idOf(cmd.body);
  await tx.query(
    `insert into sync.sync_log (tenant_id, device_id, seq, command_id, type, hash, status, result, error, applied_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId,
      deviceId,
      seq,
      id,
      cmd.type.slice(0, 40),
      Buffer.from(hash),
      status,
      result === null ? null : JSON.stringify(result),
      error === undefined ? null : JSON.stringify(error),
      now,
    ],
  );
  await tx.query(
    `update sync.device_sync_state set last_seq = $3, last_hash = $4, updated_at = $5
     where tenant_id = $1 and device_id = $2`,
    [tenantId, deviceId, seq, Buffer.from(hash), now],
  );
  return {
    kind: "ack",
    lastSeq: seq,
    ack: {
      seq,
      id,
      type: cmd.type.slice(0, 40),
      status,
      ...(result === null ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    },
  };
}

/**
 * Applies a batch in device_seq order, each command in its own transaction. Everything before a stop is committed and
 * acked; the stop says where and why. Never throws for tampering or a gap (the caller maps a batch that processed
 * nothing to a 409): a thrown error is infrastructure and the whole request is retried safely (idempotent).
 */
export async function applyBatch(
  deps: PushDeps,
  device: DeviceRef,
  requestId: string,
  commands: readonly RawCommand[],
): Promise<BatchResult> {
  const sorted = [...commands].sort((a, b) => a.body.meta.deviceSeq - b.body.meta.deviceSeq);
  const acks: Ack[] = [];
  let lastSeq = -1;
  const emit = (name: SyncMetricName, value: number, labels: Record<string, string>): void => {
    try {
      deps.onMetric?.(name, value, labels);
    } catch {
      // metrics are best effort
    }
  };
  for (const cmd of sorted) {
    const started = performance.now();
    const out = await withTenantTx(deps.pool, { tenantId: device.tenantId, requestId }, (tx) =>
      applyOne(tx, deps, device, requestId, cmd),
    );
    lastSeq = out.lastSeq;
    emit("sync_apply_ms", performance.now() - started, {
      type: cmd.type,
      status: out.kind === "stop" ? "stopped" : out.ack.status,
    });
    if (out.kind === "stop") {
      emit("sync_stopped", 1, { code: out.stop.code });
      emit("sync_batch_commands", acks.length, {});
      return { acks, stopped: out.stop, lastSeq };
    }
    acks.push(out.ack);
  }
  emit("sync_batch_commands", acks.length, {});
  return { acks, stopped: null, lastSeq };
}
