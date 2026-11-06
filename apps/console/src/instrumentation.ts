import * as Sentry from "@sentry/nextjs";

import { consoleSentryOptions } from "./lib/sentry.ts";

// Server and edge error reports (ADR 0022). Off unless NEXT_PUBLIC_SENTRY_DSN is set.
export function register(): void {
  const options = consoleSentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, {
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  });
  if (options !== undefined) Sentry.init(options);
}

// Errors from Server Components, route handlers and the proxy.
export const onRequestError = Sentry.captureRequestError;
