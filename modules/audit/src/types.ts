export interface AuditLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type AuditMetricName =
  | "audit_chain_rows"
  | "audit_chain_tenant_error"
  | "audit_chain_loop_error"
  | "audit_anchor_created"
  | "audit_anchor_error"
  | "audit_verify_failed"
  | "audit_partitions_created"
  | "audit_job_error";

export type AuditOnMetric = (
  name: AuditMetricName,
  value: number,
  labels: Readonly<Record<string, string>>,
) => void;

/** Epoch-millisecond clock (matches @wise-biz/testing fakeClock). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Hooks must never break the loop they observe. */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* observer failure is not a job failure */
  }
}

export function errorInfo(e: unknown): { message: string; name: string } {
  return e instanceof Error
    ? { message: e.message, name: e.name }
    : { message: String(e), name: "NonError" };
}
