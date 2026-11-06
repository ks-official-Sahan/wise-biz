# 0025. Sentry error reports from the console

Status: accepted
Date: 2026-11-06

## Context

ADR 0022 wired Sentry into the server services only. The console (Next.js, browser plus Node server plus the proxy) was left
out because it needs its own SDK and a Content-Security-Policy that allows the report endpoint. The owner now has a Sentry
organization and wants console errors reported, on the free Developer plan (about 5,000 errors a month).

## Decision

1. `@sentry/nextjs` 10.76.2 (MIT), set up by hand (no `withSentryConfig`, so no source-map upload and no build step that needs
   an auth token): `src/instrumentation-client.ts` for the browser, `src/instrumentation.ts` for the Node and edge runtimes plus
   `onRequestError` for Server Components and route handlers, `src/app/global-error.tsx` for a failed root layout.
2. Same rules as the servers: errors only, `tracesSampleRate` 0, no replay, no breadcrumbs, `sendDefaultPii` false, and every
   event passes `scrubEvent` from `@wise-biz/observability` (no user, no extra data, request reduced to method and path,
   ids and emails masked).
3. Off unless `NEXT_PUBLIC_SENTRY_DSN` is set and is an https `sentry.io` DSN (`consoleSentryOptions`). It is read at build time
   for the browser, so it must be set when the console is built (Vercel: an environment variable before the deploy).
   `NEXT_PUBLIC_SENTRY_ENVIRONMENT` names the environment.
4. The CSP `connect-src` gains the DSN's ingest origin and nothing else (`sentryOrigin`: https and a `sentry.io` host only, so a
   wrong value cannot widen the policy).

## Consequences

- **License:** `@sentry/nextjs` depends on `@sentry/cli`, which is under the Functional Source License (FSL-1.1-MIT). That license allows every use except offering a competing error-tracking product and turns into MIT after two years. It is a build-time tool that is not in any bundle and whose install script pnpm does not run, so it is a reviewed exception in `scripts/check-licenses.mts`. `@sentry/nextjs` itself is MIT.
- The DSN is public by nature (it only lets a client send events); it is not a secret and may sit in the build environment.
- No readable stack traces for minified browser code until source maps are uploaded; that needs an auth token and a build
  plugin and is a later step. Server-side and unminified frames are readable now.
- The POS app and the desktop shell are still not reported: the POS bundle is size-budgeted (CLAUDE.md), so its SDK needs a
  bundle check first.
