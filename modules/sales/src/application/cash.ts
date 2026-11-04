import {
  commit,
  insertChain,
  lockOpenShift,
  one,
  operatorFlags,
  pgErrors,
  seen,
} from "./shared.ts";

import type { Applied } from "./sale.ts";
import type { SalesPorts, TerminalContext } from "../ports.ts";
import type { CashMovement, OpenDrawer } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

export interface CashReceipt {
  readonly id: string;
  readonly flags: readonly string[];
}

async function stored(
  tx: TxHandle,
  table: "drawer_sessions" | "cash_movements",
  tenantId: string,
  id: string,
): Promise<CashReceipt> {
  const r = await tx.query<{ flags: string[] }>(
    `select flags from sales.${table} where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return { id, flags: one(r.rows).flags };
}

/**
 * OpenDrawer: every drawer open is recorded (security.md: "open drawer without sale" needs a permission). A no-sale
 * open is flagged `no_sale`; the Z-report counts them. Audit only: no consumer needs an event.
 */
export async function openDrawer(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: OpenDrawer,
): Promise<Applied<CashReceipt>> {
  if (await seen(tx, t, "drawer", cmd.id, cmd.meta)) {
    return { body: await stored(tx, "drawer_sessions", t.tenantId, cmd.id), replayed: true };
  }
  await lockOpenShift(tx, t, cmd.shiftId, "share");
  const flags = [
    ...(await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:open_drawer")),
    ...(cmd.saleId == null ? ["no_sale"] : []),
  ].sort();
  return pgErrors(async () => {
    await tx.query(
      `insert into sales.drawer_sessions (id, tenant_id, shift_id, terminal_id, operator_id, sale_id, reason, flags,
         opened_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        cmd.id,
        t.tenantId,
        cmd.shiftId,
        t.terminalId,
        cmd.operatorId,
        cmd.saleId ?? null,
        cmd.reason,
        flags,
        new Date(cmd.openedAt),
        t.now,
      ],
    );
    await insertChain(tx, t, "drawer", cmd.id, cmd.meta);
    await commit(
      tx,
      t,
      {
        action: "sales.drawer.open",
        entity: "drawer",
        entityId: cmd.id,
        after: {
          shiftId: cmd.shiftId,
          operatorId: cmd.operatorId,
          saleId: cmd.saleId ?? null,
          flags,
        },
        reason: cmd.reason,
      },
      [],
    );
    return { body: { id: cmd.id, flags }, replayed: false };
  });
}

/** CashMovement: pay in, pay out, float top-up or safe drop. Feeds the expected cash of the shift close. */
export async function cashMovement(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: CashMovement,
): Promise<Applied<CashReceipt>> {
  if (await seen(tx, t, "cash_movement", cmd.id, cmd.meta)) {
    return { body: await stored(tx, "cash_movements", t.tenantId, cmd.id), replayed: true };
  }
  await lockOpenShift(tx, t, cmd.shiftId, "share");
  const flags = (await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:cash")).sort();
  return pgErrors(async () => {
    await tx.query(
      `insert into sales.cash_movements (id, tenant_id, shift_id, terminal_id, operator_id, kind, amount_minor, reason,
         flags, occurred_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        cmd.id,
        t.tenantId,
        cmd.shiftId,
        t.terminalId,
        cmd.operatorId,
        cmd.kind,
        cmd.amountMinor,
        cmd.reason,
        flags,
        new Date(cmd.occurredAt),
        t.now,
      ],
    );
    await insertChain(tx, t, "cash_movement", cmd.id, cmd.meta);
    await commit(
      tx,
      t,
      {
        action: "sales.cash.move",
        entity: "cash_movement",
        entityId: cmd.id,
        after: {
          shiftId: cmd.shiftId,
          operatorId: cmd.operatorId,
          kind: cmd.kind,
          amountMinor: cmd.amountMinor,
          flags,
        },
        reason: cmd.reason,
      },
      [],
    );
    return { body: { id: cmd.id, flags }, replayed: false };
  });
}
