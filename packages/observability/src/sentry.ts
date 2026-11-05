/** The part of a Sentry event the scrubber reads and rewrites. */
export interface SentryEventLike {
  message?: string;
  exception?: { values?: { type?: string; value?: string }[] };
  request?: { method?: string; url?: string } & Record<string, unknown>;
  user?: unknown;
  extra?: unknown;
  contexts?: Record<string, unknown>;
  breadcrumbs?: unknown;
  [key: string]: unknown;
}

/** The part of `@sentry/node` used, so the package needs no hard import and tests need no network. */
export interface SentryModule {
  init: (options: Record<string, unknown>) => unknown;
  captureException: (error: unknown, hint?: { tags?: Record<string, string> }) => unknown;
  close: (timeout?: number) => Promise<boolean>;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;
const MAX_TEXT = 300;

/** Ids and email addresses are masked and long text is cut: an error message can carry a row's data. */
function maskText(text: string): string {
  return text.replace(UUID, "<id>").replace(EMAIL, "<email>").slice(0, MAX_TEXT);
}

/** The path only: a query string can hold tokens, codes or search terms. */
function pathOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return (
      new URL(url, "http://local").pathname
        .replace(UUID, "<id>")
        // A receipt code is the only key to its page, so it must not leave the server either.
        .replace(/^\/r\/[^/]+/, "/r/<code>")
    );
  } catch {
    return undefined;
  }
}

/**
 * What leaves the server on an error report: the error type, a masked message, the stack, the request method and path,
 * and the tags set by the caller. No headers, cookies, bodies, query strings, user, extra data or breadcrumbs (a report
 * must hold no secret, PII or card data; AGENTS.md).
 */
export function scrubEvent<T extends SentryEventLike>(event: T): T {
  const clean: SentryEventLike = { ...event };
  delete clean.user;
  delete clean.extra;
  delete clean.breadcrumbs;
  delete clean.contexts;
  if (clean.message !== undefined) clean.message = maskText(clean.message);
  if (clean.exception?.values !== undefined) {
    clean.exception = {
      ...clean.exception,
      values: clean.exception.values.map((v) => ({
        ...v,
        ...(v.value === undefined ? {} : { value: maskText(v.value) }),
      })),
    };
  }
  if (clean.request !== undefined) {
    const url = pathOf(clean.request.url);
    clean.request = {
      ...(clean.request.method === undefined ? {} : { method: clean.request.method }),
      ...(url === undefined ? {} : { url }),
    };
  }
  return clean as T;
}

let active: SentryModule | undefined;

/**
 * Starts Sentry error reporting only when `SENTRY_DSN` is set; the SDK is imported lazily so deployments without it pay
 * nothing. Errors only: no tracing (OpenTelemetry owns that), no default PII, no breadcrumbs. Returns a function that
 * flushes pending reports, or undefined when reporting is off.
 */
export async function startSentry(
  source: Readonly<Record<string, string | undefined>>,
  load: () => Promise<SentryModule>,
  service: string,
): Promise<(() => Promise<void>) | undefined> {
  const dsn = source.SENTRY_DSN;
  if (dsn === undefined || dsn === "") return undefined;
  const sentry = await load();
  sentry.init({
    dsn,
    environment: source.SENTRY_ENVIRONMENT ?? source.NODE_ENV,
    ...(source.SENTRY_RELEASE === undefined ? {} : { release: source.SENTRY_RELEASE }),
    serverName: service,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // The OpenTelemetry SDK (when OTEL_EXPORTER_OTLP_ENDPOINT is set) owns tracing; Sentry must not install a second one.
    skipOpenTelemetrySetup: true,
    maxBreadcrumbs: 0,
    beforeSend: (event: SentryEventLike) => scrubEvent(event),
  });
  active = sentry;
  return async () => {
    await sentry.close(2000);
  };
}

/** Reports an error that was handled (an unhandled one is caught by the SDK itself). No-op when reporting is off. */
export function captureError(err: unknown, tags?: { requestId?: string }): void {
  active?.captureException(
    err,
    tags?.requestId === undefined ? undefined : { tags: { request_id: tags.requestId } },
  );
}

/** For tests: forget the started client. */
export function resetSentryForTests(): void {
  active = undefined;
}
