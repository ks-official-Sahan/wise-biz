# P2-05 · Customers, loyalty, cards, operator points

Effort: **H** · Needs: P1-16 · Gate: confirm plan
Read: `docs/modules.md` (customers, loyalty), `docs/architecture/security.md` (Data protection), `docs/architecture/offline-sync.md` (Conflict policy: loyalty), `docs/design/theming.md` (Editors: loyalty card)
Libraries: Apple Wallet / Google Wallet pass APIs (evaluate; may defer)
Skills: `domain-modeling`, `ecc:security-review`, `marketing-psychology` (reward design, ethically)

## Goal
Recognise customers at the counter, reward them fairly (offline-capable), and let staff earn opt-in points, all privacy-respecting.

## Scope
- Customers: profile, consents, groups, addresses; phone/email stored encrypted with a hashed lookup (envelope encryption per tenant); export/delete per customer.
- POS: attach by phone, card scan, or QR; quick create; recent customers dataset.
- Loyalty: points ledger (earn rules by spend/category/promo, expiry), tiers, rewards catalog, redemption as a tender; offline redemption cap per offline-sync.md.
- Loyalty cards: designer (templates front/back, fields, QR/barcode), print-ready PDF; wallet passes if feasible.
- Operator points: opt-in, transparent rules (sales, upsell, low void rate), leaderboard per branch, no penalties shown publicly.
- Campaigns v1: segment by RFM + send email via email-kit with consent check.

## Delegation
wb-db (sonnet) encryption + ledger → wb-builder (sonnet) → wb-ui-builder (sonnet) POS + console + card designer → wb-tester (sonnet) ledger properties + offline redemption cap.

## Acceptance
- Points balance always equals ledger sum; offline over-redemption impossible beyond cap; PII never in logs or search index in plaintext.

## Review
`ecc:security-reviewer`, `ecc:database-reviewer`
