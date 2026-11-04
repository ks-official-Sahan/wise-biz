-- search: carry catalog's tracksBatches flag so a picker can ask for a lot code or expiry without a second lookup.
-- Existing documents default to false and are corrected the next time catalog re-emits the variant (any product,
-- category or variant change); the server enforces batches on receive regardless, so the flag only improves the form.
ALTER TABLE search.search_documents ADD COLUMN tracks_batches boolean NOT NULL DEFAULT false;
