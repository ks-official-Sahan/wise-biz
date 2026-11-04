import { ShiftOpenedV1 } from "../events.ts";

import {
  assertReplay,
  commit,
  insertChain,
  lockDocument,
  operatorFlags,
  pgErrors,
  salesEvent,
} from "./shared.ts";

import type { Applied } from "./sale.ts";
import type { SalesPorts, TerminalContext } from "../ports.ts";
import type { OpenShift } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

export interface ShiftReceipt {
  readonly shiftId: string;
  readonly status: "open" | "closed";
  readonly flags: readonly string[];
}

async function storedShift(tx: TxHandle, tenantId: string, id: string): Promise<ShiftReceipt> {
  const r = await tx.query<{ status: "open" | "closed"; flags: string[] }>(
    "select status, flags from sales.shifts where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  const row = r.rows[0];
  /* v8 ignore next -- the chain row and the shift are written in one transaction */
  if (row === undefined) throw new Error("internal: shift missing for its chain row");
  return { shiftId: id, status: row.status, flags: row.flags };
}

/** OpenShift: one open shift per terminal (unique partial index); the float is the drawer's starting cash. */
export async function openShift(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: OpenShift,
): Promise<Applied<ShiftReceipt>> {
  await lockDocument(tx, t.tenantId, cmd.id);
  const seen = await tx.query(
    "select 1 from sales.device_documents where tenant_id = $1 and doc_type = 'shift_open' and doc_id = $2",
    [t.tenantId, cmd.id],
  );
  if (seen.rowCount === 1) {
    await assertReplay(tx, t, "shift_open", cmd.id, cmd.meta);
    return { body: await storedShift(tx, t.tenantId, cmd.id), replayed: true };
  }
  const flags = (await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:shift")).sort();
  return pgErrors(async () => {
    await tx.query(
      `insert into sales.shifts (id, tenant_id, branch_id, terminal_id, opened_by, business_date, currency,
         opening_float_minor, opened_at, flags, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        cmd.id,
        t.tenantId,
        t.branchId,
        t.terminalId,
        cmd.operatorId,
        cmd.businessDate,
        cmd.currency,
        cmd.openingFloatMinor,
        new Date(cmd.openedAt),
        flags,
        t.now,
      ],
    );
    await insertChain(tx, t, "shift_open", cmd.id, cmd.meta);
    await commit(
      tx,
      t,
      {
        action: "sales.shift.open",
        entity: "shift",
        entityId: cmd.id,
        after: {
          operatorId: cmd.operatorId,
          businessDate: cmd.businessDate,
          openingFloatMinor: cmd.openingFloatMinor,
          currency: cmd.currency,
          flags,
        },
      },
      [
        salesEvent(ShiftOpenedV1, t, `shift/${cmd.id}`, {
          shiftId: cmd.id,
          branchId: t.branchId,
          terminalId: t.terminalId,
          operatorId: cmd.operatorId,
          businessDate: cmd.businessDate,
          currency: cmd.currency,
          openingFloatMinor: cmd.openingFloatMinor,
          openedAt: new Date(cmd.openedAt).toISOString(),
        }),
      ],
    );
    return { body: { shiftId: cmd.id, status: "open" as const, flags }, replayed: false };
  });
}
