# PRODUCT.md

## One line

A universal POS platform any store can brand as its own: checkout that never waits, inventory that never lies, and management that hides its own complexity.

Product: **wise-biz**. Package scope `@wise-biz/*`.

## Problems we solve

Research detail: `docs/research/pos-market.md`.

| Pain in today's POS products | Our answer |
|---|---|
| Offline mode is an afterthought: terminals stop syncing with each other, gift cards and loyalty stop working, data can be lost if the app is cleared | Local-first terminals with a durable signed outbox, LAN peer sync between terminals in a store, cached loyalty balances with capped offline redemption |
| Stock drifts across in-store, online, and delivery channels | One stock ledger per location, every channel writes movements into it, reservations for online orders |
| Too many devices and apps on the counter | One app per device class, hardware through a single bridge, customer display built in |
| Generic look; every store's POS looks like the vendor's | Per-store design tokens, fonts, receipts, loyalty cards, letterheads |
| Edits after a sale are invisible | Every change is a signed, hash-chained, audited event. Line edits after add need permission or a manager PIN |
| Hidden fees, rigid plans | Plans by entitlements and limits, trials, pay-as-you-go for chosen stores |
| Reports show what happened, not what to do | DSS layer: reorder suggestions, expiry risk, stock-gap detection, anomaly alerts, an MCP assistant |

## Users

| Persona | Device | Needs |
|---|---|---|
| Cashier / operator | Registered terminal, tablet, phone | Speed, big targets, keyboard and scanner first, no dead ends |
| Supervisor / shift lead | Terminal + phone | Approve overrides by PIN, open and close shifts, cash counts |
| Store owner / manager | Phone, laptop | Live sales, stock, staff, approvals, reports, branding, store MCP |
| Inventory clerk | Phone with camera, handheld scanner | Receiving, counts, transfers, expiry checks |
| Accountant | Laptop | Exports, tax reports, reconciliations |
| End customer | Storefront, receipt, loyalty card | Fast checkout, digital receipt, points, online ordering |
| Platform admin (us) | Console + platform MCP | Tenants, plans, support, incidents, restores |

## Product surfaces

| Surface | Tech | Platforms |
|---|---|---|
| POS terminal app | Expo (React Native) | Android, iOS, iPadOS, Web |
| Desktop POS | Electron shell around the POS web build + hardware bridge | Windows, macOS, Linux |
| Console (owner + platform admin) | Next.js | Web, responsive |
| Storefront (online ordering) | Next.js | Web, SEO-first |
| Store MCP | MCP server, OAuth 2.1 | Any MCP client |
| Platform MCP | MCP server, hardened | Platform staff only |

HarmonyOS: phase 3 via React Native for OpenHarmony or the PWA. See `docs/ROADMAP.md`.

## Feature catalog

Phase tags: **P1** MVP (sell + stock + offline), **P2** enterprise, **P3** ecosystem / ERP path. Module owners: `docs/modules.md`.

### Selling (TPS core)
- P1 Scan, search, quick keys, favorites grid, numeric keypad, quantity and weight entry
- P1 Cart persistence (draft survives crash or restart, TTL and guard rules)
- P1 Park and resume sales, multiple open carts per terminal
- P1 Discounts: line, cart, coupon, automatic promotions (rule engine)
- P1 Tax: inclusive or exclusive, multi-rate, per-category, per-region
- P1 Fees and service charges
- P1 Split tender: cash, card (terminal), QR, store credit, voucher
- P1 Receipts: print, email, SMS link, QR to digital receipt
- P1 Returns and exchanges with original-sale lookup, refund to tender
- P1 Line edit after add needs permission or manager PIN; post-sale edits only via return or void flow, always audited
- P2 Quotations → convert to sale or order
- P2 Reservations, layaway, deposits
- P2 Orders: pickup, delivery, online (from storefront)
- P2 Multi-currency tender with conversion and rate snapshot
- P2 Custom barcode products (weighed or priced labels, EAN-13 prefix 2x)
- P3 Restaurant mode: tables, courses, kitchen display

### Inventory
- P1 Products, variants, units and conversions, categories, tags, images
- P1 Batches/lots: cost, price, expiry; FEFO selection
- P1 Stock ledger per location; low-stock alerts
- P1 Receiving (with or without PO), adjustments with reason codes
- P2 Purchase orders, suppliers, stock refill suggestions
- P2 Transfers between branches and warehouses
- P2 Cycle counts and full counts → stock-gap report (shrinkage, theft, misplacement) with manual reconciliation workflow
- P2 Expired and near-expiry stock handling (markdown, write-off)
- P2 Barcode label printing and custom barcode generation

### People
- P1 Staff, roles, permissions per tenant/branch, quick PIN on registered devices
- P1 Shifts, cash drawer open/close, blind cash count, over/short
- P2 Operator points and leaderboards (opt-in, fair rules)
- P2 Commissions, time clock

### Customers (CRM)
- P1 Customer profiles, purchase history
- P2 Loyalty points, tiers, rewards, loyalty cards (designs and templates)
- P2 Segments, campaigns (email via `@sahan-sac/email-kit`), feedback, automated ratings
- P3 Collaborative CRM: shared notes, tasks, support tickets

### Management (MIS / DSS / EIS)
- P1 Live dashboard: sales, top items, low stock, terminals online
- P1 Reports: sales, tax, payments, Z-report per shift, exports CSV/XLSX/PDF
- P2 Analytics: margins, cohorts, basket analysis, staff performance
- P2 DSS: reorder points, demand forecast, expiry risk, price suggestions, anomaly alerts
- P2 EIS: multi-branch KPI board for owners and groups
- P2 Store MCP: query, report, controlled actions

### Platform
- P1 Multi-tenant, multi-branch, multi-terminal
- P1 Device registration, whitelist and blacklist, device health
- P1 Branding: theme tokens, fonts, logo, receipt templates
- P1 Audit log (hash-chained), backups
- P2 Subscriptions, trials, entitlements, pay-as-you-go metering
- P2 Integrations: accounting (Xero, QuickBooks), e-commerce (Shopify, WooCommerce), webhooks, public API
- P2 Notifications, support tickets
- P2 Platform MCP with snapshots and restore
- P3 Django service tier, custom LLMs, ERP modules (HR, manufacturing, finance GL)

## Plans (draft)

Detail: `docs/features/subscriptions.md`.

| Plan | For | Key limits |
|---|---|---|
| Trial (14–30 days) | New tenants | Full P1, 1 branch, 2 terminals |
| Starter | Single shop | 1 branch, 2 terminals, basic reports |
| Growth | Multi-branch | 5 branches, 20 terminals, loyalty, analytics, storefront |
| Enterprise | Chains | Unlimited by contract, SSO, MCP, integrations, SLA |
| Pay-as-you-go | Selected tenants only | Per-feature toggles, metered by transactions/terminals |

## Success metrics

| Metric | Target |
|---|---|
| Scan to line visible | p95 ≤ 50 ms (local) |
| Cash sale complete (tender to receipt start) | p95 ≤ 300 ms |
| Time per average 10-item checkout (operator) | ≤ 30 s |
| Offline sale loss | 0 |
| Sync lag after reconnect | p95 ≤ 10 s for 1k queued sales |
| Stock accuracy after count | ≥ 99% |
| New store first sale | ≤ 15 min from signup |

## Out of scope (for now)

Card-present EMV processing in our code (we use certified terminals, semi-integrated), payroll, full general ledger (P3), building our own payment gateway.
