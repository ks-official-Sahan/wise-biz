# 0010 Tenancy store and auth engine

Status: accepted (2026-10-21, P0-08)

## Context

P0-08 needs identity (users, sessions, passwords, later passkeys and MFA) and tenancy (tenants, branches, locations,
memberships narrowed to branches, tenant roles, settings). Two questions:

1. Store tenancy in Better Auth's `organization` plugin, or in our own `tenancy` module?
2. Use the Better Auth engine from `@sahan-sac/auth-kit` 0.12.1, or `better-auth` directly?

Constraints: UUIDv7 IDs everywhere, `tenant_id` + RLS on every tenant table, modules extractable as services,
contract-portable to Django, RBAC + ABAC through `@wise-biz/policy` (branch scope, conditions, offline snapshots).

A four-voice council (architect, skeptic, pragmatist, critic) reached the same answer on both questions independently.

## Decision

1. **Better Auth for identity only; tenancy in our own `tenancy` module.** The organization plugin is not used.
   - Flat organizations, no branches, its own role vocabulary: running it beside `@wise-biz/policy` gives two sources
     of truth for authorization, and the first drift between them is an authorization bug.
   - Our tables follow the `(tenant_id, id)` + RLS pattern, so they stay portable and extractable.
2. **`better-auth` (MIT) used directly, behind a thin identity port.** We do not use auth-kit's engine for now:
   - its schema hardcodes `crypto.randomUUID()` (v4) with no ID generator injection (breaks the UUIDv7 rule);
   - its rate limiter supports only `@upstash/redis` (we run node-redis against self-hosted Redis);
   - its peer dependencies list `next`, `react` and `next-auth` (unwanted in a Hono API).
   `better-auth` accepts `advanced.database.generateId`, so every identity row gets a UUIDv7.
   Small, framework-free auth-kit helpers (password policy, origin check, invite tokens) are imported by subpath when
   that pulls in no unwanted peers; otherwise they are ported with attribution.

## Consequences

- **Identity tables are global, not tenant-scoped.** The session is resolved before any tenant is known, so
  `identity.*` cannot use tenant RLS. Instead the schema is granted only to a dedicated role `wb_identity`; `wb_app`
  and `wb_worker` have no privileges on it. `rls-check` treats schemas listed as global in `modules/registry.json`
  by asserting exactly that (no `wb_app`/`wb_worker` privileges) instead of requiring RLS.
- **Tenant context comes only from our code.** The active tenant is stored on the identity session row
  (`active_tenant_id`) and written only by the switch-tenant flow after an active membership is verified. It is
  re-checked against `tenancy.memberships` on every request (fail closed). Never taken from a header or body.
- **Sign-up is two steps across modules:** create the account (identity), then create the business (tenancy, one
  transaction: tenant, roles, branch, default location, owner membership, audit, outbox). A cross-module transaction
  would break extractability; an account without a business is a valid state and can create one later.
- **Permission changes take effect on the next request:** a trigger bumps `tenancy.tenants.permissions_version` on
  any role, grant or membership-role change; the policy matrix is cached in Redis under `t:{tenant}:perm:v{n}`.
- **We own the hard flows** (invite, accept, last-owner protection, tenant switch). They get the most tests (P0-08b).
- **Divergence from auth-kit is temporary and tracked.** P0-11 upstreams to auth-kit: ID generator injection, a
  node-redis rate-limit backend, optional framework peers. After that, swapping the engine is a change behind the
  identity port only.
- Passkeys are bound to one RP ID (domain). Per-tenant custom domains later need a passkey strategy (follow-up).
