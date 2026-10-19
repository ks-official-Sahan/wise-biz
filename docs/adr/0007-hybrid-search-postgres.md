# ADR 0007: Hybrid search in Postgres

Status: accepted · 2026-10-18

## Decision
`search_documents` projection per tenant with: `tsvector` (FTS, language per tenant), `pg_trgm` (typos, partial SKUs), `pgvector` embedding (semantic, via ai-core embeddings, P2). Query runs the three and fuses with reciprocal rank fusion. Barcode lookups bypass search (exact unique index). On device: SQLite FTS5 + in-memory barcode map.

## Consequences
No separate search cluster at launch. Move to OpenSearch/Typesense only if p95 > 150 ms at scale or features (facets at very large catalogs) demand it.
