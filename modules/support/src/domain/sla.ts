/**
 * SLA targets by plan. Pure: due times are epoch milliseconds (UTC instants) plus a fixed number of hours, so no
 * timezone, offset or DST rule can shift them. Business dates are not involved here.
 */

export const PLAN_CODES = ["free", "pro", "business"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface SlaTargets {
  readonly firstResponseHours: number;
  readonly resolutionHours: number;
}

const HOUR_MS = 3_600_000;

const SLA_BY_PLAN: Readonly<Record<PlanCode, SlaTargets>> = {
  free: { firstResponseHours: 48, resolutionHours: 120 },
  pro: { firstResponseHours: 8, resolutionHours: 48 },
  business: { firstResponseHours: 2, resolutionHours: 24 },
};

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

/** Plan codes are exact lower-case strings. Anything else (including a typo) is treated as the free plan. */
export function resolvePlan(code: string): PlanCode {
  return isPlanCode(code) ? code : "free";
}

export interface SlaDueTimes {
  readonly firstResponseDueMs: number;
  readonly resolutionDueMs: number;
}

export function slaDueTimes(createdAtMs: number, planCode: string): SlaDueTimes {
  if (!Number.isSafeInteger(createdAtMs)) {
    throw new RangeError("createdAtMs must be a safe integer (epoch milliseconds)");
  }
  const targets = SLA_BY_PLAN[resolvePlan(planCode)];
  return {
    firstResponseDueMs: createdAtMs + targets.firstResponseHours * HOUR_MS,
    resolutionDueMs: createdAtMs + targets.resolutionHours * HOUR_MS,
  };
}
