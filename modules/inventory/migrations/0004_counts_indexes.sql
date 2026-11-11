-- Stock counts indexes (review follow-up to 0003). Plain CREATE INDEX: stock_movements is partitioned, and
-- CREATE INDEX CONCURRENTLY is not supported on partitioned parents.

-- Cycle-scope lookup by category (counts.ts variant_facts.category_ids && $n). A GIN over uuid[] cannot lead with
-- tenant_id without btree_gin, so this index is tenant-agnostic; the tenant predicate filters the matched rows
-- (same exception as catalog.categories_path_gin).
CREATE INDEX variant_facts_category_gin ON inventory.variant_facts USING gin (category_ids);

-- Receipt-cost fallback across locations (counts.ts: latest receipt receive per variant, no location predicate).
-- The 0001 receive index puts location_id before occurred_at, so an ordered probe without a location cannot use it.
CREATE INDEX stock_movements_receipt_cost_idx ON inventory.stock_movements (tenant_id, variant_id, occurred_at DESC, id DESC)
  WHERE reason = 'receive' AND source_type = 'receipt';
