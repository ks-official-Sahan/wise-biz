# P2-03 · Suppliers, purchase orders, transfers

Effort: **M** · Needs: P1-16 · Gate: none
Read: `docs/modules.md` (inventory), `PRODUCT.md` (Inventory P2)
Skills: `inventory-demand-planning`, `ecc:api-design`

## Goal
Buy and move stock with paperwork that matches reality.

## Scope
- Suppliers (contacts, terms, lead time, currency), supplier price lists per variant.
- Purchase orders: draft → sent (PDF on letterhead, email) → partially/fully received (receiving against PO lines, over/under tolerance) → closed; cost updates.
- Transfers: request → dispatched (stock leaves source into `in_transit` location) → received (variance recorded) → closed; batch tracking preserved.
- Refill suggestions v1: below min → suggested PO lines by supplier (DSS proper comes in P2-14).
- Console screens; POS: receive transfer on a branch device (mobile camera scan).

## Delegation
wb-db (sonnet) → wb-builder (sonnet) use cases → wb-ui-builder (sonnet) console + POS receive screen → wb-tester (haiku).

## Acceptance
- Ledger invariants hold through PO receive and transfers (property tests); in-transit stock visible and valued.

## Review
`ecc:database-reviewer`
