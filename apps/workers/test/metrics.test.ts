import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMetrics } from "../src/metrics.ts";

interface Line {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function harness(
  over: { age?: () => Promise<number | null>; horizon?: () => Promise<number> } = {},
) {
  const lines: Line[] = [];
  const errors: Line[] = [];
  const logger = {
    info: (obj: object, msg?: string) => lines.push({ obj: obj as Record<string, unknown>, msg }),
    warn: (obj: object, msg?: string) => errors.push({ obj: obj as Record<string, unknown>, msg }),
    error: (obj: object, msg?: string) => errors.push({ obj: obj as Record<string, unknown>, msg }),
  };
  const metrics = createMetrics({
    logger,
    oldestUnchainedAgeMs: over.age ?? (() => Promise.resolve(1500)),
    partitionHorizonMonths: over.horizon ?? (() => Promise.resolve(3)),
  });
  return { metrics, lines, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("worker metrics", () => {
  it("counts, keeps the last relay lag as a gauge, drops tenant labels, emits every 60 s and on stop", async () => {
    const { metrics, lines } = harness();
    metrics.onAuditMetric("audit_chain_rows", 5, { tenantId: "t1" });
    metrics.onAuditMetric("audit_chain_rows", 2, { tenantId: "t2" });
    metrics.onAuditMetric("audit_job_error", 1, { job: "audit-anchor" });
    metrics.onMetric("relay_batch", 10, {});
    metrics.onMetric("relay_lag_ms", 40, {});
    metrics.onMetric("relay_lag_ms", 25, {});
    metrics.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const first = lines.find((l) => l.msg === "metrics");
    expect(first?.obj).toMatchObject({
      counters: { audit_chain_rows: 7, "audit_job_error{job=audit-anchor}": 1, relay_batch: 10 },
      gauges: {
        relay_lag_ms: 25,
        audit_oldest_unchained_age_ms: 1500,
        audit_partition_horizon_months: 3,
      },
    });
    const before = lines.length;
    await metrics.stop();
    expect(lines.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lines.length).toBe(before + 1);
  });

  it("logs ERROR when the partition horizon is below 2 months", async () => {
    const { metrics, errors } = harness({ horizon: () => Promise.resolve(1) });
    metrics.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.some((e) => e.msg?.toLowerCase().includes("partition horizon"))).toBe(true);
    await metrics.stop();
  });

  it("a failing probe keeps the old gauge and never throws; null age means 0", async () => {
    let n = 0;
    const { metrics, lines, errors } = harness({
      age: () => (n++ === 0 ? Promise.resolve(null) : Promise.reject(new Error("db down"))),
    });
    metrics.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(metrics.snapshot().gauges.audit_oldest_unchained_age_ms).toBe(0);
    expect(errors.length).toBe(1);
    await metrics.stop();
    expect(lines.at(-1)?.msg).toBe("metrics");
  });
});
