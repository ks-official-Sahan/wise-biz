# Modules

Each module: owns a Postgres schema, exposes contracts in `@wise-biz/contracts/<module>`, emits events `<module>.<entity>.<verb>`. Columns: **Owns** (tables), **Emits**, **Consumes**, **Phase**.

| Module | Responsibility | Owns | Emits | Consumes | Phase |
|---|---|---|---|---|---|
| **identity** | Users, credentials, sessions, MFA, passkeys, PIN | users, sessions, credentials, pins, mfa_* | `identity.user.*`, `identity.session.*` | — | P1 |
| **tenancy** | Tenants, branches, locations, memberships, roles, settings, timezones | tenants, branches, locations, memberships, roles, role_permissions, settings | `tenancy.*` | `billing.subscription.*` | P1 |
| **devices** | Enrollment by one-time owner code (redeeming it approves the terminal), Ed25519 key per device, signed requests (`@wise-biz/http-signatures`, kernel `deviceAuth`), status (active/suspended/revoked/blacklisted), heartbeats, operator PIN (P1-01b) | devices, enrollment_codes, device_heartbeats | `devices.device.enrolled`, `devices.device.status_changed` | — (branch check via the composition root) | P1 |
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
| **audit** | Hash-chained audit log, read API for the console viewer (`/v1/audit/entries`, CSV `/v1/audit/export`, permissions `audit:read` / `audit:export`), platform snapshots, restore jobs | audit_log (partitioned), snapshots, restore_jobs | `audit.export.requested`, `audit.snapshot.created` | — (written in-tx by all) | P1 |
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

## Adding a module

Copy `modules/_template` (package `@wise-biz/module-template`, dev-only, never mounted in production). It is the reference for layout, RLS, keyset lists, `?include`, and tests.

1. **Copy and rename.** `cp -r modules/_template modules/<name>`; set `name` in `package.json` (`@wise-biz/module-<name>`) and in `src/index.ts` (`defineModule({ name: "<name>", ... })`). Drop `devOnly`. Rename the Postgres schema (`template` -> `<name>`), the Drizzle `pgSchema(...)`, the route prefix (`/v1/<name>/...`), and the permissions (`definePermissions("<name>", [...])`).
2. **Layout (hexagonal).** `domain/` pure rules (no IO, inject Clock/Ids); `application/` use cases (authorize -> validate -> idempotency -> one tx with audit + outbox); `ports/` interfaces; `adapters/db` (Drizzle only here) and `adapters/http` (Hono `createRoute`); `contracts.ts` re-exports the zod schemas.
3. **Migration checklist** (`migrations/0001_init.sql`; never edit a merged migration, add the next number):
   - `CREATE SCHEMA <name> AUTHORIZATION wb_migrator; GRANT USAGE ON SCHEMA <name> TO wb_app;`
   - Every table: `id uuid NOT NULL DEFAULT uuidv7()`, `tenant_id uuid NOT NULL`, `created_at timestamptz`, and `PRIMARY KEY (tenant_id, id)` (one index = tenant-leading keyset index and FK target; no `PK(id)`, no `UNIQUE(tenant_id, id)`). Omit `updated_at`/`deleted_at` until a use case needs them. Text columns: `CHECK (btrim(col) <> '' AND length(col) <= N)`.
   - RLS on every table: paste the exact output of `rlsSql("<name>", "<table>")` from `@wise-biz/db` (enable + force + `tenant_isolation` policy).
   - Indexes: `tenant_id` leads every index; the `(tenant_id, id)` PK serves keyset lists; an index on every FK (`(tenant_id, parent_id, id)`); partial indexes for hot filters.
   - Child tables reference the parent with a composite FK `(tenant_id, parent_id) -> parent (tenant_id, id)` so a row can never point at another tenant's parent. FKs are `ON DELETE RESTRICT`; `CASCADE` only for owned parts, with a justifying comment.
   - Least privilege: `REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA <name> FROM wb_app;`, then `GRANT` back per table only what the module needs. Append-only tables never get UPDATE/DELETE.
   - Later migrations are expand/contract: `ADD COLUMN NULL` -> backfill -> `CHECK ... NOT VALID` -> `VALIDATE CONSTRAINT`; `CREATE INDEX CONCURRENTLY` in its own file starting `-- wb:no-transaction`.
   - Run `pnpm db:migrate && pnpm db:rls-check`; CI fails on a table without RLS.
4. **Register.** Add the folder name to `modules/registry.json` and the module export to `apps/api/src/modules.ts`. Add the module's row to the table above.
5. **Boundary.** Other modules import only `modules/<name>/contracts.ts` (depcruise `no-cross-module-internals`). Shared shapes and event schemas go to `@wise-biz/contracts`. Run `pnpm depcruise`.
6. **Lists and writes.** Keyset `?limit&after` (cursor = base64url of the last id; repositories fetch `limit + 1`). `?include=` is an allowlist (others -> 422), one batched query per relation (`item_id = any($ids)`); repository methods take arrays, never loop per row. Every mutation: authorize first, validate with zod, idempotency key, then one `withTenantTx` with domain writes + audit row + outbox event.
7. **Tests** (`test/*.test.ts`, Testcontainers Postgres via `@wise-biz/testing/containers`): create/list round trip; keyset pagination; **query-count test** with `countQueries` (list with `include` = exactly 2 queries for 50 rows, 1 without); RLS isolation (repository, raw SQL, missing tenant setting returns zero rows, cross-tenant FK rejected); `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of the real queries (real params, as `wb_app` inside `withTenantTx`, seeded and `ANALYZE`d) shows Index Scan / Index Only Scan, no `Seq Scan`. Batch lookups cap at 200 ids (max page size).
8. **Policy and entitlements.** Add permissions to `@wise-biz/policy` role matrices and the entitlement key to `@wise-biz/entitlements`.
