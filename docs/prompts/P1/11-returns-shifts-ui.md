# P1-11 · Returns, voids, shifts, overrides (POS UI)

Effort: **M** · Needs: P1-10 · Gate: none
Read: `docs/design/ux.md` (Checkout flow rules), `PRODUCT.md` (Selling: returns, line edits; People: shifts), `docs/architecture/security.md` (Overrides)
Libraries: `@wise-biz/sync`, `@wise-biz/receipt`
Skills: `ux-principles`, `impeccable`, `mobile-design`

## Goal
Everything a cashier and supervisor need around the sale: open and close shifts with cash counts, return or void correctly, and approve overrides quickly, all offline-capable and audited.

## Scope
1. Shift: open with float, drawer events (pay in/out with reason), close with blind count (configurable), over/short shown after count, Z-report print + store.
2. Returns: find original by receipt QR/barcode, sale number, or recent list (local; online lookup if not on device); pick lines and quantities; restock or write-off reason; refund to original tender or allowed alternative; no-receipt return behind permission.
3. Void: within window from recent sales; reason; override if outside window.
4. Overrides: reuse the P1-09 sheet; queue of pending approvals on supervisor's own device (P2 remote approval note).
5. Reprint, email/SMS receipt link.
6. Commands: `OpenShift`, `CloseShift`, `CashMovement`, `CompleteReturn`, `VoidSale`, `RecordOverride` created through `@wise-biz/sync`.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-ui-builder (sonnet) | `apps/pos/src/features/{shift,returns,void}/ui/**` | UI |
| 2 | wb-builder (sonnet) | `apps/pos/src/features/{shift,returns,void}/model/**` | Logic + commands |
| 3 | wb-tester (haiku) | Maestro flows | Shift open → sales → return → void → close with over/short |

## Acceptance
- Maestro: full shift flow offline, then online sync applies all commands; server Z-report equals device Z-report.
- Return of more than sold or of an already returned line blocked locally and on server.
- All overrides visible in the console audit log after sync.

## Review
`ecc:react-reviewer`, `ecc:a11y-architect`
