import * as Sentry from "@sentry/nextjs";

import { consoleSentryOptions } from "./lib/sentry.ts";

// Browser error reports (ADR 0022). Off unless NEXT_PUBLIC_SENTRY_DSN was set when the console was built.
const options = consoleSentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, {
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
});
if (options !== undefined) Sentry.init(options);
