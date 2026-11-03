-- Workers resolve "who should be told" (notifications) from roles. Read-only, and RLS still scopes every row to the
-- tenant the event bus sets.
GRANT USAGE ON SCHEMA tenancy TO wb_worker;
GRANT SELECT ON tenancy.memberships, tenancy.membership_roles, tenancy.roles, tenancy.role_permissions TO wb_worker;
-- Branch-restricted members are told only about their own branches, so the worker maps a location to its branch.
GRANT SELECT ON tenancy.locations TO wb_worker;
