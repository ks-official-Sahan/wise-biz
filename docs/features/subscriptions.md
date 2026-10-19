# Subscriptions and entitlements

## Model

```
plan ──< plan_features (feature_key, enabled, limit)
tenant ──< subscriptions (plan_id, status, period, trial_ends_at)
tenant ──< grants (feature_key, enabled, limit, source: payg|promo|manual, starts_at, ends_at)
tenant ──< usage_counters (feature_key, period, used)
```

**Effective entitlements** = plan features ⊕ grants (grants override), minus anything suspended. Computed by `@pos/entitlements`, cached in Redis per tenant version, and shipped to devices as a signed token (`exp` 7 days for offline grace).

## Feature keys (examples)

| Key | Type | Example limits |
|---|---|---|
| `branches.max` | limit | 1 / 5 / ∞ |
| `terminals.max` | limit | 2 / 20 / ∞ |
| `users.max` | limit | 5 / 50 / ∞ |
| `inventory.batches` | flag | |
| `inventory.transfers` | flag | |
| `loyalty` | flag | |
| `storefront` | flag | |
| `analytics.advanced` | flag | |
| `insights.ai` | flag + quota | AI calls/month |
| `mcp.store` | flag | |
| `integrations.accounting` | flag | |
| `api.public` | flag + quota | requests/day |
| `exports.max_rows` | limit | |
| `branding.custom_fonts` | flag | |

## Enforcement

- Server: every use case declares `entitlement`; checked after auth, before permission. Over-limit → `402 ENTITLEMENT_REQUIRED` or `LIMIT_REACHED` problem code with upgrade hint.
- Device: hides disabled features from the signed token; never trusts local toggles for server writes.
- Limits counted on create (terminals, branches) with a DB constraint check inside the transaction to avoid races (`select count(*) … for update` on the tenant row).

## Lifecycle

`trialing → active → past_due → (grace 7–14 days, read-only selling allowed) → suspended → canceled`. Selling never stops mid-shift because of billing; suspension applies at next shift open, with clear notice to owner first.

## Pay-as-you-go

- Only for tenants flagged `payg_eligible` by platform admin.
- Platform console/MCP grants individual features with price per unit (per transaction, per terminal-day, per AI call).
- Metering from events (`sales.sale.completed` → `usage_counters`), idempotent by event id.
- Monthly invoice to tenant from billing module; payment via gateway adapter (card on file) or bank transfer.

## Where it lives in the UI

- Platform console: Plans editor, Tenant → Subscription tab (plan, trial extend, grants, usage).
- Owner console: Billing page (current plan, usage bars, upgrade, invoices).
