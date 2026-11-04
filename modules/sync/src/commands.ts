import {
  CashMovementSchema,
  CloseShiftSchema,
  CompleteReturnSchema,
  CompleteSaleSchema,
  OpenDrawerSchema,
  OpenShiftSchema,
  RecordOverrideSchema,
  VoidSaleSchema,
} from "@wise-biz/contracts";

import type { TxHandle } from "@wise-biz/db";
import type { z } from "zod";

/** The terminal commands sync dispatches: the wire name, and the shared schema the device built the command with. */
export const COMMAND_SCHEMAS = {
  complete_sale: CompleteSaleSchema,
  complete_return: CompleteReturnSchema,
  void_sale: VoidSaleSchema,
  open_shift: OpenShiftSchema,
  close_shift: CloseShiftSchema,
  open_drawer: OpenDrawerSchema,
  cash_movement: CashMovementSchema,
  record_override: RecordOverrideSchema,
} as const;
export type CommandType = keyof typeof COMMAND_SCHEMAS;

export const isCommandType = (t: string): t is CommandType => Object.hasOwn(COMMAND_SCHEMAS, t);

/** What a handler needs to know about the terminal that sent the command (verified by sync). */
export interface TerminalContext {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly requestId: string;
  readonly now: Date;
  readonly ids: { uuidv7(): string };
}

export interface Applied {
  readonly body: unknown;
  /** True when the document was already recorded (nothing written). */
  readonly replayed: boolean;
}

/**
 * One handler per command type, wired at the composition root to the owning module (sales today). Each runs inside
 * the transaction sync opened for that command and throws DomainError for a business-rule refusal.
 */
export type CommandHandlers = {
  readonly [K in CommandType]: (
    tx: TxHandle,
    t: TerminalContext,
    cmd: z.output<(typeof COMMAND_SCHEMAS)[K]>,
  ) => Promise<Applied>;
};
