# P2-07 · Storefront (online ordering, SEO)

Effort: **M** · Needs: P2-06 · Gate: confirm visual direction
Read: `docs/design/ux.md` (Storefront), `docs/design/theming.md`, `docs/architecture/performance.md` (Caching layers), `docs/architecture/security.md` (cookies: storefront `Lax`)
Libraries: Next.js, Cloudflare cache + tag purge, `@sahan-sac/analytics-kit` (storefront traffic)
Skills: `seo`, `seo-fundamentals`, `geo-fundamentals`, `impeccable`, `high-end-visual-design`, `gsap-greensock` (tasteful, optional), `accessibility-audit`

## Goal
Every tenant gets a fast, branded, findable online store sharing stock and prices with the POS.

## Scope
- `apps/storefront`: tenant by domain/subdomain; home, category, product, search, cart, checkout (hosted payment from P2-08 or pay-at-pickup), order status; customer sign-in (email OTP).
- SEO: SSR/ISR, structured data (`Product`, `Offer`, `LocalBusiness`, `BreadcrumbList`), per-tenant sitemap and robots, canonical URLs, Open Graph images, fast LCP; GEO-friendly content blocks.
- Edge caching with tag purge on `catalog.*`, `pricing.*`, `inventory.balance.*` (coarse availability only).
- Tenant theme tokens applied; custom domain onboarding (DNS instructions + verification).
- analytics-kit beacon for traffic; conversions from orders.

## Delegation
wb-ui-builder (sonnet) pages → wb-builder (sonnet) data layer + cache tags → wb-scaffolder (haiku) sitemap/robots → wb-tester (haiku) Playwright + Lighthouse.

## Acceptance
- Lighthouse mobile: performance ≥ 90, SEO 100, accessibility ≥ 95 on product and category pages; structured data validates.
- Price change visible on storefront within 10 s after publish.

## Review
`ecc:seo-specialist`, `ecc:react-reviewer`, `ecc:a11y-architect`
