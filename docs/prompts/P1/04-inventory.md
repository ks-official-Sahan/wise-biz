# P1-04 · Inventory: ledger, balances, batches, FEFO

Effort: **H** · Needs: P1-02 · Gate: confirm plan
Read: `docs/architecture/data-model.md` (Inventory ledger, Batches and FEFO), `docs/modules.md` (inventory, dependency rules), `CONTEXT.md` (stock terms)
Libraries: Drizzle, Postgres partitioning
Skills: `ecc:postgres-patterns`, `ecc:database-migrations`, `inventory-demand-planning` (for thresholds), `ecc:latency-critical-systems`

## Goal
Stock that never lies: every change is a ledger movement, balances update in the same transaction, batches with their own prices and expiry are first-class, and drift is detected automatically.

## Scope
1. Tables: `stock_movements` (monthly partitions, unique idempotency index per data-model.md), `stock_balances (tenant, location, variant, batch) qty, reserved, version`, `batches`, `reservations`, `receipts` + `receipt_lines`, `adjustments` + reason codes, `stock_thresholds` (min/max per variant/location).
2. **`InventoryPort`** (in-process): `recordMovements(tx, movements[])` (batch insert + balance upsert in one statement per batch), `reserve`, `commitReservation`, `release`, `selectBatchesFefo(locationId, variantId, qty)` returning allocations across batches.
3. Use cases: `receiveStock` (with or without PO, creates batches with cost, expiry, optional sale price), `adjustStock` (reason required, permission + ABAC threshold → approval override), balance queries (by location/variant, by batch, with expiring filter).
4. Rules: negative balances allowed and emit `inventory.balance.negative`; expired batches blocked unless `inventory:sell_expired`.
5. Jobs: low-stock evaluator (on movement events, debounced per variant), expiring-batch daily job (`inventory.batch.expiring`, configurable horizon), nightly drift check (re-derive balances from ledger, alert on mismatch), partition creator.
6. Events per modules.md.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/inventory/migrations/**`, SQL for upserts and FEFO | Item 1 + EXPLAIN on 10M-row seeded ledger |
| 2 | wb-builder (sonnet) | `modules/inventory/src/**` | Items 2–6 |
| 3 | wb-tester (sonnet) | `modules/inventory/test/**` | Property: for any sequence of movements, balance = Σ ledger; concurrent receive/sell on same SKU from 50 workers never loses updates; replaying the same source is a no-op |

## Acceptance
- Property and concurrency tests pass (50 parallel transactions, no lost updates, no deadlocks; use consistent lock order).
- FEFO picks earliest expiry; batch sale price overrides price list in the pricing quote (integration with P1-03).
- Drift job finds an injected mismatch.
- Balance query p95 < 20 ms on 10M ledger rows (EXPLAIN attached).

## Review
`ecc:database-reviewer`, `ecc:performance-optimizer`
