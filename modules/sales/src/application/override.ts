import { OverrideApprovedV1 } from "../events.ts";

import { commit, insertChain, invalid, one, pgErrors, salesEvent, seen } from "./shared.ts";

import type { Applied } from "./sale.ts";
import type { SalesPorts, TerminalContext } from "../ports.ts";
import type { RecordOverride } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

export interface OverrideReceipt {
  readonly overrideId: string;
  readonly flags: readonly string[];
}

async function stored(tx: TxHandle, tenantId: string, id: string): Promise<OverrideReceipt> {
  const r = await tx.query<{ flags: string[] }>(
    "select flags from sales.overrides where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  return { overrideId: id, flags: one(r.rows).flags };
}

/**
 * RecordOverride (security.md, Overrides): a supervisor approved an action the operator lacks a permission for, on
 * the terminal (PIN). Recorded before the document that relies on it (device chain order). An approver who was not
 * active, or lacked the permission, is flagged `approver_unauthorized`; documents that use the override carry
 * `override_unauthorized` for review.
 */
export async function recordOverride(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: RecordOverride,
): Promise<Applied<OverrideReceipt>> {
  if (await seen(tx, t, "override", cmd.id, cmd.meta)) {
    return { body: await stored(tx, t.tenantId, cmd.id), replayed: true };
  }
  if (cmd.requesterId === cmd.approverId)
    return invalid("approverId", "An operator cannot approve their own override.");
  const facts = await ports.tenancy.operators(tx, t.tenantId, [cmd.approverId]);
  const approver = facts.get(cmd.approverId);
  const granted =
    approver?.active === true &&
    (approver.permissions === "all" || approver.permissions.has(cmd.permission));
  const flags = granted ? [] : ["approver_unauthorized"];
  return pgErrors(async () => {
    await tx.query(
      `insert into sales.overrides (id, tenant_id, terminal_id, requester_id, approver_id, permission, reason, before,
         after, subject_type, subject_id, flags, occurred_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        cmd.id,
        t.tenantId,
        t.terminalId,
        cmd.requesterId,
        cmd.approverId,
        cmd.permission,
        cmd.reason,
        cmd.before === undefined ? null : JSON.stringify(cmd.before),
        cmd.after === undefined ? null : JSON.stringify(cmd.after),
        cmd.subjectType ?? null,
        cmd.subjectId ?? null,
        flags,
        new Date(cmd.occurredAt),
        t.now,
      ],
    );
    await insertChain(tx, t, "override", cmd.id, cmd.meta);
    await commit(
      tx,
      t,
      {
        action: "sales.override.approve",
        entity: "override",
        entityId: cmd.id,
        before: cmd.before ?? null,
        after: {
          requesterId: cmd.requesterId,
          approverId: cmd.approverId,
          permission: cmd.permission,
          subjectType: cmd.subjectType ?? null,
          subjectId: cmd.subjectId ?? null,
          value: cmd.after ?? null,
          flags,
        },
        reason: cmd.reason,
      },
      [
        salesEvent(OverrideApprovedV1, t, `override/${cmd.id}`, {
          overrideId: cmd.id,
          terminalId: t.terminalId,
          requesterId: cmd.requesterId,
          approverId: cmd.approverId,
          permission: cmd.permission,
          subjectType: cmd.subjectType ?? null,
          subjectId: cmd.subjectId ?? null,
          occurredAt: new Date(cmd.occurredAt).toISOString(),
          flags,
        }),
      ],
    );
    return { body: { overrideId: cmd.id, flags }, replayed: false };
  });
}
