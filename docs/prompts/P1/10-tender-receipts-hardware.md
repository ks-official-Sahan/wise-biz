# P1-10 · Tender, receipts, hardware ports

Effort: **H** · Needs: P1-09 · Gate: decide first card-terminal provider + target country QR (ask me; default: mock adapter now)
Read: `docs/features/payments-hardware.md` (all), `docs/architecture/offline-sync.md` (Offline payments), `docs/architecture/security.md` (Payments and PCI), `docs/design/theming.md` (receipt settings)
Libraries: ESC/POS encoder (small, maintained), RN printer libs for Bluetooth/network (evaluate 2–3; wrap behind ports), payment terminal SDK/cloud API for the chosen provider
Skills: `ecc:latency-critical-systems`, `ecc:security-review`, `mobile-design`

## Goal
Take payment and finish the sale in one motion: tender sheet, cash with change, split tenders, one real or mock card terminal, a receipt printing within a second, and a digital receipt link.

## Scope
1. Tender sheet: suggested amounts (exact, next notes for currency), cash entry with large change display, split tender list with remaining balance, store credit/voucher placeholders, offline-aware availability (QR/online hidden offline).
2. Complete sale locally: one local transaction (sale + lines + tenders + local movements + outbox command); new cart focused; receipt triggered.
3. **`@wise-biz/payments-adapters`**: `PaymentAdapter` interface from payments-hardware.md; `mock` adapter (approve/decline/timeout scenarios) and the chosen provider's semi-integrated terminal adapter; terminal status UI live; cancel/reversal on failure.
4. **`@wise-biz/hardware`** ports: `Printer`, `CashDrawer`, `Scanner`, `CustomerDisplay`, `Scale`; RN implementations for network (TCP 9100) and Bluetooth printers; drawer kick via printer.
5. **`@wise-biz/receipt`**: template model (blocks from payments-hardware.md) → ESC/POS bytes (58/80 mm, logo raster dithering, code pages) and HTML; prebuild bytes during tender to hit the 1 s budget.
6. Digital receipt: shortlink (`modules/shortlinks` minimal + edge later) showing the HTML receipt; QR on printed receipt.
7. Cash rounding per currency applied from pricing output.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | ESC/POS encoders; RN Bluetooth/network printer libs (maintenance, new-arch support); provider terminal API |
| 2 | wb-ui-builder (sonnet) | `apps/pos/src/features/tender/ui/**` | Item 1 |
| 3 | wb-builder (sonnet) | `apps/pos/src/features/tender/model/**` | Items 2, 7 |
| 4 | wb-builder (sonnet) | `packages/payments-adapters/**` | Item 3 |
| 5 | wb-builder (sonnet) | `packages/hardware/**`, `packages/receipt/**` | Items 4–5 |
| 6 | wb-builder (haiku) | `modules/shortlinks/**` | Item 6 (simple CRUD + redirect) |
| 7 | wb-tester (haiku) | tests | Golden ESC/POS byte snapshots, adapter scenarios, Maestro cash + split flows |

## Acceptance
- Cash sale: tender → sale committed ≤ 150 ms p95; print starts ≤ 1 s on a network printer (manual test log in PR).
- Split tender (card mock + cash) correct totals and change; card decline returns to tender sheet without losing the cart.
- Offline: cash works, card only if adapter reports store-and-forward capability; QR hidden.
- Receipt snapshots match for 58 and 80 mm; HTML receipt reachable by shortlink.

## Review
`ecc:security-reviewer` (payments), `ecc:react-reviewer`, `ecc:typescript-reviewer`
