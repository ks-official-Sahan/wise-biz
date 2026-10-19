# P1-02 · Catalog, search, import

Effort: **M** · Needs: P0-12 · Gate: none
Read: `docs/modules.md` (catalog, search, media), `docs/architecture/data-model.md` (Principles, Index rules), `docs/adr/0007-hybrid-search-postgres.md`, `docs/features/payments-hardware.md` (Barcodes)
Libraries: Drizzle, Postgres FTS + `pg_trgm`, `@sahan-sac/media-kit`, CSV/XLSX streaming parser (pick a small, maintained one)
Skills: `ecc:postgres-patterns`, `ecc:api-design`, `ecc:data-throughput-accelerator`

## Goal
Products the POS can sell: variants with barcodes and units, organised into categories and tags, with images, fast hybrid search, and bulk import that tells the user exactly what failed.

## Scope
1. `modules/catalog` tables: `products`, `variants` (sku, name, unit, tracks_batches, tax_category, attributes jsonb), `barcodes` (unique per tenant), `units` + `unit_conversions`, `categories` (tree via `ltree` path or adjacency + path column — choose, justify in PR), `tags` + join, `product_media`.
2. Endpoints: CRUD with `runCommand`; list with keyset pagination, filters (category, tag, archived, updated since), `?include=variants,barcodes,media` with one query per relation.
3. Barcode lookup endpoint (exact, indexed) for online lookups; archived variants excluded.
4. Media via media-kit with tenant prefix (P0-11 option), signed uploads, derived thumbnail sizes for POS caching.
5. **Search projection** (`modules/search`): consumer on `catalog.*` events maintains `search_documents` (tsvector with tenant language, trigram on name/sku, vector column nullable for P2); query fuses FTS + trigram with reciprocal rank fusion; p95 < 150 ms on 100k variants.
6. **Import**: upload CSV/XLSX → job (worker) → streaming parse → batch validate (references resolved with `= any($1)`) → upsert in batches of 500 inside transactions → result report (row, column, error) downloadable; idempotent by file hash.
7. Events `catalog.product.upserted`, `catalog.variant.upserted`, `catalog.variant.archived`, `catalog.barcode.changed`.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/{catalog,search}/migrations/**` | Tables, RLS, indexes, search SQL with EXPLAIN |
| 2 | wb-builder (sonnet) | `modules/catalog/src/**` | Items 2–4, 7 |
| 3 | wb-builder (sonnet) | `modules/search/src/**` | Item 5 |
| 4 | wb-builder (sonnet) | `modules/catalog/src/import/**`, worker job | Item 6 |
| 5 | wb-tester (haiku) | tests + `scripts/seed-catalog.ts` (100k variants) | Acceptance |

## Acceptance
- List with all includes on 50 products = 4 queries (query counter).
- Duplicate barcode in tenant rejected; same barcode in other tenant allowed.
- Search: typo "cocacola 1.5" finds "Coca-Cola 1.5L"; p95 < 150 ms on 100k seeded variants (EXPLAIN attached).
- Import of 10k rows with 37 bad rows: 9,963 upserted, report lists all 37; re-upload is a no-op.

## Review
`ecc:database-reviewer`, `ecc:typescript-reviewer`
