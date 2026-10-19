# P2-08 · QR and online payments, multi-currency, reconciliation

Effort: **H** · Needs: P2-06 · Gate: choose providers per launch country (ask me)
Read: `docs/features/payments-hardware.md` (Payment architecture), `docs/architecture/security.md` (Payments and PCI), `docs/architecture/data-model.md` (Multi-currency)
Libraries: chosen gateways' SDKs/APIs, country QR scheme specs (e.g. LankaQR)
Skills: `ecc:security-review`, `ecc:api-connector-builder`, `ecc:finance-billing-ops`

## Goal
Accept the payment methods customers actually use, in more than one currency, and prove every cent settles.

## Scope
- Adapters: dynamic QR (country scheme), online card (hosted fields/redirect, 3DS by gateway), payment links via shortlinks; webhook verification first, idempotent by gateway event id.
- Multi-currency tender at POS: rate snapshot, change in base currency, receipts showing both.
- FX rates provider adapter (with manual override) and validity window on devices.
- Reconciliation: import settlement reports (API or file), match to intents/tenders, mismatch tasks, daily report.
- Refund flows per adapter capabilities (partial/full).

## Delegation
wb-researcher (haiku) provider APIs → wb-builder (sonnet) adapters (one agent per provider, worktrees) → wb-builder (sonnet) reconciliation → wb-ui-builder (sonnet) tender sheet updates + console reconciliation → wb-tester (haiku) sandbox scenarios.

## Acceptance
- Sandbox: success, decline, timeout, duplicate webhook, late webhook after cancel; no double capture or orphaned tender.
- Reconciliation matches 100% of a seeded day; mismatches produce tasks.

## Review
`ecc:security-reviewer` (mandatory), `ecc:database-reviewer`
