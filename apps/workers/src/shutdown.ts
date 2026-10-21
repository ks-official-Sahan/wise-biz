import type { BusLogger } from "@wise-biz/events";

export interface StopStep {
  name: string;
  run: () => Promise<unknown>;
}

/**
 * Run `steps` concurrently and wait for ALL of them (a failing step never skips the others). Failures are logged;
 * returns the names of the failed steps.
 */
export async function settleSteps(
  steps: readonly StopStep[],
  logger: BusLogger,
): Promise<string[]> {
  const results = await Promise.allSettled(steps.map((s) => s.run()));
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const name = steps[i]?.name ?? "unknown";
      failed.push(name);
      logger.error({ step: name, err: r.reason as unknown }, "worker stop step failed");
    }
  });
  return failed;
}
