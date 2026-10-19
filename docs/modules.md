# Modules

Each module: owns a Postgres schema, exposes contracts in `@pos/contracts/<module>`, emits events `<module>.<entity>.<verb>`. Columns: **Owns** (tables), **Emits**, **Consumes**, **Phase**.

| Module | Responsibility | Owns | Emits | Consumes | Phase |
|---|---|---|---|---|---|
| **identity** | Users, credentials, sessions, MFA, passkeys, PIN | users, sessions, credentials, pins, mfa_* | `identity.user.*`, `identity.session.*` | — | P1 |
| **tenancy** | Tenants, branches, locations, memberships, roles, settings, timezones | tenants, branches, locations, memberships, roles, role_permissions, settings | `tenancy.*` | `billing.subscription.*` | P1 |
| **devices** | Enrollment, keys, approval, allow/deny lists, heartbeats, sessions on device | devices, device_keys, device_heartbeats, device_events | `devices.device.enrolled/approved/revoked`, `devices.heartbeat.missed` | `tenancy.branch.*` | P1 |
| **catalog** | Products, variants, barcodes, units, categories, tags, images | products, variants, barcodes, units, unit_conversions, categories, tags | `catalog.*` | `media.asset.*` | P1 |
| **pricing** | Price lists, tax rules, fees, promotions, coupons, currency rates | price_lists, prices, tax_rules, fees, promotions, coupons, fx_rates | `pricing.*` | `catalog.variant.*` | P1 |
| **inventory** | Ledger, balances, batches, reservations, receiving, adjustments, transfers, counts, gaps | stock_movements (partitioned), stock_balances, batches, reservations, receipts, transfers, counts, count_lines | `inventory.movement.recorded`, `inventory.balance.low`, `inventory.batch.expiring`, `inventory.gap.detected` | `sales.sale.completed`, `sales.return.completed`, `orders.*` | P1 |
| **sales** | Carts (server copy), sales, lines, returns, voids, quotations, shifts, drawers, invoice numbering | sales, sale_lines, sale_tenders, returns, voids, quotations, shifts, drawer_sessions, cash_movements, invoice_sequences | `sales.sale.completed/voided`, `sales.return.completed`, `sales.shift.closed` | `devices.*` (validate terminal), `pricing.*` | P1 |
| **payments** | Gateway adapters, terminal integration, intents, captures, refunds, settlements | payment_intents, payment_events, settlements, gateway_accounts | `payments.intent.*`, `payments.refund.*` | `sales.*`, `orders.*` | P1 |
| **orders** | Online, pickup, delivery, reservations, layaway, deposits | orders, order_lines, fulfillments | `orders.*` | `payments.*`, `inventory.*` | P2 |
| **customers** | Profiles, consent, addresses, groups, notes | customers, customer_groups, consents, notes | `customers.*` | `sales.sale.completed` | P1 |
| **loyalty** | Points ledger, tiers, rewards, cards, operator points | loyalty_accounts, points_ledger, tiers, rewards, card_designs, operator_points | `loyalty.points.*` | `sales.*`, `customers.*` | P2 |
| **staff** | Employees, commissions, time clock | employees, clock_events, commission_rules | `staff.*` | `sales.*` | P2 |
| **reporting** | MIS rollups, exports, Z-reports, scheduled reports | rollup_* (by day/branch/sku), export_jobs | `reporting.export.ready` | all TPS events | P1 |
| **insights** | DSS: reorder, forecast, expiry risk, anomaly, gap analysis, AI narratives | forecasts, suggestions, anomalies | `insights.suggestion.created` | TPS events, rollups | P2 |
| **billing** | Plans, subscriptions, trials, entitlements, metering, invoices to tenants | plans, plan_features, subscriptions, grants, usage_counters | `billing.subscription.*`, `billing.entitlements.changed` | `sales.sale.completed` (metering) | P2 |
| **integrations** | Accounting, Shopify, WooCommerce, webhooks out, public API keys | connections, webhook_endpoints, webhook_deliveries, api_keys | `integrations.*` | any public event | P2 |
| **notifications** | In-app, email, push, SMS; preferences | notifications, preferences, push_tokens | — | many | P1 |
| **audit** | Hash-chained audit log, platform snapshots, restore jobs | audit_log (partitioned), snapshots, restore_jobs | `audit.snapshot.created` | — (written in-tx by all) | P1 |
| **media** | Wraps media-kit; per-tenant folders, variants for offline cache | media_assets, media_usage | `media.asset.*` | — | P1 |
| **theming** | Theme tokens, fonts, receipt templates, letterheads, card templates | themes, fonts, receipt_templates, letterheads | `theming.theme.published` | — | P1 |
| **support** | Tickets, platform announcements | tickets, ticket_messages | `support.*` | — | P2 |
| **search** | Hybrid search index projection | search_documents (FTS + trigram + vector) | — | `catalog.*`, `customers.*` | P1 |
| **shortlinks** | URL shortening for receipts, payment links, campaigns (edge) | short_links | — | — | P1 |

## Dependency rules

```
identity ← tenancy ← devices
catalog ← pricing
catalog, pricing, devices, customers ← sales ← payments
reporting, insights, search, loyalty, billing (metering) = event consumers only
```

- No cycles. CI enforces with `dependency-cruiser` on `modules/*`.
- P1 sale path: device writes locally → command `CompleteSale` → `sales` transaction inserts sale + lines + tenders and calls `InventoryPort.recordMovements` **in the same DB transaction** (one database while monolith). After extraction, inventory consumes `sales.sale.completed` instead. Balances are already a projection, so behavior holds.
- Online orders call `InventoryPort.reserve` synchronously, then `commit` or `release`.

## Adding a module (checklist)

1. Create `modules/<name>/` with domain, application, ports, adapters.
2. Add schema migration under `modules/<name>/migrations`. RLS policy on every table.
3. Add contracts and event schemas to `@pos/contracts`.
4. Register routes in `apps/api`, permissions in `@pos/policy`, entitlement key in `@pos/entitlements`.
5. Add a row to this table.
