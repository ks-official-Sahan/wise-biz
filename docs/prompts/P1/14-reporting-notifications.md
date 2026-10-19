# P1-14 · Rollups, reports, exports, notifications

Effort: **M** · Needs: P1-06 · Gate: none
Read: `SYSTEM.md` (MIS row), `docs/modules.md` (reporting, notifications), `docs/architecture/performance.md` (Projections, Caching layers), `docs/architecture/events.md` (Consumer rules)
Libraries: `@sahan-sac/email-kit`, XLSX writer (streaming), PDF renderer (same as P1-13c), Expo push notifications
Skills: `ecc:backend-patterns`, `ecc:data-throughput-accelerator`, `xlsx` (format knowledge only)

## Goal
Reports owners trust and get fast: rollups maintained by events, standard MIS reports with exports, and alerts that reach the right person.

## Scope
1. `modules/reporting` consumers → rollup tables: sales by day/branch/terminal/hour, by SKU/category/day, payments by tender/day, tax by rate/day, discounts and overrides by operator/day. Batched upserts; rebuild command per tenant/date range.
2. Reports API: sales summary, product performance, tax report, payments, Z-report history, staff performance (basic), stock valuation (from balances × cost); date range in branch timezone using `business_date`.
3. Exports: async jobs → CSV/XLSX/PDF in object storage, signed link, `reporting.export.ready` notification; row caps by entitlement later.
4. `modules/notifications`: in-app notifications table, preferences per user, email via email-kit through an outbox consumer (retries, rate shaping), Expo push tokens; templates: invite, low stock digest, expiring digest, device missed heartbeat, export ready, daily summary.
5. Console: reports pages (filters, charts, export buttons), notifications bell + preferences.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/reporting/migrations/**` | Rollup tables, indexes |
| 2 | wb-builder (sonnet) | `modules/reporting/src/**` | Items 1–3 |
| 3 | wb-builder (haiku) | `modules/notifications/**` | Item 4 (spec is explicit; escalate to sonnet if stuck) |
| 4 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/reports/**`, bell | Item 5 |
| 5 | wb-tester (haiku) | tests | Rollup equals raw aggregation for random data; rebuild idempotent |

## Acceptance
- Property test: rollups equal SQL aggregation over raw sales for random generated data, including returns and voids.
- Report queries p95 < 200 ms for one year of a 20-branch tenant (seeded).
- Export of 1M rows streams without exceeding 256 MB worker memory.

## Review
`ecc:database-reviewer`, `ecc:react-reviewer`
