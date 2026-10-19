# POS market research (Oct 2026)

Scope: what current POS products get wrong, and where a universal, brandable, offline-first POS can win. Sources at the end. Re-run before each phase; findings marked *(read)* came from pages read in full, the rest are our position plus further reading.

## Findings

### 1. Offline mode is shallow in leading products *(read)*
- Toast's docs: devices switch to offline mode about 40 s after losing connectivity. Cash and card still work, but gift cards, loyalty redemption, customer credits, house accounts, and text-to-pay become unavailable.
- Offline Toast terminals **cannot sync with each other**, so orders on one device do not appear on others; Toast advises one employee per device.
- Offline payments can be lost; reinstalling the app or clearing device memory permanently deletes stored data and payments.
- Shopify's community has merchants asking how to handle orders during outages.

**Opportunity:** signed durable outbox, LAN peer sync between terminals, capped offline loyalty and credit, uninstall guard with unsynced-count warning, encrypted outbox export. (`docs/architecture/offline-sync.md`)

### 2. Legacy systems block omnichannel; replacement feels too costly *(read, older study)*
- An RSR Research survey of 88 retailers (reported by Digital Transactions; the study is from 2015, so treat it as long-standing context) found 77% said legacy POS prevented a consistent cross-channel experience, and 68% said replacement would be too expensive and disruptive. Large chains run many peripheral types per lane, which raises switching cost.

**Opportunity:** one stock ledger for all channels, broad hardware abstraction, import tools (CSV/XLSX, Shopify/WooCommerce connectors), gradual rollout per branch.

### 3. Counter clutter and fragmented tools *(read, vendor marketing)*
- A POS vendor's own pitch implies the common complaints: separate hardware and software per function, unrecognized customers, channels out of sync, painful payment reconciliation, hidden fees.

**Opportunity:** one app per device class, built-in customer display, CRM at the counter, daily settlement reconciliation, transparent plans with entitlements.

### 4. Checkout speed is the customer-facing quality bar *(our position)*
Queue time is what customers feel. We treat it as a hard engineering budget, not a design wish.

**Opportunity:** latency budgets with no network on the hot path, keyboard-first desktop, quick keys, merge-by-SKU, auto-print. (`docs/architecture/performance.md`)

### 5. Payments: keep card data out of scope *(our position, standard practice)*
Semi-integrated terminals keep card data inside the certified terminal; hosted fields and tokens do the same online. This keeps PCI scope small.

**Opportunity:** adapter-based payments with semi-integrated terminals and hosted fields only. (`docs/features/payments-hardware.md`)

### 6. Sync engines are in flux *(read)*
- PowerSync syncs Postgres into client SQLite with an upload queue and server-authoritative conflict resolution, with React Native and web SDKs.
- The same comparison article notes Electric Cloud has shut down, and electric-next was read-path only at the time.
- Expo docs: expo-sqlite on web needs COOP/COEP headers, and `withExclusiveTransactionAsync` is not supported on web.

**Decision:** own the write path (signed commands), keep the read path a simple delta feed, revisit PowerSync for reads if needed. (`docs/adr/0003-custom-sync.md`)

## Gaps we target (differentiators)

| Gap | Our feature |
|---|---|
| Edits invisible after sale | Hash-chained, device-signed documents + approvals inbox |
| Stock shrinkage hard to find | Stock-gap workflow: count → variance → investigation tasks → resolution codes; correlated with voids, refunds, operators |
| Batches with different prices and expiry rarely first-class | Batch-level price, FEFO, expiry alerts, markdown suggestions |
| Vendor-branded UI | Full tenant theming, receipts, cards, letterheads |
| Owners want answers, not reports | DSS suggestions + store MCP for natural-language queries with permission checks |
| Rigid plans | Entitlements + pay-as-you-go for selected tenants |
| Local payment methods ignored | Country QR adapters (e.g. LankaQR) as plugins |

## Competitive set to benchmark (hands-on before P1 UI freeze)

Square, Shopify POS, Toast, Lightspeed (Retail/Restaurant), Clover, Loyverse, Odoo POS, regional players. Measure time-to-first-sale, 10-item checkout time, offline behavior, return flow, stock count flow, theming depth, report usefulness.

## Sources

Read in full:
- [Toast: Offline payments overview](https://doc.toasttab.com/doc/platformguide/platformOfflinePaymentsOverview.html)
- [Digital Transactions: retailers and POS system upgrades](https://www.digitaltransactions.net/no-easy-answers-for-retailers-as-they-grapple-with-pos-system-upgrades/)
- [Qashier: why retailers are not satisfied with their POS](https://qashier.com/sg/?p=11916)
- [PowerSync: ElectricSQL vs PowerSync](https://powersync.com/blog/electricsql-electric-next-vs-powersync)
- [Expo: expo-sqlite README (SDK 56)](https://github.com/expo/expo/blob/sdk-56/packages/expo-sqlite/README.md)

Further reading (not yet reviewed in depth):
- [Shopify Community: offline POS orders during outages](https://community.shopify.com/t/how-do-you-handle-offline-pos-orders-during-internet-outages/203388)
- [Snabble: efficient UX design for modern POS systems](https://snabble.io/en/latest/efficient-ux-design-for-modern-pos-systems)
- [FTx: ways to improve checkout speed with a POS](https://goftx.com/blog/pos-transaction-speed-importance)
- [North: integrated vs semi-integrated payments](https://www.north.com/blog/integrated-vs-semi-integrated-whats-the-difference)
- [Expo + Electron adapter](https://github.com/expo/expo-electron-adapter)
