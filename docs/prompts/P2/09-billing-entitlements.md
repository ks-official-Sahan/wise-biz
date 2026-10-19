# P2-09 · Plans, trials, entitlements, pay-as-you-go

Effort: **H** · Needs: P1-16 · Gate: confirm plan matrix with me
Read: `docs/features/subscriptions.md` (all), `PRODUCT.md` (Plans)
Libraries: billing provider (Stripe Billing or local gateway + own invoicing; decide), `@wise-biz/crypto` (signed entitlement token)
Skills: `ecc:customer-billing-ops`, `ecc:finance-billing-ops`, `ecc:security-review`

## Goal
Every feature and limit is governed by entitlements, so plans, trials, and per-tenant pay-as-you-go grants are configuration, not code.

## Scope
- `@wise-biz/entitlements`: effective entitlements (plan ⊕ grants), Redis cache by version, signed device token (7-day grace), `requireEntitlement(key)` in `runCommand` (after auth, before permission), limit checks inside transactions (lock tenant row).
- `modules/billing`: plans, plan_features, subscriptions lifecycle (trialing → active → past_due → grace → suspended → canceled; never stop mid-shift), grants (payg/promo/manual), usage counters from events (idempotent), monthly invoices to tenants.
- Retrofit: tag existing features with entitlement keys (catalog of keys in subscriptions.md).
- Console: owner billing page (plan, usage bars, invoices, upgrade); platform console: plans editor, tenant subscription tab, grants, PAYG eligibility.

## Delegation
wb-builder (sonnet) entitlements package → wb-db (sonnet) billing tables → wb-builder (sonnet) lifecycle + metering → wb-ui-builder (sonnet) consoles → wb-tester (sonnet) lifecycle and race tests.

## Acceptance
- Disabled feature: hidden on devices, `402 ENTITLEMENT_REQUIRED` on server; concurrent terminal enrollments cannot exceed `terminals.max`.
- Metering counts each sale once under replays.

## Review
`ecc:security-reviewer`, `ecc:database-reviewer`
