-- The hourly sales rollup needs the branch's time zone; the event bus scopes the tenant, so this stays read-only and per business.
GRANT SELECT ON tenancy.branches TO wb_worker;
