import type { BusLogger, OnMetric } from "@wise-biz/events";
import type { AuditOnMetric } from "@wise-biz/module-audit";

const EMIT_MS = 60_000;
const PROBE_MS = 30_000;
/** Below this many future monthly audit partitions, inserts will start failing soon: page. */
const MIN_PARTITION_HORIZON_MONTHS = 2;

/** Gauges are "last value wins"; everything else is a monotonically increasing counter. */
const GAUGE_METRICS = new Set(["relay_lag_ms"]);

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export interface WorkerMetrics {
  onMetric: OnMetric;
  onAuditMetric: AuditOnMetric;
  snapshot(): MetricsSnapshot;
  /** Start the 60 s log emitter and the 30 s gauge probes (probe once immediately). */
  start(): void;
  /** Stop timers and emit one final line. Never throws. */
  stop(): Promise<void>;
}

export type MetricsOptions = Readonly<{
  logger: BusLogger;
  /** Age in ms of the oldest unchained audit row, or null when none. Run as wb_chainer. DB-free for tests. */
  oldestUnchainedAgeMs: () => Promise<number | null>;
  /** Months of audit partitions that exist ahead of now (auditPartitionHorizon). */
  partitionHorizonMonths: () => Promise<number>;
}>;

/** SQL for `oldestUnchainedAgeMs` (uses the partial work-queue index on hash IS NULL). */
export const OLDEST_UNCHAINED_SQL =
  "select extract(epoch from now() - min(at)) * 1000 as age_ms from audit.audit_log where hash is null";

/** Per-tenant labels are dropped on purpose (unbounded cardinality); only `job` and `op` survive. */
function keyOf(name: string, labels: Readonly<Record<string, string>>): string {
  const parts = ["job", "op"].flatMap((k) =>
    labels[k] === undefined ? [] : [`${k}=${labels[k]}`],
  );
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
}

/**
 * In-process metrics sink. Counters/gauges live in Maps and are flushed as ONE structured log line
 * (`{"msg":"metrics","counters":{...},"gauges":{...}}`) every 60 s and on shutdown; counters are cumulative since process
 * start. This is the production stand-in until OpenTelemetry metrics export replaces the log line: swap `emit` for an
 * OTel meter and keep the hooks.
 */
export function createMetrics(opts: MetricsOptions): WorkerMetrics {
  const { logger } = opts;
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  let timers: NodeJS.Timeout[] = [];

  const record = (name: string, value: number, labels: Readonly<Record<string, string>>): void => {
    if (GAUGE_METRICS.has(name)) gauges.set(name, value);
    else {
      const k = keyOf(name, labels);
      counters.set(k, (counters.get(k) ?? 0) + value);
    }
  };

  const snapshot = (): MetricsSnapshot => ({
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
  });

  const emit = (): void => {
    try {
      logger.info(snapshot(), "metrics");
    } catch {
      // logging must not break shutdown
    }
  };

  const probe = async (): Promise<void> => {
    try {
      const age = await opts.oldestUnchainedAgeMs();
      gauges.set("audit_oldest_unchained_age_ms", Math.max(0, Math.round(age ?? 0)));
    } catch (e) {
      logger.warn({ err: e }, "metrics: oldest-unchained probe failed");
    }
    try {
      const months = await opts.partitionHorizonMonths();
      gauges.set("audit_partition_horizon_months", months);
      if (months < MIN_PARTITION_HORIZON_MONTHS) {
        logger.error(
          { months },
          "AUDIT PARTITION HORIZON below 2 months: partition job is not keeping up",
        );
      }
    } catch (e) {
      logger.warn({ err: e }, "metrics: partition horizon probe failed");
    }
  };

  return {
    onMetric: record,
    onAuditMetric: record,
    snapshot,
    start() {
      if (timers.length > 0) return;
      void probe();
      timers = [setInterval(emit, EMIT_MS), setInterval(() => void probe(), PROBE_MS)];
      for (const t of timers) t.unref();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      emit();
      return Promise.resolve();
    },
  };
}
