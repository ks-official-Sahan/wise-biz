import { appendAudit, appendOutbox } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";

import { SALES_TOPIC } from "../events.ts";

import type { TenancyPort, TerminalContext } from "../ports.ts";
import type { CommandMeta } from "@wise-biz/contracts";
import type { AuditEntry, OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

export type DocType =
  | "sale"
  | "return"
  | "void"
  | "shift_open"
  | "shift_close"
  | "drawer"
  | "cash_movement"
  | "override";

export const invalid = (path: string, message: string): never => {
  throw new DomainError("VALIDATION_FAILED", message, { fieldErrors: [{ path, message }] });
};

const UNIQUE: Readonly<Record<string, string>> = {
  device_documents_pkey: "This device sequence number is already used.",
  device_documents_doc_key: "This document was already recorded.",
  sales_terminal_no_key: "This terminal already used this sale number.",
  returns_terminal_no_key: "This terminal already used this return number.",
  shifts_one_open_key: "This terminal already has an open shift.",
  voids_sale_key: "This sale is already voided.",
};

/** Unique violations become 409 (the transaction is aborted either way). */
export async function pgErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const { code, constraint } = e as { code?: string; constraint?: string };
    if (code === "23505" && constraint !== undefined && constraint in UNIQUE) {
      throw new DomainError("CONFLICT", UNIQUE[constraint] ?? "Already exists.");
    }
    throw e;
  }
}

/**
 * Serializes applies of one document id (a retry racing the original): the second waits, then finds the first's rows
 * and replays. Transaction-scoped, so it is released at commit or rollback.
 */
export async function lockDocument(tx: TxHandle, tenantId: string, docId: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `sales:${tenantId}:${docId}`,
  ]);
}

/** The chain row for a signed document: (terminal, device_seq) is taken once, whatever the document type. */
export async function insertChain(
  tx: TxHandle,
  t: TerminalContext,
  docType: DocType,
  docId: string,
  meta: CommandMeta,
): Promise<void> {
  await tx.query(
    `insert into sales.device_documents (tenant_id, terminal_id, device_seq, doc_type, doc_id, prev_hash, hash,
       signature, received_at)
     values ($1, $2, $3, $4, $5, decode($6, 'base64'), decode($7, 'base64'), decode($8, 'base64'), $9)`,
    [
      t.tenantId,
      t.terminalId,
      meta.deviceSeq,
      docType,
      docId,
      meta.prevHash,
      meta.hash,
      meta.signature,
      t.now,
    ],
  );
}

/**
 * A document id seen before: the same document (same hash, same terminal) replays; anything else under that id is a
 * conflict, so a reused id can never overwrite or read another document's answer.
 */
export async function assertReplay(
  tx: TxHandle,
  t: TerminalContext,
  docType: DocType,
  docId: string,
  meta: CommandMeta,
): Promise<void> {
  const r = await tx.query<{ same: boolean }>(
    `select hash = decode($4, 'base64') and terminal_id = $5 as same from sales.device_documents
     where tenant_id = $1 and doc_type = $2 and doc_id = $3`,
    [t.tenantId, docType, docId, meta.hash, t.terminalId],
  );
  if (r.rows[0]?.same !== true) {
    throw new DomainError("CONFLICT", "A different document already uses this id.");
  }
}

/** Inventory's port takes the module-kit command context; the operator is the acting user. */
export const commandContext = (t: TerminalContext, operatorId: string): CommandContext => ({
  tenant: { tenantId: t.tenantId, userId: operatorId, requestId: t.requestId },
  userId: operatorId,
  requestId: t.requestId,
  now: t.now,
  ids: t.ids,
});

export function salesEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  t: TerminalContext,
  subject: string,
  data: unknown,
): OutboxEvent {
  const e = def.parse({
    id: t.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/sales",
    tenantId: t.tenantId,
    branchId: t.branchId,
    subject,
    time: t.now.toISOString(),
    correlationId: t.requestId,
    actor: { type: "device", id: t.terminalId },
    data,
  });
  return {
    id: e.id,
    topic: SALES_TOPIC,
    key: `${t.tenantId}:${t.branchId}`,
    type: def.type,
    version: def.version,
    payload: e,
  };
}

/** Terminal documents are audited as the device, in the same transaction (AGENTS.md rule 5). */
export async function commit(
  tx: TxHandle,
  t: TerminalContext,
  audit: Omit<AuditEntry, "actorType" | "actorId" | "requestId" | "deviceId">,
  events: readonly OutboxEvent[],
): Promise<void> {
  await appendAudit(tx, [
    {
      ...audit,
      actorType: "device",
      actorId: t.terminalId,
      deviceId: t.terminalId,
      requestId: t.requestId,
    },
  ]);
  await appendOutbox(tx, events);
}

/**
 * Offline rules (offline-sync.md, Conflict policy): an operator who lost access, or acted on an older policy, is
 * accepted and flagged for review, never rejected (the customer already left with the goods).
 */
export async function operatorFlags(
  tx: TxHandle,
  tenancy: TenancyPort,
  t: TerminalContext,
  operatorId: string,
  permission: string,
  declaredPolicyVersion?: number,
): Promise<string[]> {
  // One client per transaction: sequential, never Promise.all.
  const facts = await tenancy.operators(tx, t.tenantId, [operatorId]);
  const version =
    declaredPolicyVersion === undefined ? undefined : await tenancy.policyVersion(tx, t.tenantId);
  const flags: string[] = [];
  const op = facts.get(operatorId);
  if (op?.active !== true) flags.push("operator_inactive");
  else if (op.permissions !== "all" && !op.permissions.has(permission))
    flags.push("operator_unauthorized");
  if (
    declaredPolicyVersion !== undefined &&
    version !== undefined &&
    declaredPolicyVersion < version
  )
    flags.push("stale_policy");
  return flags;
}

/** Document time checks: a clock far ahead, or a document older than the stock ledger keeps, is refused clearly. */
export function assertDocumentTime(
  t: TerminalContext,
  at: Date,
  path: string,
  opts: { clockSkewMs: number; maxDocumentAgeDays: number },
): void {
  if (at.getTime() > t.now.getTime() + opts.clockSkewMs)
    invalid(path, "The terminal clock is ahead of the server. Fix the device time and sync again.");
  if (at.getTime() < t.now.getTime() - opts.maxDocumentAgeDays * 86_400_000)
    invalid(path, "This document is too old to sync. Contact support to import it.");
}

/** The row a `returning` or locked select just produced (present by construction). */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  /* v8 ignore next */
  if (row === undefined) throw new Error("internal: expected one row");
  return row;
}
