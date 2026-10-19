# P1-05 · Sales (server): commands, returns, voids, shifts, invoices

Effort: **H** · Needs: P1-01, P1-03, P1-04 · Gate: confirm plan
Read: `docs/architecture/data-model.md` (Sales table, Invoices and numbering), `docs/architecture/offline-sync.md` (Up: command outbox, Conflict policy), `docs/architecture/security.md` (Overrides, Transaction signing), `docs/modules.md` (sales, payments)
Libraries: `@wise-biz/pricing-engine`, `@wise-biz/policy`, `@wise-biz/audit-chain`, `@wise-biz/crypto`
Skills: `ecc:hexagonal-architecture`, `domain-modeling`, `ecc:tdd-workflow`

## Goal
The server side of every sale document. Commands arrive from terminals (through sync in P1-06), are validated against the rules the device used, and are applied atomically with stock movements, audit, and events.

## Scope
1. Tables: `sales`, `sale_lines` (snapshots), `sale_tenders`, `returns` + lines, `voids`, `shifts`, `drawer_sessions`, `cash_movements` (pay in/out, float), `overrides` (requester, approver, permission, reason, before/after), `invoice_sequences`.
2. **Command handlers** (pure application layer, transport-agnostic; P1-06 calls them): `CompleteSale`, `CompleteReturn`, `VoidSale`, `OpenShift`, `CloseShift`, `OpenDrawer`, `CashMovement`, `RecordOverride`. Each: validate payload (zod from contracts) → check terminal + operator + policy snapshot version the device declared → re-price with the declared engine version and price snapshot and compare (mismatch → accept + flag `price_mismatch` unless beyond tolerance → reject) → write documents → `InventoryPort.recordMovements` (FEFO allocations the device chose; server re-allocates if batch missing) → assign `invoice_no` gapless → audit + outbox, all in one transaction.
3. Returns: reference original sale and lines, partial returns, refund tenders, restock to location (or write-off reason), no-receipt returns behind permission.
4. Void: within policy window, reversing movements, original sale status → voided.
5. Shift close: expected vs counted cash (blind count option), over/short, Z-report data snapshot.
6. Payments module minimal: `payment_intents` record for card tenders reported by terminals (provider ref, auth code, last4, brand) — full gateway adapters come in P1-10/P2.
7. Online read APIs: sales list (filters, keyset), sale detail with includes, shift list, Z-report.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/sales/migrations/**`, `modules/payments/migrations/**` | Item 1, invoice sequence SQL |
| 2 | wb-builder (sonnet) | `modules/sales/src/domain/**`, `src/application/**` | Items 2–5 |
| 3 | wb-builder (sonnet) | `modules/sales/src/adapters/http/**`, `modules/payments/src/**` | Items 6–7 |
| 4 | wb-tester (sonnet) | `modules/sales/test/**` | Acceptance + property: replaying any command sequence twice yields identical state |

## Acceptance
- CompleteSale atomic: failure at any point (simulate at each write) leaves no partial rows.
- Invoice numbers gapless per branch under 100 concurrent sales.
- Same command twice → one sale, same response.
- Price mismatch within tolerance flagged; beyond tolerance rejected with `PRICE_MISMATCH`.
- Return > sold quantity rejected; void after window requires override.
- Sales list with includes: constant query count.

## Review
`ecc:database-reviewer`, `ecc:security-reviewer`, `ecc:typescript-reviewer`
