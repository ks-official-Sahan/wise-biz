# P2 — Enterprise

Shorter step files: the P0–P1 patterns (modules, `runCommand`, sync datasets, console screens, tests) already exist, so the orchestrator expands each step during planning. Every step still runs with `/wb-step`.

Before starting P2: re-read `docs/reports/P1-gate.md` and pilot feedback. Reorder steps by what pilots need most and record the change in PROGRESS.md.

| Step | Title | Effort | Needs | Track |
|---|---|---|---|---|
| [P2-01](01-kafka.md) | Kafka in production | H | P1-16 | A |
| [P2-02](02-analytics-eis.md) | Analytics, MIS expansion, EIS board | M | P2-01 | A |
| [P2-03](03-procurement-transfers.md) | Suppliers, POs, transfers | M | P1-16 | B |
| [P2-04](04-counts-stock-gap.md) | Stock counts, stock-gap workflow, expiry handling | H | P2-03 | B |
| [P2-05](05-customers-loyalty.md) | Customers, loyalty, cards, operator points | H | P1-16 | C |
| [P2-06](06-quotes-orders.md) | Quotations, orders, reservations, layaway | M | P2-05 | C |
| [P2-07](07-storefront.md) | Storefront (online ordering, SEO) | M | P2-06 | C |
| [P2-08](08-payments-expansion.md) | QR/online payments, multi-currency, reconciliation | H | P2-06 | A |
| [P2-09](09-billing-entitlements.md) | Plans, trials, entitlements, pay-as-you-go | H | P1-16 | B |
| [P2-10](10-store-mcp.md) | Store MCP | H | P2-09 | A |
| [P2-11](11-platform-mcp.md) | Platform MCP, snapshots, restore, glass-break | H | P2-10 | A |
| [P2-12](12-lan-peer-sync.md) | LAN peer sync between terminals | H | P1-16 | B |
| [P2-13](13-integrations.md) | Integrations, webhooks, public API | M | P2-01 | C |
| [P2-14](14-insights-dss.md) | DSS insights + AI narratives | H | P2-02, P2-04 | A |
| [P2-15](15-support.md) | Support tickets + announcements | M | P1-16 | C |
| [P2-16](16-gate.md) | P2 gate | H | all P2 | — |
