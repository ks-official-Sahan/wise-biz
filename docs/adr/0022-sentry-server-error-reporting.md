# ADR 0022: Server error reporting with Sentry, errors only and scrubbed

Status: accepted · 2026-11-05

## Context
The services log errors with pino and trace with OpenTelemetry, but nobody is told when an unhandled error happens in production. `deployment.md` calls for Sentry with PII scrubbing. The rules for this project forbid secrets, personal data and card data in logs and reports, and an error report can carry request bodies, headers, cookies and the user.

## Decision
- A small package, `@wise-biz/observability`, starts `@sentry/node` in the api, workers and realtime only when `SENTRY_DSN` is set. The SDK is imported lazily, so a deployment without a DSN pays nothing, as with OpenTelemetry.
- Errors only: `tracesSampleRate: 0` and `skipOpenTelemetrySetup: true` (OpenTelemetry stays the tracing system and Sentry installs no second one), `sendDefaultPii: false`, no breadcrumbs.
- Every event passes `scrubEvent` before it leaves: the user, extra data, contexts and breadcrumbs are removed, the request is cut down to method and path (no headers, cookies, body or query string), and UUIDs and email addresses in messages are masked and long text is cut to 300 characters.
- The API's unhandled-error handler reports the error with the request id as a tag. The SDK catches uncaught exceptions and unhandled rejections itself. Services flush pending reports on shutdown.
- `SENTRY_ENVIRONMENT` (staging or production) and `SENTRY_RELEASE` (the tag) are set by the deploy workflow, because `NODE_ENV` is `production` in both.
- `@sentry/node` is pinned to 10.x (MIT). Version 11 turns request and user data collection on by default, so an upgrade needs a new look at the scrubber.

## Consequences
- Reports hold the error type, a masked message and the stack, which is enough to find the line; they do not hold who or what the request was about. The request id links a report to the logs.
- The scrubber is the only line of defence for what the SDK collects by default; its tests assert that tokens, bearer headers, card numbers and email addresses do not survive.
- Client apps (console, POS, desktop) are not covered. Each needs its own SDK, and the POS app needs a bundle-size check first (`CLAUDE.md`); they get their own decision.
