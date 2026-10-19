# P2-13 · Integrations, webhooks, public API

Effort: **M** · Needs: P2-01 · Gate: pick first two integrations with me
Read: `docs/architecture/api-conventions.md` (Webhooks out, Rate limits), `docs/modules.md` (integrations), `docs/architecture/security.md` (SSRF)
Libraries: Shopify Admin API, WooCommerce REST, Xero / QuickBooks APIs (OAuth), outbound webhook signing
Skills: `ecc:api-connector-builder`, `ecc:api-design`, `ecc:security-review`

## Goal
wise-biz plays well with the tools stores already use, through verified connectors and a clean public API.

## Scope
- Public API keys (hashed, scoped, rotatable, per-key rate limits), OpenAPI docs page.
- Outbound webhooks: endpoints per tenant, event selection, HMAC signing with timestamp, retries 24 h, delivery log + replay, SSRF allowlist (block private ranges).
- Connector framework: OAuth connection store (encrypted tokens), sync jobs, mapping UI, conflict rules, health status.
- First connectors: one e-commerce (Shopify or WooCommerce: products, stock levels, orders) and one accounting (Xero or QuickBooks: daily sales journal, payments, tax).

## Delegation
wb-builder (sonnet) API keys + webhooks → wb-builder (sonnet) one agent per connector (worktrees) → wb-ui-builder (sonnet) integrations pages → wb-tester (haiku) contract tests with recorded fixtures.

## Acceptance
- Webhook signatures verify with documented recipe; replay works; private-IP endpoints rejected.
- Connector round trip in sandbox accounts with no duplicate orders or stock drift.

## Review
`ecc:security-reviewer`, `ecc:typescript-reviewer`
