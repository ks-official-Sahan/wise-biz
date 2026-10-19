# P1-13c · Console: theme, receipt, and letterhead editors

Effort: **M** · Needs: P1-10 (and P0-09, P0-10) · Gate: none
Read: `docs/design/theming.md` (all), `docs/features/payments-hardware.md` (Receipts and documents)
Libraries: `@wise-biz/theme`, `@wise-biz/receipt`, media-kit upload client, a PDF renderer for A4 (pick one that runs server-side)
Skills: `impeccable`, `emil-design-eng`, `brand-consistency`, `accessibility-audit`

## Goal
A store owner makes wise-biz look like their brand in minutes and sees exactly how the POS, receipt, and documents will look before publishing.

## Scope
1. `modules/theming` server: `themes` (versioned, draft/published), `fonts` (curated list + upload with license confirmation), `receipt_templates`, `letterheads`; publish emits `theming.theme.published` (sync feed picks it up).
2. Theme editor: brand color(s), fonts, radius, density, logo light/dark; live side-by-side preview (POS sell screen mock, receipt, storefront card, loyalty card placeholder); contrast warnings with one-click fix; version history + rollback.
3. Receipt editor: block list (drag to reorder), per-branch overrides, preview at 58/80 mm and A4 using real sample data; custom invoice prefix settings.
4. Letterhead: upload PDF/PNG/SVG or build header/footer blocks; used for A4 invoices and quotations (PDF generation endpoint).

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/theming/migrations/**` | Tables, RLS |
| 2 | wb-builder (sonnet) | `modules/theming/src/**`, PDF endpoint | Server + publish |
| 3 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/branding/**` | Items 2–4 UI |
| 4 | wb-tester (haiku) | e2e | Change brand → publish → POS picks it up after sync without restart |

## Acceptance
- Published theme reaches a running POS within one realtime hint + pull (< 5 s locally).
- A low-contrast brand color is blocked from publish until fixed or adjusted.
- Receipt preview bytes equal the POS print bytes for the same template and sale.

## Review
`ecc:react-reviewer`, `ecc:a11y-architect`, `ecc:security-reviewer` (uploads)
