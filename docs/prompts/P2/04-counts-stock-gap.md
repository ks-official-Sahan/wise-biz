# P2-04 · Stock counts, stock-gap workflow, expiry handling

Effort: **H** · Needs: P2-03 · Gate: confirm workflow (show state diagram)
Read: `CONTEXT.md` (Stock count, Stock gap), `docs/research/pos-market.md` (Gaps table), `docs/modules.md` (inventory)
Skills: `domain-modeling`, `ux-principles`, `mobile-design`

## Goal
Find missing, stolen, or misplaced stock with a workflow that mixes scanning and human judgment, and handle expiring stock before it becomes a loss.

## Scope
- Counts: full or cycle (by category/location/ABC class), blind count option, count sheets split across devices, offline counting (sync commands), freeze snapshot vs. live-adjusted counting with movement reconciliation during the count.
- Variance review: per line expected vs counted, value impact, recount requests, approval → `count_variance` movements.
- **Stock-gap investigation**: variance lines become cases; evidence panel correlates voids, returns without receipt, overrides, adjustments, operators on shift, transfers in transit; resolution codes (theft, damage, data error, misplaced-found, supplier short); manual tasks with assignees.
- Expiry: near-expiry list, markdown suggestion (creates promotion draft), write-off flow, FEFO compliance report.
- POS counting screen (camera + HID scanner, large quantity input).

## Delegation
wb-db (sonnet) → wb-builder (sonnet) count + case logic → wb-ui-builder (sonnet) console review + POS count screen → wb-tester (sonnet) concurrency of counting during sales.

## Acceptance
- Counting while sales continue yields correct variances (simulation test).
- Gap case shows correlated events within the count window; resolutions audited.

## Review
`ecc:database-reviewer`, `ecc:security-reviewer` (permissions on adjustments)
