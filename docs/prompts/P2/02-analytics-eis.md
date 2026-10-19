# P2-02 · Analytics, MIS expansion, EIS board

Effort: **M** · Needs: P2-01 · Gate: none
Read: `SYSTEM.md` (System of systems), `docs/modules.md` (reporting), `docs/design/ux.md` (Management UI)
Libraries: chart lib (dataviz rules), read-replica routing in `@wise-biz/db`
Skills: `dataviz`, `ecc:dashboard-builder`, `ecc:clickhouse-io` (only if Postgres rollups miss targets)

## Goal
Margins, baskets, cohorts, and staff performance for managers; a one-screen multi-branch KPI board for owners.

## Scope
- Rollups: gross margin (cost snapshot from sale lines), basket size/value, attach rate, hourly heatmap, category mix, customer cohorts (when P2-05 lands), staff performance (sales, voids, discounts, overrides per hour worked).
- Read-replica routing for reports.
- EIS board: few KPIs across all branches, trend sparkline, drill-down to branch → category → SKU; scheduled email digest.
- Decision record if ClickHouse is needed (only with evidence from load tests).

## Delegation
wb-db (sonnet) rollups + EXPLAIN → wb-builder (sonnet) APIs → wb-ui-builder (sonnet) console pages → wb-tester (haiku) rollup-vs-raw property tests.

## Acceptance
- Every KPI matches raw aggregation in tests; EIS board loads < 1 s for a 50-branch tenant (seeded).

## Review
`ecc:database-reviewer`, `ecc:react-reviewer`
