import { DomainError } from "@wise-biz/errors";

import type { ObjectStore } from "./port.ts";

/**
 * Keeps object-store usage under Cloudflare R2's monthly free tier (ADR 0023). The caps sit below the free tier
 * (10 GB-month, 1 million Class A, 10 million Class B) so that no overage is ever billed.
 */
export interface QuotaLimits {
  /** Bytes stored (decimal: 1 GB = 10^9, the smaller reading of "GB", so the cap is the safer one). */
  readonly storageBytes: number;
  readonly classA: number;
  readonly classB: number;
}

export const R2_DEFAULT_LIMITS: QuotaLimits = Object.freeze({
  storageBytes: 9_500_000_000,
  classA: 900_000,
  classB: 9_500_000,
});

export type QuotaMetric = "storage" | "classA" | "classB";
export type QuotaLevel = "ok" | "warn" | "blocked";

export interface MetricStatus {
  readonly used: number;
  readonly limit: number;
  readonly ratio: number;
  readonly level: QuotaLevel;
}

export interface QuotaStatus {
  readonly periodStart: string;
  readonly periodEnd: string;
  /** When the figures last came from Cloudflare; null = never (counting only this process's own calls). */
  readonly measuredAt: string | null;
  readonly metrics: Readonly<Record<QuotaMetric, MetricStatus>>;
  /** The worst level of the three. */
  readonly level: QuotaLevel;
}

/** What Cloudflare reports: operations since the period started, and bytes stored now. */
export interface UsageReading {
  readonly classA: number;
  readonly classB: number;
  readonly storageBytes: number;
}

/**
 * The billing period containing `now`: from `anchorDay` 00:00 UTC to the same day of the next month. Operation counts
 * reset each period; stored bytes do not. The anchor is the day your Cloudflare billing period starts (1 to 28).
 */
export function billingPeriod(now: Date, anchorDay: number): { start: Date; end: Date } {
  const day = Math.min(28, Math.max(1, Math.trunc(anchorDay)));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startMonth = now.getUTCDate() >= day ? m : m - 1;
  return {
    start: new Date(Date.UTC(y, startMonth, day)),
    end: new Date(Date.UTC(y, startMonth + 1, day)),
  };
}

const MINUTE = 60_000;

interface Bucket {
  minute: number;
  classA: number;
  classB: number;
  bytes: number;
}

export interface QuotaOptions {
  limits?: QuotaLimits;
  /** Day of the month the period starts (default 1). */
  periodAnchorDay?: number;
  /** Fraction of a cap at which the level turns to `warn` (default 0.8). */
  warnAt?: number;
  /**
   * Cloudflare's analytics lag. Calls made within this window before a reading are added on top of it, because the
   * reading may not include them yet (default 10 minutes). Adding them twice only makes the gate stricter.
   */
  lagMs?: number;
  now?: () => Date;
  /** Called when a metric changes level (log it, send it to Sentry). */
  onLevel?: (metric: QuotaMetric, level: QuotaLevel, status: MetricStatus) => void;
}

export interface QuotaGate {
  /** Throws STORAGE_QUOTA_EXCEEDED when the call would pass a cap; otherwise counts it. */
  admit(op: "classA" | "classB", bytes?: number): void;
  /** Replaces the figures with a reading from Cloudflare. */
  apply(reading: UsageReading): void;
  status(): QuotaStatus;
}

export function createQuotaGate(opts: QuotaOptions = {}): QuotaGate {
  const limits = opts.limits ?? R2_DEFAULT_LIMITS;
  const anchor = opts.periodAnchorDay ?? 1;
  const warnAt = opts.warnAt ?? 0.8;
  const lagMs = opts.lagMs ?? 10 * MINUTE;
  const now = opts.now ?? (() => new Date());

  let periodStart = billingPeriod(now(), anchor).start.getTime();
  let reading: (UsageReading & { at: number }) | undefined;
  let buckets: Bucket[] = [];
  const levels: Record<QuotaMetric, QuotaLevel> = { storage: "ok", classA: "ok", classB: "ok" };

  /** Starts a new period when the month turned: operations reset, stored bytes stay. */
  const roll = (t: number) => {
    const start = billingPeriod(new Date(t), anchor).start.getTime();
    if (start === periodStart) return;
    periodStart = start;
    if (reading !== undefined) reading = { ...reading, classA: 0, classB: 0 };
    buckets = buckets.map((b) => ({ ...b, classA: 0, classB: 0 }));
  };

  /** Own calls the reading may not contain yet (all of them when there is no reading). */
  const pending = (): { classA: number; classB: number; bytes: number } => {
    const since = reading === undefined ? -Infinity : reading.at - lagMs;
    const sum = { classA: 0, classB: 0, bytes: 0 };
    for (const b of buckets) {
      if ((b.minute + 1) * MINUTE <= since) continue;
      sum.classA += b.classA;
      sum.classB += b.classB;
      sum.bytes += b.bytes;
    }
    return sum;
  };

  const metric = (used: number, limit: number): MetricStatus => {
    const ratio = used / limit;
    return {
      used,
      limit,
      ratio,
      level: used >= limit ? "blocked" : ratio >= warnAt ? "warn" : "ok",
    };
  };

  const compute = (): Record<QuotaMetric, MetricStatus> => {
    const p = pending();
    return {
      storage: metric((reading?.storageBytes ?? 0) + p.bytes, limits.storageBytes),
      classA: metric((reading?.classA ?? 0) + p.classA, limits.classA),
      classB: metric((reading?.classB ?? 0) + p.classB, limits.classB),
    };
  };

  const notify = (m: Record<QuotaMetric, MetricStatus>) => {
    for (const k of ["storage", "classA", "classB"] as const) {
      if (m[k].level === levels[k]) continue;
      levels[k] = m[k].level;
      opts.onLevel?.(k, m[k].level, m[k]);
    }
  };

  const record = (t: number, a: number, b: number, bytes: number) => {
    const minute = Math.floor(t / MINUTE);
    const last = buckets.at(-1);
    if (last?.minute === minute) {
      last.classA += a;
      last.classB += b;
      last.bytes += bytes;
    } else buckets.push({ minute, classA: a, classB: b, bytes });
  };

  return {
    admit(op, bytes = 0) {
      const t = now().getTime();
      roll(t);
      const m = compute();
      const hit: QuotaMetric | undefined =
        m[op].used + 1 > m[op].limit
          ? op
          : bytes > 0 && m.storage.used + bytes > m.storage.limit
            ? "storage"
            : undefined;
      if (hit !== undefined) {
        notify({ ...m, [hit]: { ...m[hit], level: "blocked" } });
        throw new DomainError(
          "STORAGE_QUOTA_EXCEEDED",
          "File storage has reached its monthly limit. Try again after the period resets.",
          { details: { metric: hit, limit: m[hit].limit } },
        );
      }
      record(t, op === "classA" ? 1 : 0, op === "classB" ? 1 : 0, bytes);
      notify(compute());
    },
    apply(r) {
      const t = now().getTime();
      roll(t);
      reading = { ...r, at: t };
      // Calls older than the lag window are in the reading now: forget them.
      const since = t - lagMs;
      buckets = buckets.filter((b) => (b.minute + 1) * MINUTE > since);
      notify(compute());
    },
    status() {
      const t = now().getTime();
      roll(t);
      const metrics = compute();
      const order: QuotaLevel[] = ["ok", "warn", "blocked"];
      const level = order[Math.max(...Object.values(metrics).map((x) => order.indexOf(x.level)))];
      const period = billingPeriod(new Date(t), anchor);
      return {
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        measuredAt: reading === undefined ? null : new Date(reading.at).toISOString(),
        metrics,
        level: level ?? "ok",
      };
    },
  };
}

/**
 * Wraps a store so every call asks the gate first. Deletes are free in R2 and never blocked, so a full bucket can
 * always be cleaned. Presigned URLs count when issued: the client's request goes straight to R2 and cannot be
 * intercepted, so a URL is treated as one used call (plus its bytes, for a PUT).
 */
export function guardStore(store: ObjectStore, gate: QuotaGate): ObjectStore {
  return {
    presignPut: (key, o) => {
      gate.admit("classA", o.contentLength);
      return store.presignPut(key, o);
    },
    presignGet: (key, s) => {
      gate.admit("classB");
      return store.presignGet(key, s);
    },
    get: async (key) => {
      gate.admit("classB");
      return store.get(key);
    },
    put: async (key, body, contentType) => {
      gate.admit(
        "classA",
        typeof body === "string" ? new TextEncoder().encode(body).length : body.length,
      );
      return store.put(key, body, contentType);
    },
    delete: (key) => store.delete(key),
  };
}

// --- Reading usage from Cloudflare (GraphQL Analytics API) ---

const REQUEST_TIMEOUT_MS = 10_000;

const FREE_ACTIONS = new Set([
  "DeleteObject",
  "DeleteObjects",
  "DeleteBucket",
  "AbortMultipartUpload",
]);
const CLASS_B_ACTIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

/** Class of an R2 action name (docs: r2/pricing). An unknown action counts as Class A: the dearer, so the stricter. */
export function classOf(action: string): "free" | "classA" | "classB" {
  if (FREE_ACTIONS.has(action)) return "free";
  return CLASS_B_ACTIONS.has(action) ? "classB" : "classA";
}

const OPS_QUERY = `query ($account: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }) {
      sum { requests } dimensions { actionType }
    }
  } }
}`;

const STORAGE_QUERY = `query ($account: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }, orderBy: [datetime_DESC]) {
      max { payloadSize metadataSize } dimensions { datetime bucketName }
    }
  } }
}`;

interface GraphQlReply<T> {
  data?: { viewer?: { accounts?: Record<string, T[]>[] } };
  errors?: { message?: string }[] | null;
}

export interface UsageSourceConfig {
  accountId: string;
  /** An API token with the permission Account Analytics: Read. */
  apiToken: string;
  periodAnchorDay: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Account-wide R2 usage: billing is per account, so every bucket counts. */
export function createUsageReader(cfg: UsageSourceConfig): () => Promise<UsageReading> {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const query = async <T>(q: string, from: Date, to: Date, field: string): Promise<T[]> => {
    const res = await doFetch("https://api.cloudflare.com/client/v4/graphql", {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: q,
        variables: { account: cfg.accountId, from: from.toISOString(), to: to.toISOString() },
      }),
    });
    if (!res.ok) throw new Error(`cloudflare analytics: ${String(res.status)}`);
    const body = (await res.json()) as GraphQlReply<T>;
    if (body.errors != null && body.errors.length > 0)
      throw new Error(`cloudflare analytics: ${body.errors[0]?.message ?? "error"}`);
    // An answer without the viewer is not "zero usage": refuse it, so the gate keeps its last reading.
    const account = body.data?.viewer?.accounts?.[0];
    if (account === undefined) throw new Error("cloudflare analytics: no account in the answer");
    return account[field] ?? [];
  };
  return async () => {
    const t = now();
    // The API answers at most 31 days at a time.
    const from = new Date(
      Math.max(
        billingPeriod(t, cfg.periodAnchorDay).start.getTime(),
        t.getTime() - 31 * 86_400_000,
      ),
    );
    const ops = await query<{ sum: { requests: number }; dimensions: { actionType: string } }>(
      OPS_QUERY,
      from,
      t,
      "r2OperationsAdaptiveGroups",
    );
    let classA = 0;
    let classB = 0;
    for (const g of ops) {
      const c = classOf(g.dimensions.actionType);
      if (c === "classA") classA += g.sum.requests;
      else if (c === "classB") classB += g.sum.requests;
    }
    // Storage is a level, not a count: the newest sample of each bucket, summed.
    const samples = await query<{
      max: { payloadSize: number; metadataSize: number };
      dimensions: { datetime: string; bucketName: string };
    }>(STORAGE_QUERY, new Date(t.getTime() - 2 * 86_400_000), t, "r2StorageAdaptiveGroups");
    const newest = new Map<string, { at: string; bytes: number }>();
    for (const s of samples) {
      const seen = newest.get(s.dimensions.bucketName);
      if (seen === undefined || s.dimensions.datetime > seen.at)
        newest.set(s.dimensions.bucketName, {
          at: s.dimensions.datetime,
          bytes: s.max.payloadSize + s.max.metadataSize,
        });
    }
    let storageBytes = 0;
    for (const v of newest.values()) storageBytes += v.bytes;
    return { classA, classB, storageBytes };
  };
}

/** The account id out of an R2 endpoint (`https://<account>.r2.cloudflarestorage.com`); undefined for any other store. */
export function r2AccountOf(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  const m = /^([0-9a-f]{32})(?:\.[a-z]+)?\.r2\.cloudflarestorage\.com$/.exec(
    new URL(endpoint).hostname,
  );
  return m?.[1];
}

export interface QuotaEnv {
  STORAGE_ENDPOINT?: string | undefined;
  R2_LIMIT_STORAGE_BYTES: number;
  R2_LIMIT_CLASS_A: number;
  R2_LIMIT_CLASS_B: number;
  R2_PERIOD_ANCHOR_DAY: number;
  CLOUDFLARE_ANALYTICS_TOKEN?: string | undefined;
}

export interface QuotaLogger {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface GuardedStore {
  store: ObjectStore;
  gate: QuotaGate;
  /** Reads usage from Cloudflare once, then every `everyMs`. Resolves after the first read (or its failure). */
  start(): Promise<void>;
  stop(): void;
}

/**
 * The store with the R2 gate on it. A store that is not R2 (MinIO in dev, AWS S3) comes back unguarded. Without an
 * analytics token the gate counts only this process's calls, and says so in the log.
 */
export function guardFromEnv(
  store: ObjectStore,
  env: QuotaEnv,
  deps: {
    logger: QuotaLogger;
    onBlocked?: (metric: QuotaMetric, status: MetricStatus) => void;
    fetch?: typeof fetch;
    everyMs?: number;
    now?: () => Date;
  },
): GuardedStore {
  const account = r2AccountOf(env.STORAGE_ENDPOINT);
  if (account === undefined) {
    return {
      store,
      gate: createQuotaGate(),
      start: () => Promise.resolve(),
      stop: () => undefined,
    };
  }
  const gate = createQuotaGate({
    limits: {
      storageBytes: env.R2_LIMIT_STORAGE_BYTES,
      classA: env.R2_LIMIT_CLASS_A,
      classB: env.R2_LIMIT_CLASS_B,
    },
    periodAnchorDay: env.R2_PERIOD_ANCHOR_DAY,
    onLevel: (metric, level, status) => {
      const fields = { metric, level, used: status.used, limit: status.limit };
      if (level === "blocked") {
        deps.logger.error(fields, "object storage reached its monthly cap; calls are refused");
        deps.onBlocked?.(metric, status);
      } else if (level === "warn")
        deps.logger.warn(fields, "object storage is near its monthly cap");
      else deps.logger.info(fields, "object storage is back under its cap");
    },
  });
  const guarded = guardStore(store, gate);
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (token === undefined) {
    deps.logger.warn(
      {},
      "CLOUDFLARE_ANALYTICS_TOKEN is not set: the R2 cap counts only this process's calls",
    );
    return { store: guarded, gate, start: () => Promise.resolve(), stop: () => undefined };
  }
  const read = createUsageReader({
    accountId: account,
    apiToken: token,
    periodAnchorDay: env.R2_PERIOD_ANCHOR_DAY,
    ...(deps.fetch && { fetch: deps.fetch }),
  });
  const clock = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = 0;
  let applied = 0;
  const refresh = () => {
    const mine = ++started;
    const began = billingPeriod(clock(), env.R2_PERIOD_ANCHOR_DAY).start.getTime();
    return read().then(
      (r) => {
        // Only a refresh that started after the last applied one may replace the reading.
        if (mine < applied) return;
        applied = mine;
        // The operation counts belong to the period the read began in. If the period turned meanwhile they are last
        // period's: keep the storage level (it does not reset) and start this period's operations from zero.
        const same = billingPeriod(clock(), env.R2_PERIOD_ANCHOR_DAY).start.getTime() === began;
        gate.apply(same ? r : { ...r, classA: 0, classB: 0 });
      },
      (err: unknown) => {
        // Keep the last reading: the gate keeps adding this process's calls on top, so it only gets stricter.
        deps.logger.warn({ err }, "could not read R2 usage from Cloudflare");
      },
    );
  };
  return {
    store: guarded,
    gate,
    start: async () => {
      timer = setInterval(() => void refresh(), deps.everyMs ?? MINUTE);
      timer.unref();
      await refresh();
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
