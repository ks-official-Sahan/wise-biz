import { describe, expect, it, vi } from "vitest";

import { createSyncMetrics } from "../src/sync-metrics.ts";

describe("sync push metrics window", () => {
  it("is silent when nothing happened", () => {
    const info = vi.fn();
    expect(createSyncMetrics({ info }).flush()).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("summarizes commands, outcomes, stops and apply latency, then resets", () => {
    const info = vi.fn();
    const m = createSyncMetrics({ info });
    for (let i = 1; i <= 100; i++)
      m.onMetric("sync_apply_ms", i, { type: "complete_sale", status: "applied" });
    m.onMetric("sync_apply_ms", 5, { type: "complete_sale", status: "replayed" });
    m.onMetric("sync_apply_ms", 5, { type: "void_sale", status: "rejected" });
    m.onMetric("sync_apply_ms", 5, { type: "x", status: "stopped" });
    m.onMetric("sync_stopped", 1, { code: "SEQUENCE_GAP" });
    m.onMetric("sync_batch_commands", 100, {});
    m.onMetric("sync_batch_commands", 4, {});
    const out = m.flush();
    expect(out).toMatchObject({
      commands: 103,
      applied: 100,
      replayed: 1,
      rejected: 1,
      stoppedBatches: 1,
      batches: 2,
      avgBatchSize: 52,
      applyMaxMs: 100,
    });
    expect(out?.applyP95Ms).toBeGreaterThanOrEqual(94);
    expect(out?.applyP95Ms).toBeLessThanOrEqual(96);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ commands: 103 }),
      "sync push window",
    );
    expect(m.flush()).toBeNull();
  });

  it("keeps memory bounded under a burst and flushes on its timer", () => {
    vi.useFakeTimers();
    try {
      const info = vi.fn();
      const m = createSyncMetrics({ info });
      m.start();
      m.start();
      for (let i = 0; i < 25_000; i++)
        m.onMetric("sync_apply_ms", i % 50, { type: "t", status: "applied" });
      vi.advanceTimersByTime(60_000);
      expect(info).toHaveBeenCalledOnce();
      expect(info.mock.calls[0]?.[0]).toMatchObject({ commands: 25_000, applyMaxMs: 49 });
      m.stop();
      m.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
