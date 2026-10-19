# ADR 0004: PostgreSQL 18, UUIDv7, row-level security

Status: accepted · 2026-10-18

## Decision
- PostgreSQL 18 as system of record (Neon in cloud, self-hosted allowed). Native `uuidv7()` for server defaults; clients generate UUIDv7 offline.
- Shared database, shared schema per module, `tenant_id` on every row, RLS with `app.tenant_id` set per transaction. Large tenants can move to a dedicated database later (routing by tenant in the connection layer).
- Drizzle for typed SQL; Prisma (used in Sahan) not used in the POS API to keep query shape explicit and avoid hidden N+1.

## Consequences
- Time-ordered IDs keep B-tree inserts local and give free time-sorting for keyset pagination.
- RLS is the safety net; application code still filters by tenant.
- auth-kit's Drizzle adapter is the integration path.
