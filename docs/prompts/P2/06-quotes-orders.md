# P2-06 · Quotations, orders, reservations, layaway

Effort: **M** · Needs: P2-05 · Gate: none
Read: `docs/modules.md` (orders, inventory reservations), `PRODUCT.md` (Selling P2)
Skills: `domain-modeling`, `ecc:api-design`

## Goal
Sell beyond the counter: priced quotes, orders for pickup or delivery, reservations, and layaway with deposits.

## Scope
- Quotations: create in POS or console, PDF on letterhead, expiry, convert to sale or order (prices honored until expiry).
- Orders: channels (counter, phone, storefront), statuses, fulfillment (pick, pack, ready, picked up, delivered), stock reservations via `InventoryPort.reserve/commit/release`, notifications to customer.
- Deposits and layaway: partial payments, schedule, cancellation rules, refunds.
- POS order queue screen; console order management.

## Delegation
wb-db (sonnet) → wb-builder (sonnet) → wb-ui-builder (sonnet) → wb-tester (haiku).

## Acceptance
- Reservation prevents overselling online while POS sales continue (concurrency test); cancellations release stock.

## Review
`ecc:database-reviewer`, `ecc:react-reviewer`
