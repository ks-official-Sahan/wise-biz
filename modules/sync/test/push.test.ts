import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { generateKeyPair, sign } from "@wise-biz/crypto";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { devicePublicKey, quarantineDevice } from "@wise-biz/module-devices";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyBatch, commandHash, createSyncModule } from "../src/index.ts";

import type { PushDeps, PushPorts, RawCommand } from "../src/index.ts";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const BRANCH = uuidv7();
const OPERATOR = uuidv7();
const SHIFT = uuidv7();
const GENESIS = Buffer.alloc(32).toString("base64");
const iso = () => new Date().toISOString();

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let calls: string[] = [];
let failWith: (type: string) => Error | undefined = () => undefined;

const handle =
  (type: string) =>
  async (
    tx: TxHandle,
    _t: unknown,
    cmd: unknown,
  ): Promise<{ body: unknown; replayed: boolean }> => {
    const id = (cmd as { id: string }).id;
    calls.push(`${type}:${id}`);
    await tx.query("insert into public.sync_test_marks (id) values ($1)", [id]);
    const err = failWith(id);
    if (err !== undefined) throw err;
    return { body: { ok: true, id }, replayed: false };
  };
const ports: PushPorts = {
  handlers: {
    complete_sale: handle("complete_sale"),
    complete_return: handle("complete_return"),
    void_sale: handle("void_sale"),
    open_shift: handle("open_shift"),
    close_shift: handle("close_shift"),
    open_drawer: handle("open_drawer"),
    cash_movement: handle("cash_movement"),
    record_override: handle("record_override"),
  },
  deviceKey: devicePublicKey,
  quarantine: quarantineDevice,
};
const deps = (): PushDeps => ({
  ...ports,
  pool,
  clock: { now: () => Date.now() },
  ids: { uuidv7 },
});

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "devices", dir: dir("devices") },
    { module: "sync", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 10 });
  admin = createPool(db.url("admin"));
  await admin.query("create table public.sync_test_marks (id uuid primary key)");
  await admin.query("grant select, insert on public.sync_test_marks to wb_app");
  // The marks table has no tenant column: the handler stub only needs rows to roll back.
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});
beforeEach(() => {
  calls = [];
  failWith = () => undefined;
});

interface Dev {
  deviceId: string;
  secretKey: Uint8Array;
  ref: { tenantId: string; deviceId: string; branchId: string };
  next: number;
  last: string;
}
async function enroll(): Promise<Dev> {
  const keys = generateKeyPair();
  const deviceId = uuidv7();
  await admin.query(
    `insert into devices.devices (id, tenant_id, branch_id, name, platform, app_version, status, public_key, enrolled_by)
     values ($1, $2, $3, 'Till', 'linux', '1.0.0', 'active', $4, $5)`,
    [deviceId, T, BRANCH, Buffer.from(keys.publicKey), OPERATOR],
  );
  return {
    deviceId,
    secretKey: keys.secretKey,
    ref: { tenantId: T, deviceId, branchId: BRANCH },
    next: 0,
    last: GENESIS,
  };
}

/** A cash_movement command, built and signed the way a terminal does (hash over the body without meta + prev). */
function command(
  d: Dev,
  over: {
    seq?: number;
    prev?: string;
    key?: Uint8Array;
    type?: string;
    amount?: number;
    tamper?: boolean;
  } = {},
): RawCommand {
  const seq = over.seq ?? d.next;
  const prev = over.prev ?? d.last;
  const body: Record<string, unknown> = {
    id: uuidv7(),
    shiftId: SHIFT,
    operatorId: OPERATOR,
    kind: "pay_in",
    amountMinor: over.amount ?? 100,
    occurredAt: iso(),
    reason: "Float",
  };
  const hash = commandHash(
    over.type ?? "cash_movement",
    seq,
    body as RawCommand["body"],
    new Uint8Array(Buffer.from(prev, "base64")),
  );
  const signature = sign(hash, over.key ?? d.secretKey);
  const meta = {
    deviceSeq: seq,
    prevHash: prev,
    hash: Buffer.from(hash).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
  };
  if (over.tamper === true) body.amountMinor = 999_999;
  if (over.seq === undefined && over.prev === undefined) {
    d.next = seq + 1;
    d.last = meta.hash;
  }
  return { type: over.type ?? "cash_movement", body: { ...body, meta } };
}
const state = async (d: Dev) =>
  (
    await admin.query<{ last_seq: string }>(
      "select last_seq::text from sync.device_sync_state where device_id = $1",
      [d.deviceId],
    )
  ).rows[0]?.last_seq;
const status = async (d: Dev) =>
  (
    await admin.query<{ status: string }>("select status from devices.devices where id = $1", [
      d.deviceId,
    ])
  ).rows[0]?.status;
const marks = async () =>
  Number(
    (await admin.query<{ n: string }>("select count(*) n from public.sync_test_marks")).rows[0]?.n,
  );

describe("push", () => {
  it("applies in device_seq order, acks each, and advances the chain", async () => {
    const d = await enroll();
    const [c0, c1, c2] = [command(d), command(d), command(d)] as [
      RawCommand,
      RawCommand,
      RawCommand,
    ];
    const r = await applyBatch(deps(), d.ref, "req-1", [c2, c0, c1]);
    expect(r.stopped).toBeNull();
    expect(r.acks.map((a) => [a.seq, a.status])).toEqual([
      [0, "applied"],
      [1, "applied"],
      [2, "applied"],
    ]);
    expect(r.lastSeq).toBe(2);
    expect(await state(d)).toBe("2");
    expect(calls).toHaveLength(3);
    expect(r.acks[0]?.result).toMatchObject({ ok: true });
  });

  it("a resent batch replays the stored answers without running anything again", async () => {
    const d = await enroll();
    const batch = [command(d), command(d)];
    const first = await applyBatch(deps(), d.ref, "req-1", batch);
    calls = [];
    const again = await applyBatch(deps(), d.ref, "req-2", batch);
    expect(again.acks.map((a) => a.status)).toEqual(["replayed", "replayed"]);
    expect(again.acks.map((a) => a.id)).toEqual(first.acks.map((a) => a.id));
    expect(again.acks[0]?.result).toEqual(first.acks[0]?.result);
    expect(calls).toEqual([]);
    expect(await status(d)).toBe("active");
  });

  it("two overlapping batches of one device apply each command once", async () => {
    const d = await enroll();
    const batch = [command(d), command(d), command(d)];
    const [a, b] = await Promise.all([
      applyBatch(deps(), d.ref, "req-a", batch),
      applyBatch(deps(), d.ref, "req-b", batch),
    ]);
    const statuses = [...a.acks, ...b.acks].map((x) => x.status).sort();
    expect(statuses).toEqual(["applied", "applied", "applied", "replayed", "replayed", "replayed"]);
    expect(calls).toHaveLength(3);
  });

  it("a sequence gap stops the batch; what came before it stays committed", async () => {
    const d = await enroll();
    const c0 = command(d);
    const c1 = command(d);
    command(d); // seq 2, never sent
    const c3 = command(d);
    const r = await applyBatch(deps(), d.ref, "req", [c0, c1, c3]);
    expect(r.acks.map((a) => a.seq)).toEqual([0, 1]);
    expect(r.stopped).toEqual({ seq: 3, code: "SEQUENCE_GAP", expectedSeq: 2, quarantined: false });
    expect(r.lastSeq).toBe(1);
    expect(await status(d)).toBe("active");
    // Out-of-order arrival at the start: nothing runs, the device is told where to resume.
    const d2 = await enroll();
    command(d2);
    const late = command(d2);
    const gap = await applyBatch(deps(), d2.ref, "req", [late]);
    expect(gap.acks).toEqual([]);
    expect(gap.stopped).toMatchObject({ code: "SEQUENCE_GAP", expectedSeq: 0 });
  });

  it("a forged signature or a tampered body quarantines the device and stops", async () => {
    const d = await enroll();
    const other = generateKeyPair();
    const forged = command(d, { key: other.secretKey });
    const r = await applyBatch(deps(), d.ref, "req", [forged]);
    expect(r.stopped).toMatchObject({ code: "BAD_SIGNATURE", quarantined: true });
    expect(await status(d)).toBe("suspended");
    expect(await state(d)).toBe("-1");
    expect(calls).toEqual([]);
    const ev = await admin.query<{ type: string }>(
      "select type from infra.outbox where payload->>'subject' = $1 order by id",
      [`device/${d.deviceId}`],
    );
    expect(ev.rows.map((e) => e.type)).toEqual([
      "devices.device.quarantined",
      "devices.device.status_changed",
    ]);
    const audit = await admin.query<{ actor_type: string }>(
      "select actor_type from audit.audit_log where entity_id = $1 and action = 'devices.device.quarantined'",
      [d.deviceId],
    );
    expect(audit.rows).toEqual([{ actor_type: "system" }]);

    const t = await enroll();
    const tampered = command(t, { tamper: true });
    const tr = await applyBatch(deps(), t.ref, "req", [tampered]);
    expect(tr.stopped).toMatchObject({ code: "BAD_SIGNATURE", quarantined: true });
    expect(await status(t)).toBe("suspended");
  });

  it("a broken chain quarantines the device; so does the same seq with another hash", async () => {
    const d = await enroll();
    const wrongPrev = command(d, { seq: 0, prev: Buffer.alloc(32, 7).toString("base64") });
    const r = await applyBatch(deps(), d.ref, "req", [wrongPrev]);
    expect(r.stopped).toMatchObject({ code: "CHAIN_BROKEN", quarantined: true });
    expect(await status(d)).toBe("suspended");

    const e = await enroll();
    const ok = command(e);
    await applyBatch(deps(), e.ref, "req", [ok]);
    const rewrite = command(e, { seq: 0, prev: GENESIS });
    const rr = await applyBatch(deps(), e.ref, "req", [rewrite]);
    expect(rr.stopped).toMatchObject({ code: "CHAIN_BROKEN", quarantined: true });
    expect(await status(e)).toBe("suspended");
  });

  it("a command relabelled or renumbered in transit fails verification", async () => {
    const d = await enroll();
    const signedAsMovement = command(d);
    const relabelled = { ...signedAsMovement, type: "open_drawer" };
    const r = await applyBatch(deps(), d.ref, "req", [relabelled]);
    expect(r.stopped).toMatchObject({ code: "BAD_SIGNATURE", quarantined: true });
    expect(await status(d)).toBe("suspended");
  });

  it("a database data error on a signed command is a rejection, not an endless 500", async () => {
    const d = await enroll();
    const bad = command(d);
    const badId = bad.body.id as string;
    failWith = (id) =>
      id === badId ? Object.assign(new Error("fk"), { code: "23503" }) : undefined;
    const r = await applyBatch(deps(), d.ref, "req", [bad, command(d)]);
    expect(r.acks.map((x) => [x.status, x.error?.code])).toEqual([
      ["rejected", "CONFLICT"],
      ["applied", undefined],
    ]);
    expect(await state(d)).toBe("1");
  });

  it("a device suspended mid-batch applies nothing more", async () => {
    const d = await enroll();
    const first = command(d);
    const second = command(d);
    const firstId = first.body.id as string;
    failWith = (id) => {
      if (id === firstId) {
        // Another request quarantines the device while this batch is in flight.
        void admin.query("update devices.devices set status = 'suspended' where id = $1", [
          d.deviceId,
        ]);
      }
      return undefined;
    };
    await applyBatch(deps(), d.ref, "req", [first]);
    await new Promise((r) => setTimeout(r, 100));
    const r = await applyBatch(deps(), d.ref, "req", [second]);
    expect(r.acks).toEqual([]);
    expect(r.stopped).toMatchObject({ code: "UNKNOWN_DEVICE" });
  });

  it("the app role cannot rewind or skip the chain", async () => {
    const d = await enroll();
    await applyBatch(deps(), d.ref, "req", [command(d), command(d)]);
    const skip = withTenantTx(pool, { tenantId: T, requestId: "req" }, (tx) =>
      tx.query("update sync.device_sync_state set last_seq = 9 where device_id = $1", [d.deviceId]),
    );
    await expect(skip).rejects.toThrow("advance by one");
  });

  it("a mixed batch: a refused command rolls back its rows, is logged rejected, and the chain moves on", async () => {
    const d = await enroll();
    const a = command(d);
    const refused = command(d);
    const c = command(d);
    const refusedId = refused.body.id as string;
    failWith = (id) =>
      id === refusedId
        ? new DomainError("CONFLICT", "No can do", { details: { x: 1 } })
        : undefined;
    const before = await marks();
    const r = await applyBatch(deps(), d.ref, "req", [a, refused, c]);
    expect(r.stopped).toBeNull();
    expect(r.acks.map((x) => x.status)).toEqual(["applied", "rejected", "applied"]);
    expect(r.acks[1]?.error).toEqual({ code: "CONFLICT", message: "No can do", details: { x: 1 } });
    expect(await marks()).toBe(before + 2); // the refused command's row was rolled back
    expect(await state(d)).toBe("2");
    // Resending the rejected command answers the same, runs nothing.
    calls = [];
    const again = await applyBatch(deps(), d.ref, "req", [refused]);
    expect(again.acks[0]).toMatchObject({ status: "rejected", error: { code: "CONFLICT" } });
    expect(calls).toEqual([]);
  });

  it("an unknown type or a malformed body is rejected and the chain still advances", async () => {
    const d = await enroll();
    const unknown = command(d, { type: "teleport" });
    const malformed = command(d, { amount: -5 });
    const r = await applyBatch(deps(), d.ref, "req", [unknown, malformed]);
    expect(r.acks.map((a) => [a.status, a.error?.code])).toEqual([
      ["rejected", "VALIDATION_FAILED"],
      ["rejected", "VALIDATION_FAILED"],
    ]);
    expect(await state(d)).toBe("1");
    expect(calls).toEqual([]);
  });

  it("an infrastructure failure throws and leaves the chain where it was (the retry is safe)", async () => {
    const d = await enroll();
    const a = command(d);
    const boom = command(d);
    const boomId = boom.body.id as string;
    failWith = (id) => (id === boomId ? new Error("db down") : undefined);
    await expect(applyBatch(deps(), d.ref, "req", [a, boom])).rejects.toThrow("db down");
    expect(await state(d)).toBe("0");
    failWith = () => undefined;
    const retry = await applyBatch(deps(), d.ref, "req", [a, boom]);
    expect(retry.acks.map((x) => x.status)).toEqual(["replayed", "applied"]);
  });
});

describe("POST /v1/sync/commands", () => {
  let app: OpenAPIHono<AppEnv>;
  let deviceStatus: "active" | "suspended" | undefined = "active";
  let current: Dev;
  beforeAll(async () => {
    current = await enroll();
    app = new OpenAPIHono<AppEnv>({
      defaultHook: (r) => {
        if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
      },
    });
    app.use("*", async (c, next) => {
      c.set("requestId", "req-12345678");
      c.set(
        "device",
        deviceStatus === undefined
          ? undefined
          : { deviceId: current.deviceId, tenantId: T, branchId: BRANCH, status: deviceStatus },
      );
      await next();
    });
    app.onError((err, c) => {
      const p = toProblem(err, "r");
      const details = err instanceof DomainError ? err.details : undefined;
      return c.json({ ...p, details }, p.status as 409);
    });
    createSyncModule({
      ...ports,
      branchLocations: () => Promise.resolve([]),
      store: {
        presignPut: () => "",
        presignGet: () => "",
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
      },
    }).routes(app, {
      pool,
      clock: { now: () => Date.now() },
      ids: { uuidv7 },
    });
  });
  const post = (commands: unknown[]) =>
    app.request("/v1/sync/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
    });

  it("acks a batch, and answers a batch that processed nothing with 409 SEQUENCE_GAP", async () => {
    const res = await post([command(current), command(current)]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      acks: { status: string }[];
      stopped: unknown;
      lastSeq: number;
    };
    expect(body.acks.map((a) => a.status)).toEqual(["applied", "applied"]);
    expect(body).toMatchObject({ stopped: null, lastSeq: 1 });
    command(current); // seq 2 never sent
    const gap = await post([command(current)]);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ code: "SEQUENCE_GAP", details: { expectedSeq: 2 } });
  });

  it("refuses a duplicate seq, an empty or oversized batch, a suspended or unsigned device", async () => {
    const dup = command(current, { seq: 50, prev: GENESIS });
    expect((await post([dup, dup])).status).toBe(422);
    expect((await post([])).status).toBe(422);
    const many = Array.from({ length: 101 }, (_, i) =>
      command(current, { seq: i + 100, prev: GENESIS }),
    );
    expect((await post(many)).status).toBe(422);
    const big = command(current, { seq: 300, prev: GENESIS });
    const huge = Array.from({ length: 60 }, () => ({
      ...big,
      body: { ...big.body, reason: "x".repeat(6000) },
    }));
    expect((await post(huge)).status).toBe(413);
    deviceStatus = "suspended";
    expect((await post([command(current, { seq: 400, prev: GENESIS })])).status).toBe(401);
    deviceStatus = undefined;
    expect((await post([command(current, { seq: 400, prev: GENESIS })])).status).toBe(401);
    deviceStatus = "active";
  });

  it("a chain break on the first command is 409 CHAIN_BROKEN and the device is suspended", async () => {
    const d = await enroll();
    current = d;
    const res = await post([command(d, { seq: 0, prev: Buffer.alloc(32, 9).toString("base64") })]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CHAIN_BROKEN" });
    expect(await status(d)).toBe("suspended");
  });
});
