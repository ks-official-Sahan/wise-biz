-- Top products scans a date range through the primary key (date leads after the tenant); this index served nothing and
-- cost a write on the hottest upsert.
DROP INDEX reporting.rollup_sku_day_variant_idx;
