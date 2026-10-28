import { fromBase64url } from "@wise-biz/crypto";
import { appendAudit, appendOutbox, withLookupTx, withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";

import {
  CODE_TTL_MS,
  canTransition,
  codeHash,
  newEnrollmentCode,
  normaliseCode,
} from "../domain/device.ts";
import { DEVICES_TOPIC, DeviceEnrolledV1, DeviceStatusChangedV1 } from "../events.ts";

import type { DeviceStatus } from "../domain/device.ts";
import type { DeviceDto, EnrollInput, HeartbeatInput, UpdateDeviceInput } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type pg from "pg";

const notFound = (): never => {
  throw new DomainError("NOT_FOUND", "not found");
};

/** Branch check supplied by the composition root (tenancy owns branches; no cross-module table reads here). */
export type BranchExists = (tx: TxHandle, tenantId: string, branchId: string) => Promise<boolean>;

interface DeviceRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  name: string;
  platform: DeviceDto["platform"];
  app_version: string;
  status: DeviceStatus;
  enrolled_at: Date;
  last_seen_at: Date | null;
}

const COLUMNS =
  "id, tenant_id, branch_id, name, platform, app_version, status, enrolled_at, last_seen_at";

const toDto = (r: DeviceRow): DeviceDto => ({
  deviceId: r.id,
  tenantId: r.tenant_id,
  branchId: r.branch_id,
  name: r.name,
  platform: r.platform,
  appVersion: r.app_version,
  status: r.status,
  enrolledAt: r.enrolled_at.toISOString(),
  lastSeenAt: r.last_seen_at?.toISOString() ?? null,
});

const event = <T>(
  def: { type: string; version: number; parse(v: unknown): T & { id: string } },
  ctx: { ids: { uuidv7(): string }; now: Date; requestId: string },
  tenantId: string,
  deviceId: string,
  actor: { type: "user" | "device"; id: string },
  data: unknown,
) => {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/devices",
    tenantId,
    subject: `device/${deviceId}`,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor,
    data,
  });
  return {
    id: e.id,
    topic: DEVICES_TOPIC,
    key: deviceId,
    type: def.type,
    version: def.version,
    payload: e,
  };
};

/** Console: a one-time code for one branch. The plain code is in the response only (never stored or audited). */
export async function createEnrollmentCodeCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: { branchId: string; name: string },
  branchExists: BranchExists,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  if (!(await branchExists(tx, tenantId, input.branchId))) notFound();
  const code = newEnrollmentCode();
  const expiresAt = new Date(ctx.now.getTime() + CODE_TTL_MS);
  const id = ctx.ids.uuidv7();
  await tx.query(
    `insert into devices.enrollment_codes (id, tenant_id, code_hash, branch_id, name, created_by, expires_at)
     values ($1, $2, decode($3, 'hex'), $4, $5, $6, $7)`,
    [
      id,
      tenantId,
      codeHash(normaliseCode(code) ?? ""),
      input.branchId,
      input.name,
      ctx.userId,
      expiresAt,
    ],
  );
  return {
    status: 201,
    body: { code, qr: `wb-enroll:${code}`, expiresAt: expiresAt.toISOString(), ...input },
    audit: [
      {
        action: "devices.enrollment_code.created",
        entity: "devices.enrollment_code",
        entityId: id,
        after: { branchId: input.branchId, name: input.name, expiresAt: expiresAt.toISOString() },
      },
    ],
    noEvents: true,
  };
}

export interface EnrollDeps {
  pool: pg.Pool;
  ids: { uuidv7(): string };
  clock: { now(): number };
  /** Proves the caller holds the private key it enrolls (the enroll request is signed with it). */
  verifyPossession: (publicKey: Uint8Array) => Promise<boolean>;
}

interface CodeRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  name: string;
  created_by: string;
  expires_at: Date;
  redeemed_at: Date | null;
}

/**
 * Terminal: redeem a code with a new key. Every refusal is the same 404 (unknown, expired, used or unsigned code),
 * so a guesser learns nothing. The code row is claimed with a conditional UPDATE: two terminals racing one code get
 * one device.
 */
export async function enroll(
  deps: EnrollDeps,
  input: EnrollInput,
  requestId: string,
  ip?: string,
): Promise<DeviceDto> {
  const normalised = normaliseCode(input.code) ?? notFound();
  const hash = codeHash(normalised);
  const code = await withLookupTx(
    deps.pool,
    { key: "enrollment_code", value: hash, requestId },
    async (tx) => {
      const r = await tx.query<CodeRow>(
        `select id, tenant_id, branch_id, name, created_by, expires_at, redeemed_at from devices.enrollment_codes
       where code_hash = decode($1, 'hex')`,
        [hash],
      );
      return r.rows[0];
    },
  );
  const now = new Date(deps.clock.now());
  if (code?.redeemed_at !== null || code.expires_at <= now) return notFound();
  const valid = code;
  const publicKey = fromBase64url(input.publicKey);
  if (publicKey.length !== 32 || !(await deps.verifyPossession(publicKey))) notFound();

  return withTenantTx(deps.pool, { tenantId: valid.tenant_id, requestId }, async (tx) => {
    let row: DeviceRow | undefined;
    try {
      const r = await tx.query<DeviceRow>(
        `insert into devices.devices (id, tenant_id, branch_id, name, platform, app_version, public_key, enrolled_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
        [
          input.deviceId,
          valid.tenant_id,
          valid.branch_id,
          valid.name,
          input.platform,
          input.appVersion,
          publicKey,
          valid.created_by,
        ],
      );
      row = r.rows[0];
    } catch (e) {
      // Reused device id or key: refuse like any other bad code.
      if ((e as { code?: string }).code === "23505") notFound();
      throw e;
    }
    const dto = toDto(row ?? notFound());
    // Claim the code after the device row exists (composite FK). A terminal that loses the race gets 0 rows, and the
    // throw rolls its device insert back.
    const claimed = await tx.query(
      `update devices.enrollment_codes set redeemed_at = $2, device_id = $3
       where tenant_id = $4 and id = $1 and redeemed_at is null and expires_at > $2`,
      [valid.id, now, input.deviceId, valid.tenant_id],
    );
    if (claimed.rowCount !== 1) notFound();
    await appendAudit(tx, [
      {
        actorType: "device",
        actorId: dto.deviceId,
        deviceId: dto.deviceId,
        action: "devices.device.enrolled",
        entity: "devices.device",
        entityId: dto.deviceId,
        after: dto,
        requestId,
        ...(ip === undefined ? {} : { ip }),
      },
    ]);
    await appendOutbox(tx, [
      event(
        DeviceEnrolledV1,
        { ids: deps.ids, now, requestId },
        valid.tenant_id,
        dto.deviceId,
        { type: "device", id: dto.deviceId },
        {
          deviceId: dto.deviceId,
          branchId: dto.branchId,
          platform: dto.platform,
          appVersion: dto.appVersion,
        },
      ),
    ]);
    return dto;
  });
}

/** Console list: one query, newest first (a tenant has tens of terminals, not thousands). */
export async function listDevices(tx: TxHandle, tenantId: string): Promise<DeviceDto[]> {
  const r = await tx.query<DeviceRow>(
    `select ${COLUMNS} from devices.devices where tenant_id = $1 order by enrolled_at desc, id desc limit 500`,
    [tenantId],
  );
  return r.rows.map(toDto);
}

/** Console: rename, move branch, or change status. Revoked and blacklisted are terminal. */
export async function updateDeviceCommand(
  tx: TxHandle,
  ctx: CommandContext,
  deviceId: string,
  input: UpdateDeviceInput,
  branchExists: BranchExists,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const r = await tx.query<DeviceRow>(
    `select ${COLUMNS} from devices.devices where tenant_id = $1 and id = $2 for update`,
    [tenantId, deviceId],
  );
  const before = toDto(r.rows[0] ?? notFound());
  if (
    input.status !== undefined &&
    input.status !== before.status &&
    !canTransition(before.status, input.status)
  ) {
    throw new DomainError("CONFLICT", `a ${before.status} device cannot become ${input.status}`);
  }
  if (input.branchId !== undefined && !(await branchExists(tx, tenantId, input.branchId)))
    notFound();
  const statusChanged = input.status !== undefined && input.status !== before.status;
  const u = await tx.query<DeviceRow>(
    `update devices.devices set
       name = coalesce($3, name),
       branch_id = coalesce($4, branch_id),
       status = coalesce($5, status),
       status_changed_at = case when $6 then $7 else status_changed_at end
     where tenant_id = $1 and id = $2 returning ${COLUMNS}`,
    [
      tenantId,
      deviceId,
      input.name ?? null,
      input.branchId ?? null,
      input.status ?? null,
      statusChanged,
      ctx.now,
    ],
  );
  const after = toDto(u.rows[0] ?? notFound());
  const events = statusChanged
    ? [
        event(
          DeviceStatusChangedV1,
          ctx,
          tenantId,
          deviceId,
          { type: "user", id: ctx.userId },
          {
            deviceId,
            branchId: after.branchId,
            from: before.status,
            status: after.status,
          },
        ),
      ]
    : [];
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: statusChanged
          ? `devices.device.${after.status === "active" ? "reactivated" : after.status}`
          : "devices.device.updated",
        entity: "devices.device",
        entityId: deviceId,
        before,
        after,
      },
    ],
    ...(events.length > 0 ? { events } : { noEvents: true }),
  };
}

export interface DeviceAuth {
  deviceId: string;
  tenantId: string;
  branchId: string;
  status: DeviceStatus;
  publicKey: Uint8Array;
}

/** The signed-request lookup: one indexed row by id, before the tenant is known (lookup_device policy). */
export async function resolveDevice(
  pool: pg.Pool,
  deviceId: string,
  requestId: string,
): Promise<DeviceAuth | null> {
  return withLookupTx(pool, { key: "device_id", value: deviceId, requestId }, async (tx) => {
    const r = await tx.query<{
      tenant_id: string;
      branch_id: string;
      status: DeviceStatus;
      public_key: Buffer;
    }>("select tenant_id, branch_id, status, public_key from devices.devices where id = $1", [
      deviceId,
    ]);
    const row = r.rows[0];
    return row === undefined
      ? null
      : {
          deviceId,
          tenantId: row.tenant_id,
          branchId: row.branch_id,
          status: row.status,
          publicKey: new Uint8Array(row.public_key),
        };
  });
}

/**
 * Terminal heartbeat. Telemetry, not a business mutation: no audit row and no event per beat (one a minute per
 * terminal would drown the audit log); status changes it reveals are audited where they happen.
 */
export async function recordHeartbeat(
  tx: TxHandle,
  device: { tenantId: string; deviceId: string },
  input: HeartbeatInput,
  now: Date,
): Promise<void> {
  await tx.query(
    `with beat as (
       insert into devices.device_heartbeats
         (tenant_id, device_id, at, app_version, battery_pct, unsynced_count, oldest_unsynced_at, operator_id, connection)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     )
     update devices.devices set last_seen_at = $3, app_version = $4 where tenant_id = $1 and id = $2`,
    [
      device.tenantId,
      device.deviceId,
      now,
      input.appVersion,
      input.batteryPct ?? null,
      input.unsyncedCount,
      input.oldestUnsyncedAt ?? null,
      input.operatorId ?? null,
      input.connection ?? null,
    ],
  );
}
