/**
 * Wall-clock budgets (p95 latency, lookups) hold on the reference hardware (the P1-16 device gate and a dev machine).
 * A shared CI runner with durable fsync and parallel tasks is several times slower, so there the numbers are printed and
 * the budget is not asserted; the randomized chaos run also shrinks. Set WB_PERF=1 to force the full budgets anywhere.
 */
export const enforceBudgets = process.env.WB_PERF === "1" || process.env.CI === undefined;
export const chaosRuns = enforceBudgets ? 1000 : 150;
/** Asserts `actual < limit` where budgets are enforced. */
export function withinBudget(
  actual: number,
  limit: number,
  expectFn: (v: number) => { toBeLessThan(n: number): void },
): void {
  if (enforceBudgets) expectFn(actual).toBeLessThan(limit);
}
