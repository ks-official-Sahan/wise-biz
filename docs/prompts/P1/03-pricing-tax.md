# P1-03 · Pricing and tax engine

Effort: **H** · Needs: P1-02 · Gate: confirm plan
Read: `docs/modules.md` (pricing), `docs/adr/0005-money-minor-units.md`, `docs/architecture/data-model.md` (Multi-currency, Batches), `PRODUCT.md` (Selling: discounts, tax, fees)
Libraries: `@wise-biz/money`, fast-check
Skills: `ecc:tdd-workflow`, `domain-modeling`, `ecc:latency-critical-systems`

## Goal
One deterministic pricing engine that prices a cart identically on every device and on the server, fast enough to run on every keystroke.

## Scope
1. **`@wise-biz/pricing-engine`** (universal, pure):
   - Input: cart lines (variant, qty in base unit, unit price source, batch price override), price list snapshot, promotions, coupons, fees, tax rules, customer group, now, rounding config.
   - Output: priced cart with per-line base price, discounts applied (ordered, with reason ids), tax per rate, line totals, cart discounts allocated back to lines (`allocate`), fees, totals, cash-rounding adjustment, and an explanation trace.
   - Promotions as data: percent/amount off item/category/cart, buy X get Y, bundle price, time window, min quantity/amount, stackable flag + priority, max uses (checked server-side).
   - Tax: inclusive/exclusive per region, multi-rate per category, compound flag, rounding per line or per document.
   - Incremental mode: re-price only changed lines + cart-level pass.
   - Version field on output so stored sales know which engine version priced them.
2. **`@wise-biz/tax`** if separation helps (otherwise inside the engine — ponytail).
3. `modules/pricing`: `price_lists` (currency, branch, customer group, validity), `prices`, `tax_rules`, `fees`, `promotions` (draft → published), `coupons`, `fx_rates` (manual entry now). Publish events; the sync feed later ships snapshots to devices.
4. Server endpoint `POST /v1/pricing/quote` (online carts, storefront later) using the same engine.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-builder (sonnet) | `packages/pricing-engine/**` | Item 1–2, TDD |
| 2 | wb-tester (sonnet) | `packages/pricing-engine/test/property/**` | Properties: totals = sum(lines) + fees − discounts + exclusive tax; allocation sums exactly; inclusive tax never changes gross; order-independence of non-stacking promos by priority |
| 3 | wb-db (sonnet) | `modules/pricing/migrations/**` | Item 3 tables |
| 4 | wb-builder (sonnet) | `modules/pricing/src/**` | Items 3–4 |

Note: agent 2 uses `model: "sonnet"` (property design needs judgment).

## Acceptance
- Golden tests: 30 hand-worked carts (include LKR, USD, JPY 0-decimals, KWD 3-decimals; inclusive and exclusive regions).
- Determinism: same input → byte-identical canonical output in Node and a Hermes-compatible run (or jsdom stand-in until the POS app exists; add the Hermes check in P1-08).
- Performance: 100-line cart full price < 2 ms, incremental single-line < 0.3 ms (bench on CI runner).
- Coverage ≥ 95% for the engine.

## Review
`ecc:typescript-reviewer`, `ecc:type-design-analyzer`, `ecc:database-reviewer`
