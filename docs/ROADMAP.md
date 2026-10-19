# Roadmap

Phases ship vertical slices. Each phase ends with a usability test and a load test against `SYSTEM.md` targets.

## P0 — Foundations (3–4 weeks)

- Monorepo (pnpm + Turborepo), lint/tsconfig presets, CI (`ci.yml`, `security.yml`), compose stack.
- `@pos/ids`, `@pos/money`, `@pos/contracts` skeleton, `@pos/policy`, `@pos/audit-chain`, `@pos/theme` (tokens + contrast validator).
- `apps/api` with tenancy, identity (auth-kit Better Auth engine + tenancy extension), RLS, outbox + relay (pg broker), audit.
- `apps/console` shell: sign-in, tenant/branch setup, users and roles.
- Upstream PRs to `@sahan-sac/auth-kit` (tenant context) and `media-kit` (tenant prefix).

**Exit:** tenant can sign up, add a branch and a user, every mutation audited, RLS tests pass.

## P1 — Sell and stock, offline (8–10 weeks)

- Devices: enrollment, approval, keys, heartbeat, allow/deny.
- Catalog, pricing (tax, discounts, promotions), inventory ledger + batches + FEFO, receiving, adjustments.
- POS app (Expo): sell screen, scan, search, quick keys, cart persistence, park, cash + card (one terminal adapter) + split, receipts (ESC/POS + digital), returns, voids, shifts, drawer, Z-report.
- Offline: local SQLite, signed command outbox, delta pull, conflict policy.
- Desktop (Electron) with USB/network printer, drawer, HID scanner, customer display.
- Console: products, stock, sales list, reports, theme editor, receipt editor, device management.
- Notifications (email via email-kit), low stock alerts, exports.

**Exit:** 3 pilot stores sell for 2 weeks; zero lost sales in forced-offline drills; checkout budgets met on a low-end Android device.

## P2 — Enterprise (10–12 weeks)

- Kafka in production; analytics rollups; MIS reports; EIS board.
- Transfers, purchase orders, suppliers, counts + stock-gap workflow, expiry handling.
- Customers + loyalty + cards; operator points; quotations; orders (pickup/delivery); storefront.
- Multi-currency tender; more payment adapters (QR, online); reconciliation.
- Subscriptions, trials, entitlements, pay-as-you-go.
- Store MCP and platform MCP with snapshots/restore.
- LAN peer sync; integrations (Shopify, WooCommerce, Xero/QuickBooks), webhooks, public API.
- DSS: reorder suggestions, expiry risk, anomaly alerts with ai-core narratives.
- Support tickets.

**Exit:** a 5-branch pilot runs on Growth plan; ASVS L2 review passed; restore drill under RTO.

## P3 — Ecosystem and ERP path

- Extract first service when a trigger fires (likely `reporting/insights` → Python/Django for ML).
- Django tier: AI agents, custom LLM serving, scaled MCPs behind the gateway.
- Restaurant mode, kitchen display.
- White-label builds, Apple/Google Wallet loyalty passes.
- HarmonyOS: React Native for OpenHarmony evaluation, or PWA.
- ERP modules: GL, AP/AR, HR, procurement.

## Risks

| Risk | Mitigation |
|---|---|
| RN hardware library quality varies | Wrap in `@pos/hardware`; Electron for heavy hardware stores; test matrix with real devices |
| Offline sync bugs lose trust | Property-based tests, chaos drills (kill app mid-sale, clock skew, duplicate sends), outbox export fallback |
| Scope creep (huge feature list) | Phase gates; features behind entitlements; ponytail reviews |
| Country tax/fiscal rules | Tax engine data-driven; fiscal adapters per country (P2+) |
| Single-maintainer packages (`@sahan-sac`) | Pin versions, contract tests, upstream PRs, fork path documented |
