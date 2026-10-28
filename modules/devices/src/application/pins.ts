import { hash, verify } from "@node-rs/argon2";
import { hmacSha256 } from "@wise-biz/crypto";
import { appendAudit } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";

import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult, DeviceContext } from "@wise-biz/module-kit";

/** `Algorithm.Argon2id` of @node-rs/argon2 (an ambient const enum, not importable under verbatimModuleSyntax). */
const ARGON2ID = 2;

/** Online verifier (OWASP 2025 minimum for Argon2id): ~20 ms on the API, with the pepper as the Argon2 secret. */
export const ONLINE_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};
/**
 * Offline verifier shipped in the signed policy snapshot: tuned to ≤ 150 ms on a low-end Android (Argon2id, 8 MiB,
 * t=1). No pepper (the terminal has none), so a stolen snapshot is brute-forceable: 10^4–10^8 PINs at this cost is
 * hours to days on a GPU. That is the price of offline unlock; the snapshot expires and is rotated on every PIN change.
 */
export const OFFLINE_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 8_192,
  timeCost: 1,
  parallelism: 1,
};
export const MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Supplied by the composition root: tenancy owns memberships. */
export type IsActiveMember = (tx: TxHandle, tenantId: string, userId: string) => Promise<boolean>;

export interface PinDeps {
  pepper: Uint8Array;
  isActiveMember: IsActiveMember;
}

const PIN = /^\d{4,8}$/;

/** 4–8 digits, not one repeated digit and not a straight run (1234, 9876). */
export function weakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  // Digits only (checked by the caller), so indexing by UTF-16 unit is exact.
  const steps = new Set(
    Array.from({ length: pin.length - 1 }, (_, i) => pin.charCodeAt(i + 1) - pin.charCodeAt(i)),
  );
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

const lookup = (pepper: Uint8Array, tenantId: string, pin: string): Buffer =>
  Buffer.from(hmacSha256(pepper, `wb-pin:v1:${tenantId}:${pin}`));

const fail = (message: string): never => {
  throw new DomainError("VALIDATION_FAILED", message, { fieldErrors: [{ path: "pin", message }] });
};

/** An operator sets their own PIN for the active business (any active member). */
export async function setPinCommand(
  tx: TxHandle,
  ctx: CommandContext,
  pin: string,
  deps: PinDeps,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  if (!PIN.test(pin)) fail("Use 4 to 8 digits.");
  if (weakPin(pin)) fail("Avoid repeated or sequential digits.");
  if (!(await deps.isActiveMember(tx, tenantId, ctx.userId))) {
    throw new DomainError("NOT_FOUND", "not found");
  }
  const secret = Buffer.from(deps.pepper);
  const [pinHash, offline] = await Promise.all([
    hash(pin, { ...ONLINE_PARAMS, secret }),
    hash(pin, OFFLINE_PARAMS),
  ]);
  try {
    await tx.query(
      `insert into devices.operator_pins (tenant_id, user_id, pin_hash, pin_lookup, offline_verifier, set_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, user_id) do update set pin_hash = excluded.pin_hash, pin_lookup = excluded.pin_lookup,
         offline_verifier = excluded.offline_verifier, failed_attempts = 0, locked_at = null, set_at = excluded.set_at`,
      [tenantId, ctx.userId, pinHash, lookup(deps.pepper, tenantId, pin), offline, ctx.now],
    );
  } catch (e) {
    // Unique per tenant (security.md): another operator holds it. Same wording as any other refusal.
    if ((e as { code?: string }).code === "23505") fail("Choose a different PIN.");
    throw e;
  }
  return {
    status: 200,
    body: { set: true, setAt: ctx.now.toISOString() },
    audit: [{ action: "devices.pin.set", entity: "devices.operator_pin", entityId: ctx.userId }],
    noEvents: true,
  };
}

/** A supervisor unlocks a locked PIN (the operator keeps it). */
export async function resetPinCommand(
  tx: TxHandle,
  ctx: CommandContext,
  userId: string,
): Promise<CommandResult> {
  const r = await tx.query<{ failed_attempts: number; locked: boolean }>(
    `select failed_attempts, locked_at is not null as locked from devices.operator_pins
     where tenant_id = $1 and user_id = $2 for update`,
    [ctx.tenant.tenantId, userId],
  );
  const before = r.rows[0];
  if (before === undefined) throw new DomainError("NOT_FOUND", "not found");
  await tx.query(
    "update devices.operator_pins set failed_attempts = 0, locked_at = null where tenant_id = $1 and user_id = $2",
    [ctx.tenant.tenantId, userId],
  );
  return {
    status: 200,
    body: { reset: true },
    audit: [
      {
        action: "devices.pin.reset",
        entity: "devices.operator_pin",
        entityId: userId,
        before: { failedAttempts: before.failed_attempts, locked: before.locked },
        after: { failedAttempts: 0, locked: false },
      },
    ],
    noEvents: true,
  };
}

export type PinLoginResult =
  | { ok: true; sessionId: string; userId: string; expiresAt: string }
  | { ok: false; locked: boolean };

// Verified when the operator has no PIN, so an unknown operator costs the same time as a wrong PIN.
let dummyHash: Promise<string> | undefined;

/**
 * Terminal: unlock for one operator. Returns instead of throwing on a wrong PIN, so the caller COMMITS the failed
 * attempt (and its audit row) before answering 401. The 5th failure locks the PIN until a supervisor resets it.
 */
export async function pinLogin(
  tx: TxHandle,
  device: DeviceContext,
  input: { userId: string; pin: string },
  deps: PinDeps & { ids: { uuidv7(): string }; now: Date; requestId: string },
): Promise<PinLoginResult> {
  const r = await tx.query<{ pin_hash: string; failed_attempts: number; locked: boolean }>(
    `select pin_hash, failed_attempts, locked_at is not null as locked from devices.operator_pins
     where tenant_id = $1 and user_id = $2 for update`,
    [device.tenantId, input.userId],
  );
  const row = r.rows[0];
  const secret = Buffer.from(deps.pepper);
  const audit = (action: string, after?: unknown) =>
    appendAudit(tx, [
      {
        actorType: "device",
        actorId: device.deviceId,
        deviceId: device.deviceId,
        action,
        entity: "devices.operator_pin",
        entityId: input.userId,
        ...(after === undefined ? {} : { after }),
        requestId: deps.requestId,
      },
    ]);

  if (row === undefined) {
    dummyHash ??= hash("0000-not-a-pin", { ...ONLINE_PARAMS, secret });
    await verify(await dummyHash, input.pin, { secret });
    return { ok: false, locked: false };
  }
  if (row.locked) return { ok: false, locked: true };

  const good =
    PIN.test(input.pin) &&
    (await verify(row.pin_hash, input.pin, { secret })) &&
    (await deps.isActiveMember(tx, device.tenantId, input.userId));
  if (!good) {
    const failed = row.failed_attempts + 1;
    const locked = failed >= MAX_ATTEMPTS;
    await tx.query(
      `update devices.operator_pins set failed_attempts = $3, locked_at = $4 where tenant_id = $1 and user_id = $2`,
      [device.tenantId, input.userId, failed, locked ? deps.now : null],
    );
    await audit(locked ? "devices.pin.locked" : "devices.pin.failed", { failedAttempts: failed });
    return { ok: false, locked };
  }

  if (row.failed_attempts > 0) {
    await tx.query(
      "update devices.operator_pins set failed_attempts = 0 where tenant_id = $1 and user_id = $2",
      [device.tenantId, input.userId],
    );
  }
  // One operator per terminal at a time: a new unlock ends the previous session on this device.
  await tx.query(
    `update devices.operator_sessions set ended_at = $3 where tenant_id = $1 and device_id = $2 and ended_at is null`,
    [device.tenantId, device.deviceId, deps.now],
  );
  const sessionId = deps.ids.uuidv7();
  const expiresAt = new Date(deps.now.getTime() + SESSION_TTL_MS);
  await tx.query(
    `insert into devices.operator_sessions (id, tenant_id, device_id, user_id, started_at, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [sessionId, device.tenantId, device.deviceId, input.userId, deps.now, expiresAt],
  );
  await audit("devices.operator.signed_in", { sessionId });
  return { ok: true, sessionId, userId: input.userId, expiresAt: expiresAt.toISOString() };
}

/** Terminal: end the current operator session (no error when none is open). */
export async function pinLogout(
  tx: TxHandle,
  device: DeviceContext,
  now: Date,
  requestId: string,
): Promise<void> {
  const r = await tx.query<{ id: string }>(
    `update devices.operator_sessions set ended_at = $3 where tenant_id = $1 and device_id = $2 and ended_at is null
     returning id`,
    [device.tenantId, device.deviceId, now],
  );
  const ended = r.rows[0];
  if (ended === undefined) return;
  await appendAudit(tx, [
    {
      actorType: "device",
      actorId: device.deviceId,
      deviceId: device.deviceId,
      action: "devices.operator.signed_out",
      entity: "devices.operator_session",
      entityId: ended.id,
      requestId,
    },
  ]);
}
