# CONTEXT.md

Shared language and current state. If code and this file disagree on a word, fix one of them.

## Current state (2026-10-18)

- Planning phase. No product code yet.
- Reusable base: `@sahan-sac/*` packages from `github.com/ks-official-Sahan/Sahan` (auth-kit, auth-kit-client, ai-core, analytics-kit, media-kit, email-kit, chat-kit, blog-kit). Audit and upgrade plan: `docs/research/sahan-packages.md`.
- Product name not chosen. Scope `@pos/*` is a placeholder.

## Tenancy hierarchy

```
Platform
└── Tenant (a business / brand, the billing account)
    ├── Branch (a store, office, or warehouse; has address, timezone, currency, tax region)
    │   ├── Location (a stock-holding place inside a branch: floor, backroom, shelf zone)
    │   └── Terminal (a registered device that can sell)
    └── Membership (a user's roles in this tenant, optionally narrowed to branches)
```

A **user** is global (one login). A user can hold memberships in several tenants.

## Glossary

| Term | Meaning |
|---|---|
| **Tenant** | Paying customer business. Isolation boundary for data, theme, plan. |
| **Branch** | Physical or logical site. Warehouses are branches with `kind=warehouse`. |
| **Location** | Stock bucket inside a branch. Stock balances are per (SKU, location, batch). |
| **Terminal** | Registered device with its own keypair. Only terminals can create sales. |
| **Device** | Any client install. Becomes a terminal after enrollment and approval. |
| **Operator** | Staff member signed in on a terminal (via PIN or full login). |
| **Shift** | Operator session on a terminal with opening float and closing count. |
| **Drawer session** | Cash drawer lifecycle inside a shift: open, pay-in, pay-out, count, close. |
| **Sale** | A completed checkout document. Immutable after completion. |
| **Cart** | A sale being built. Mutable. Persisted locally as a draft. |
| **Line** | One SKU + quantity + price snapshot + discounts + tax in a cart or sale. |
| **Tender** | One payment applied to a sale (cash, card, QR, credit, voucher, points). |
| **Return** | New document referencing an original sale; never edits the original. |
| **Void** | Cancel a completed sale within policy window; a reversing document, not deletion. |
| **Override** | Action needing higher permission, approved by a supervisor PIN or step-up. |
| **Product** | Merchandising entity. Has one or more **variants**. |
| **SKU / Variant** | Sellable unit with barcode(s), unit, price list entries. |
| **Unit / UoM** | Unit of measure. Conversions per product (box of 12 → each). |
| **Batch / Lot** | Stock received together: cost, optional sale price, expiry, supplier. |
| **FEFO** | First-expired-first-out batch selection. Default for items with expiry. |
| **Stock movement** | Append-only ledger row: +/− quantity at a location, with reason and source document. |
| **Stock balance** | Projection of movements. Never written directly by app code. |
| **Reservation** | Soft hold on stock for an order or layaway. |
| **Stock count** | Physical count session. Variance becomes a gap report. |
| **Stock gap** | Unexplained variance (shrinkage, theft, misplacement, data error). |
| **Price list** | Set of prices per currency, branch, or customer group, with validity window. |
| **Promotion** | Rule-based discount (buy X get Y, % off category, time window). |
| **Tax rule** | Rate + scope (region, category) + inclusive/exclusive flag. |
| **Quotation** | Priced offer with expiry. Converts to order or sale. |
| **Order** | Sale not settled at the counter: online, pickup, delivery, reservation. |
| **Invoice** | Legal sale document with tenant prefix and gapless per-branch number. |
| **Loyalty account** | Points ledger per customer per tenant. |
| **Loyalty card** | Physical or digital card design bound to a loyalty account. |
| **Operator points** | Staff reward ledger (opt-in). Separate from customer loyalty. |
| **Entitlement** | A feature or limit a tenant may use, from plan or pay-as-you-go grant. |
| **Theme** | Design tokens + fonts + assets for a tenant or branch. |
| **Receipt template** | Layout for printed and digital receipts. |
| **Outbox** | Local (device) or server table of events waiting to be delivered. |
| **Command** | Intent sent from device to server during sync (e.g. `CompleteSale`). |
| **Snapshot** | Before-state captured by the platform MCP/console for restore. |
| **Glass-break** | Emergency access path with dual control and loud audit. |
| **Step-up** | Re-authentication (PIN, passkey, OTP) before a sensitive action. |

## Naming rules

- Tables `snake_case` plural; columns `snake_case`; event names `module.entity.past_tense` (`sales.sale.completed`).
- Permissions `module:action[:scope]` (`sales:void`, `inventory:adjust`, `reports:view:branch`).
- Money fields end in `_minor` with a sibling `currency` column.
- Timestamps `*_at` in UTC (`timestamptz`); the branch timezone is used only for display and business-day cutoff.
