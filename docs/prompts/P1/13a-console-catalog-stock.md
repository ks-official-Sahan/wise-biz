# P1-13a · Console: catalog and stock

Effort: **M** · Needs: P1-04 (and P0-10) · Gate: none
Read: `docs/design/ux.md` (Management UI), `docs/modules.md` (catalog, pricing, inventory)
Libraries: Next.js, TanStack Query + TanStack Table (or equivalent virtualized table), media-kit upload client
Skills: `impeccable`, `ux-principles`, `ui-design-patterns`, `accessibility-audit`, `vercel-react-best-practices`

## Goal
Owners and inventory clerks manage products, prices, tax, promotions, and stock from the console without training.

## Scope
1. Products list (saved views, columns, filters, search, bulk actions with preview), product editor (variants, barcodes, units, images, category, tags, tax category), barcode generation for items without codes.
2. Import wizard (upload → mapping → validation report → apply) using the P1-02 job.
3. Price lists, tax rules, fees, promotions (draft → publish with impact preview), coupons.
4. Stock: balances by location/batch, receiving (with batch, expiry, cost, optional sale price), adjustments with reason (approval when over threshold), low-stock and expiring lists.
5. Label printing preview (PDF A4 sheets + ZPL export) for batches after receiving.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/catalog/**` | Items 1–2, 5 |
| 2 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/pricing/**` | Item 3 |
| 3 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/stock/**` | Item 4 |
| 4 | wb-tester (haiku) | `apps/console/e2e/catalog-stock/**` | Flows: create product → price → receive → adjust → low stock shows |

## Acceptance
- Playwright flows pass; Lighthouse a11y ≥ 95 on list and editor pages.
- Lists with 100k products stay responsive (virtualized, server-paginated; no client load of all rows).
- Every write shows a change summary on critical fields (price, tax) before save.

## Review
`ecc:react-reviewer`, `ecc:a11y-architect`
