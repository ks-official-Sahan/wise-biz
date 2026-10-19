# P1-13b · Console: sales, reports, devices, live dashboard

Effort: **M** · Needs: P1-06 (and P0-10) · Gate: none
Read: `docs/design/ux.md` (Management UI), `docs/architecture/events.md` (Realtime fan-out), `docs/architecture/security.md` (Devices)
Libraries: Next.js, TanStack Query, SSE client, chart library chosen with the `dataviz` skill
Skills: `dataviz`, `ecc:dashboard-builder`, `impeccable`, `ux-principles`, `accessibility-audit`

## Goal
The owner sees what is happening right now and can control terminals: live sales, sale details with full audit trail, shifts and Z-reports, and device approval and revocation.

## Scope
1. Home dashboard: today vs same weekday last week, live ticker via SSE, top items, low stock, expiring, terminals online, pending approvals; KPI tiles → trend → drill-down.
2. Sales: list (filters: branch, terminal, operator, status, flags like `price_mismatch`), detail (lines, tenders, receipt view, signature/chain status, related returns, audit entries).
3. Shifts: list, Z-report view/print, over/short highlights.
4. Devices: pending enrollments (approve with branch and name), list with health (last seen, app version, unsynced count, battery), suspend/revoke/blacklist with confirmation, heartbeat history.
5. Approvals inbox (overrides recorded, large adjustments, device enrollments) with badges in nav.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/(home)/**`, approvals | Items 1, 5 |
| 2 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/sales/**`, shifts | Items 2–3 |
| 3 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/devices/**` | Item 4 |
| 4 | wb-tester (haiku) | e2e | Approve device → POS sale → appears live on dashboard < 2 s → revoke → POS blocked |

## Acceptance
- e2e flow above passes against local stack.
- Charts follow dataviz rules (accessible colors, light/dark, labels); dashboard Lighthouse a11y ≥ 95.
- Dashboard reads rollups only (verify no raw sales scans in query logs).

## Review
`ecc:react-reviewer`, `ecc:a11y-architect`
