import { join } from "node:path";

import { generateKeyPair } from "@wise-biz/crypto";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { devicePublicKey, quarantineDevice } from "../src/index.ts";

import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const BRANCH = uuidv7();
let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "devices", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});

const tx = <R>(fn: Parameters<typeof withTenantTx<R>>[2]) =>
  withTenantTx(pool, { tenantId: T, requestId: "req-12345678" }, fn);
async function device(status = "active") {
  const keys = generateKeyPair();
  const id = uuidv7();
  await admin.query(
    `insert into devices.devices (id, tenant_id, branch_id, name, platform, app_version, status, public_key, enrolled_by)
     values ($1, $2, $3, 'Till', 'linux', '1.0.0', $4, $5, $6)`,
    [id, T, BRANCH, status, Buffer.from(keys.publicKey), uuidv7()],
  );
  return { id, publicKey: keys.publicKey };
}
const input = (deviceId: string) => ({
  tenantId: T,
  deviceId,
  reason: "chain_broken" as const,
  seq: 7,
  requestId: "req-12345678",
  now: new Date(),
  ids: { uuidv7 },
});

describe("quarantine and device key", () => {
  it("suspends an active device with an audit row and both events, once", async () => {
    const d = await device();
    await tx((x) => quarantineDevice(x, input(d.id)));
    const row = await admin.query<{ status: string }>(
      "select status from devices.devices where id = $1",
      [d.id],
    );
    expect(row.rows[0]?.status).toBe("suspended");
    const types = await admin.query<{ type: string }>(
      "select type from infra.outbox where payload->>'subject' = $1 order by id",
      [`device/${d.id}`],
    );
    expect(types.rows.map((r) => r.type)).toEqual([
      "devices.device.quarantined",
      "devices.device.status_changed",
    ]);
    const audit = await admin.query<{ actor_type: string; reason: string }>(
      "select actor_type, reason from audit.audit_log where entity_id = $1",
      [d.id],
    );
    expect(audit.rows).toEqual([{ actor_type: "system", reason: "chain_broken" }]);
    // Already suspended: nothing more is written.
    await tx((x) => quarantineDevice(x, input(d.id)));
    const again = await admin.query("select 1 from infra.outbox where payload->>'subject' = $1", [
      `device/${d.id}`,
    ]);
    expect(again.rowCount).toBe(2);
  });

  it("leaves a revoked device alone", async () => {
    const d = await device("revoked");
    await tx((x) => quarantineDevice(x, input(d.id)));
    const row = await admin.query<{ status: string }>(
      "select status from devices.devices where id = $1",
      [d.id],
    );
    expect(row.rows[0]?.status).toBe("revoked");
  });

  it("returns the public key of a device, and nothing for an unknown one", async () => {
    const d = await device();
    const key = await tx((x) => devicePublicKey(x, T, d.id));
    expect(Buffer.from(key ?? []).equals(Buffer.from(d.publicKey))).toBe(true);
    expect(await tx((x) => devicePublicKey(x, T, uuidv7()))).toBeUndefined();
    const suspended = await device("suspended");
    expect(await tx((x) => devicePublicKey(x, T, suspended.id))).toBeUndefined();
  });
});
