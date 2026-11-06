import { scrubEvent } from "@wise-biz/observability";

import type { SentryEventLike } from "@wise-biz/observability";

/**
 * The origin that error reports go to, from the DSN: https and a sentry.io host only, so a bad value can never widen the
 * CSP connect-src to somewhere else. `https://KEY@o1.ingest.de.sentry.io/2` gives `https://o1.ingest.de.sentry.io`.
 */
export function sentryOrigin(dsn: string | undefined): string | undefined {
  if (dsn === undefined || dsn === "") return undefined;
  try {
    const u = new URL(dsn);
    if (
      u.protocol !== "https:" ||
      !(u.hostname === "sentry.io" || u.hostname.endsWith(".sentry.io"))
    )
      return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/**
 * Sentry options for the console (browser, Node server and edge share them): errors only, no tracing, no replay, no
 * breadcrumbs, no default PII, and every event goes through the same scrubber as the servers (ADR 0022). Returns
 * undefined, so nothing starts, unless the DSN is a valid Sentry DSN.
 */
export function consoleSentryOptions(
  dsn: string | undefined,
  env: { environment?: string | undefined; release?: string | undefined } = {},
): Record<string, unknown> | undefined {
  if (sentryOrigin(dsn) === undefined) return undefined;
  return {
    dsn,
    ...(env.environment === undefined ? {} : { environment: env.environment }),
    ...(env.release === undefined ? {} : { release: env.release }),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeSend: (event: SentryEventLike) => scrubEvent(event),
  };
}
