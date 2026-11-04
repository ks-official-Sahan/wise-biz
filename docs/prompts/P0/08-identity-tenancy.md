# P0-08 · Identity + tenancy

Effort: **H** · Needs: P0-07 · Gate: confirm plan + decision (ADR 0009)
Read: `CONTEXT.md` (Tenancy hierarchy), `docs/architecture/security.md` (Identity and sessions, Authorization, Web security), `docs/research/sahan-packages.md`, `docs/modules.md` (identity, tenancy)
Libraries: `@sahan-sac/auth-kit` (Better Auth engine, Hono helpers, security/*, cache/ratelimit), `@sahan-sac/auth-kit-client`, Better Auth (core, passkey, organization plugin — evaluate only)
Skills: `ecc:security-review`, `ecc:api-design`, `domain-modeling`

## Goal
People can sign up, create a business with its first branch, invite staff with roles scoped to branches, sign in securely, and switch tenants, with every request carrying a verified tenant context.

## Decision first (gate)
ADR 0009 "Tenancy store": Better Auth organization plugin vs own `tenancy` tables. Default recommendation: **Better Auth for identity only** (users, sessions, passkeys, MFA via auth-kit) and **own tenancy tables** (needs branches, ABAC, RLS, Django portability). Present trade-offs in ≤ 15 lines and wait.

## Scope
1. `modules/identity`: wire auth-kit Better Auth engine into Hono; email+password (auth-kit password policy), passkeys, emailed OTP MFA, sessions table; cookie settings per security.md (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict` for console audience); rate limits on auth routes (fail closed when Redis is down).
2. `modules/tenancy`: `tenants`, `branches` (timezone, currency, tax region, business-day cutoff, kind store|warehouse|office), `locations`, `memberships` (user, tenant, roles, branch scope), `roles`, `role_permissions`, `settings` (typed key-value with schema per key). All RLS.
3. Use cases: `signUpBusiness` (user + tenant + branch + default location + owner membership in one tx), `inviteMember` (email via `@sahan-sac/email-kit`, invite token from auth-kit), `acceptInvite`, `updateMemberRoles`, `createRole`, `setRolePermissions`, `switchTenant`.
4. Auth context middleware: session → `{ userId, tenantId, membership, permissionsVersion }`; permission matrix from `@wise-biz/policy`, cached in Redis with versioned keys (`t:{tenant}:perm:v{n}`); version bump on any role change.
5. `authorize(permission, resource?)` in `runCommand`; unauthorized admin/platform routes return 404.
6. Origin/CSRF check on unsafe methods (auth-kit `security/check-origin`), machine paths excluded.
7. Seed script: demo tenant with 2 branches and one user per system role.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | auth-kit Better Auth engine + Hono helpers usage from its README/source; Better Auth passkey + session config |
| 2 | wb-db (sonnet) | `modules/{identity,tenancy}/migrations/**` | Tables, RLS, indexes |
| 3 | wb-builder (sonnet) | `modules/identity/src/**` | Item 1 |
| 4 | wb-builder (sonnet) | `modules/tenancy/src/**`, `apps/api/src/kernel/auth/**` | Items 2–6 |
| 5 | wb-tester (haiku) | tests + `scripts/seed-demo.mts` | Acceptance + item 7 |

## Acceptance
- API e2e: sign up → invite → accept → login (password + passkey in a virtual authenticator test if feasible) → switch tenant.
- Cross-tenant and out-of-branch access → 404; removing a permission takes effect on the next request.
- Auth routes rate-limited; Redis down → login refused (fail closed), reads still work.
- Cookies have the expected attributes (assert headers).
- `ecc:security-reviewer` reports no CRITICAL/HIGH.

## Review
`ecc:security-reviewer`, `ecc:database-reviewer`, `ecc:typescript-reviewer`
