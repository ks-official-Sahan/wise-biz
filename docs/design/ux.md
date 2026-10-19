# UX and UI

Principle: **hide the complexity, keep the power.** Simple defaults; advanced controls behind progressive disclosure, permissions, and settings.

## Design direction

- Calm, high-contrast, content-first. Brand color shows in accents, not in data surfaces.
- Light and dark themes; each store chooses its default.
- Type scale tuned for reading at the counter: base 16 px, totals 32–48 px, tabular numerals for money.
- Motion only as state feedback (line added, payment success) ≤ 200 ms; none decorative on the checkout path.
- Icons: one set (Tabler, already used in Sahan) plus text labels on primary actions.
- WCAG 2.2 AA: contrast enforced by the theme validator, visible focus, targets ≥ 24 px CSS (≥ 48 dp touch), labels for screen readers, never color-only status.

## Layouts by device class

| Class | Width | Checkout layout |
|---|---|---|
| Phone | < 600 | Single column: scan/search bar top, cart list, sticky pay bar bottom; product grid as a sheet |
| Tablet portrait | 600–900 | Cart top 40%, grid or keypad bottom |
| Tablet landscape / small desktop | 900–1280 | Two panes: grid and search left (60%), cart + totals + pay right (40%) |
| Desktop / terminal | ≥ 1280 | Two panes + optional third (customer, suggestions); keyboard first |
| Customer display | any | Cart mirror, total, change, QR receipt, loyalty prompt |

Left-handed mode mirrors the panes. Layout presets are editable per terminal (quick-key grid, favorites, category tabs).

## Checkout flow (target: 10 items ≤ 30 s)

```
[Scan / Search / Quick key] → line added (sound + highlight, same SKU merges qty)
   ↻ repeat
[Customer?] optional: F4 or scan loyalty card
[Pay] F9 → tender sheet with suggested amounts (exact, next notes) → cash entered → change shown large
[Done] receipt prints automatically (or QR/email by customer preference) → new cart focused
```

Rules:
- Focus always returns to the scan field. The scanner works anywhere on the sell screen.
- No modals on normal paths; sheets with shortcuts; `Esc` goes back one step.
- Undo the last line within 5 s without permission. After that, removing or reducing a line needs `sales:edit_line` or a supervisor PIN.
- Errors are inline and actionable ("Barcode not found → Add quick item / Search").
- Instant feedback: optimistic local state; a sync chip shows online, offline with N queued, or syncing.
- Park a sale with one key; parked list shows age and operator.

## Management UI (console)

- Home: today vs same day last week, live sales ticker, low stock, expiring batches, terminals online, pending approvals.
- Lists: saved views, column choice, bulk actions with preview, keyboard navigation.
- Forms: autosaved drafts, inline validation, change summary before saving critical data (prices, tax).
- Dashboards: KPI tile → trend → drill-down to rows. Charts follow the `dataviz` skill rules.
- Approvals inbox: overrides, large stock adjustments, price changes needing approval, device enrollments.
- Badges, tags, bubbles: counts on nav items (approvals, low stock), status chips (synced, offline, expired), tags on products and customers.
- Command palette across the console.

## Storefront

Mobile-first and SEO-first: SSR, structured data (`Product`, `Offer`, `LocalBusiness`), per-tenant sitemap, canonical URLs, fast LCP, stock-aware add-to-cart, pickup or delivery, hosted checkout. Themed by the tenant's tokens.

## Research and validation

- Usability test each phase with 5 cashiers and 3 owners across store types (grocery, pharmacy, apparel, restaurant).
- Time-on-task for: 10-item sale, return with receipt, price check, shift close, receiving a delivery, stock count.
- In-app measures: steps per sale, errors per 100 sales, override frequency, search-vs-scan ratio.

## Patterns worth adopting

- Command palettes and keyboard-first flows on desktop terminals.
- Dual-screen Android POS hardware (operator + customer screen) as a first-class target.
- AI as in-context suggestions (reorder, upsell, explain an anomaly), never a chat that blocks work.
- Token-based theming (W3C DTCG format) to brand without forking UI.
- Glanceable status chips over dialogs; toasts only for background events.
