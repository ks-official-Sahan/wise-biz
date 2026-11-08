-- tenancy 0006: put pg_temp last in the pinned search_path of the SECURITY DEFINER trigger (review 2026-11-08).
--
-- Without an explicit pg_temp entry PostgreSQL searches the session's temporary schema FIRST for relations, so a
-- session that creates a temporary table named like one the function reads could make the definer-rights function
-- read or write that table instead of the real one. Listing pg_temp last removes the shadowing (same pin as the
-- audit, inventory and shortlinks definer functions).
ALTER FUNCTION tenancy.bump_permissions_version() SET search_path = pg_catalog, tenancy, pg_temp;
