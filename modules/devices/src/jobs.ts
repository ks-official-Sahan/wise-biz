import { withTenantTx } from "@wise-biz/db";

import { DEVICES_TOPIC, DeviceHeartbeatMissedV1 } from "./events.ts";

import type pg from "pg";

/**
 * Devices jobs for the workers (ADR 0013 pattern, same as the inventory jobs): the scan reads across businesses with the
 * wb_worker pool, every write happens in a tenant-scoped transaction, and the caller holds a session advisory lock so
 * replicas never run it twice.
 */
export interface DeviceJobDeps {
  /** wb_worker pool. */
  readonly pool: pg.Pool;
  readonly ids: { uuidv7(): string };
  readonly now: () => Date;
}

const BATCH = 200;

interface Silent {
  id: string;
  tenant_id: string;
  branch_id: string;
  name: string;
  last_seen_at: Date;
}

/**
 * Emits `devices.heartbeat.missed` for each active terminal silent for more than `silentMinutes`. A terminal is alerted
 * once per silence: it is due again only once it has been seen after the last alert (offline_alerted_at < last_seen_at).
 * Terminals that never reported are not alerted; they were never online. Returns how many alerts were raised.
 */
export async function runMissedHeartbeats(
  deps: DeviceJobDeps,
  silentMinutes = 10,
): Promise<number> {
  let total = 0;
  for (;;) {
    const due = await deps.pool.query<Silent>(
      `select id, tenant_id, branch_id, name, last_seen_at from devices.devices
        where status = 'active' and last_seen_at is not null
          and last_seen_at < $1::timestamptz - make_interval(mins => $2::int)
          and (offline_alerted_at is null or offline_alerted_at < last_seen_at)
        order by tenant_id, id limit $3`,
      [deps.now(), silentMinutes, BATCH],
    );
    if (due.rows.length === 0) return total;
    const byTenant = new Map<string, Silent[]>();
    for (const r of due.rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
    let raised = 0;
    for (const [tenantId, devices] of byTenant) {
      raised += await withTenantTx(
        deps.pool,
        { tenantId, requestId: "job-missed-heartbeats" },
        async (tx) => {
          // The marker is the claim: a second worker that raced us updates nothing.
          const claimed = await tx.query<{ id: string }>(
            `update devices.devices set offline_alerted_at = $3
              where tenant_id = $1 and id = any($2::uuid[]) and status = 'active'
                and (offline_alerted_at is null or offline_alerted_at < last_seen_at)
              returning id`,
            [tenantId, devices.map((d) => d.id), deps.now()],
          );
          const won = new Set(claimed.rows.map((c) => c.id));
          const events = devices
            .filter((d) => won.has(d.id))
            .map((d) => {
              const e = DeviceHeartbeatMissedV1.parse({
                id: deps.ids.uuidv7(),
                type: DeviceHeartbeatMissedV1.type,
                version: DeviceHeartbeatMissedV1.version,
                source: "workers/devices",
                tenantId,
                subject: `device/${d.id}`,
                time: deps.now().toISOString(),
                correlationId: "job-devices.heartbeat.missed",
                actor: { type: "system", id: "devices-jobs" },
                data: {
                  deviceId: d.id,
                  branchId: d.branch_id,
                  name: d.name,
                  lastSeenAt: d.last_seen_at.toISOString(),
                  silentMinutes: Math.round(
                    (deps.now().getTime() - d.last_seen_at.getTime()) / 60_000,
                  ),
                },
              });
              return {
                id: e.id,
                topic: DEVICES_TOPIC,
                key: `${tenantId}:${d.id}`,
                type: e.type,
                version: e.version,
                payload: e,
              };
            });
          if (events.length === 0) return 0;
          await tx.query(
            `insert into infra.outbox (tenant_id, id, topic, key, type, version, payload)
             select $1, e.id, e.topic, e.key, e.type, e.version, e.payload
               from jsonb_to_recordset($2::jsonb) as e(id uuid, topic text, key text, type text, version int, payload jsonb)`,
            [tenantId, JSON.stringify(events)],
          );
          return events.length;
        },
      );
    }
    total += raised;
    // Nothing was claimed in a whole batch: stop instead of re-reading the same rows forever.
    if (raised === 0 || due.rows.length < BATCH) return total;
  }
}
