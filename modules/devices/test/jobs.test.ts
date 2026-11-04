import { join } from "node:path";

import { generateKeyPair } from "@wise-biz/crypto";
import { createPool, migrate } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMissedHeartbeats } from "../src/index.ts";

import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const NOW = new Date("2026-11-03T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let worker: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "devices", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  worker = createPool(db.url("worker"));
  admin = createPool(db.url("admin"));
  drop = async () => {
    await worker.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});

const deps = () => ({ pool: worker, ids: { uuidv7 }, now: () => NOW });

async function device(tenant: string, lastSeen: Date | null, status = "active") {
  const id = uuidv7();
  await admin.query(
    `insert into devices.devices (id, tenant_id, branch_id, name, platform, app_version, status, public_key, enrolled_by, last_seen_at)
     values ($1, $2, $3, 'Till', 'linux', '1.0.0', $4, $5, $6, $7)`,
    [id, tenant, uuidv7(), status, Buffer.from(generateKeyPair().publicKey), uuidv7(), lastSeen],
  );
  return id;
}
const alerts = async (tenant: string) =>
  (
    await admin.query<{ subject: string }>(
      "select payload->>'subject' as subject from infra.outbox where tenant_id = $1 and type = 'devices.heartbeat.missed'",
      [tenant],
    )
  ).rows.map((r) => r.subject);

describe("missed heartbeats", () => {
  it("alerts silent active terminals once, across businesses, and not the others", async () => {
    const [t1, t2] = [uuidv7(), uuidv7()];
    const silent1 = await device(t1, minutesAgo(30));
    const silent2 = await device(t2, minutesAgo(11));
    await device(t1, minutesAgo(3)); // recent
    await device(t1, null); // never reported
    await device(t1, minutesAgo(60), "suspended"); // not in service
    await device(t1, minutesAgo(60), "revoked");

    expect(await runMissedHeartbeats(deps(), 10)).toBe(2);
    expect(await alerts(t1)).toEqual([`device/${silent1}`]);
    expect(await alerts(t2)).toEqual([`device/${silent2}`]);

    // Still silent: not alerted again.
    expect(await runMissedHeartbeats(deps(), 10)).toBe(0);
    expect(await alerts(t1)).toHaveLength(1);
  });

  it("alerts again only after the terminal was seen and went quiet again", async () => {
    const t = uuidv7();
    const id = await device(t, minutesAgo(30));
    expect(await runMissedHeartbeats(deps(), 10)).toBe(1);
    // Back online, then quiet again (seen after the alert, so it is due again).
    await admin.query("update devices.devices set last_seen_at = $2 where id = $1", [
      id,
      new Date(NOW.getTime() + 1),
    ]);
    const later = { ...deps(), now: () => new Date(NOW.getTime() + 20 * 60_000) };
    // Other tests' terminals may also have gone quiet by then; only this business's alerts are checked.
    await runMissedHeartbeats(later, 10);
    expect(await alerts(t)).toHaveLength(2);
  });

  it("carries the terminal's branch and how long it has been silent", async () => {
    const t = uuidv7();
    await device(t, minutesAgo(45));
    await runMissedHeartbeats(deps(), 10);
    const row = await admin.query<{
      data: { silentMinutes: number; name: string; branchId: string };
    }>(
      "select payload->'data' as data from infra.outbox where tenant_id = $1 and type = 'devices.heartbeat.missed'",
      [t],
    );
    expect(row.rows[0]?.data).toMatchObject({ silentMinutes: 45, name: "Till" });
    expect(row.rows[0]?.data.branchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("leaves a terminal alone when another run already claimed it", async () => {
    const t = uuidv7();
    const id = await device(t, minutesAgo(30));
    await admin.query("update devices.devices set offline_alerted_at = $2 where id = $1", [
      id,
      NOW,
    ]);
    expect(await runMissedHeartbeats(deps(), 10)).toBe(0);
  });
});
