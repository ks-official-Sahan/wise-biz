# @wise-biz/policy

Pure RBAC + ABAC decisions and signed policy snapshots for offline devices. Universal runtime (no Node built-ins). Time is an input (`ctx.now`, `ctx.localMinuteOfDay`), never read from a clock.

## Model

- `Permission`: `module:action[:scope]`. Built with `definePermissions(module, actions)` and merged with `createCatalog(...)` (rejects bad format and duplicates). Module `platform` is platform-only: never grantable to tenant roles, never decidable in a tenant.
- Roles: `SYSTEM_ROLES` (`owner`, `manager`, `supervisor`, `cashier`, `inventory_clerk`, `accountant`) plus custom tenant roles (`^[a-z][a-z0-9_]*$`, not `platform_admin`).
- `PolicyMatrix = Record<role, Grant[]>`, `Grant = { permission, conditions? }`. `matrixFromRows(catalog, rows)` skips unknown roles/permissions and malformed conditions; owner is fixed to every non-platform permission, unconditional. `toAuthKitMatrix(m)` gives auth-kit's `Record<role, ReadonlySet<permission>>`.
- Conditions (data): `maxAmountMinor`, `maxDiscountBps`, `timeWindow` (branch-local minutes, end exclusive, may cross midnight; `days` = day the window starts on), `deviceClass`, `requiresOpenShift`. A condition whose input is missing fails closed. Limits compare magnitude (`Math.abs`), so refunds/negative amounts cannot bypass them. Unknown keys in conditions are rejected.

## decide(matrix, ctx, permission, resource)

Order: tenant (both ids non-empty and equal), context (`localMinuteOfDay` integer 0..1439, `localDayOfWeek` 0..6), branch scope, platform guard, grants, conditions. Fails closed throughout; matrices are null-prototype and frozen, `decide` indexes grants per role and permission. Any role of `ctx.roles` with a grant whose conditions all pass allows (most permissive wins).

| Scenario                                                         | allow | reason                     | override                                                         |
| ---------------------------------------------------------------- | ----- | -------------------------- | ---------------------------------------------------------------- |
| Owner, any non-platform permission                               | yes   | `granted`                  | -                                                                |
| Resource tenant differs from ctx tenant                          | no    | `tenant_mismatch`          | no                                                               |
| Branch-scoped user, `resource.branchId` not in scope, or missing | no    | `branch_out_of_scope`      | no                                                               |
| Empty/non-string tenant id on ctx or resource                    | no    | `tenant_mismatch`          | no                                                               |
| Bad `localMinuteOfDay` / `localDayOfWeek`                        | no    | `invalid_context`          | no                                                               |
| No role holds the permission (or `platform:*`)                   | no    | `not_granted`              | no                                                               |
| Cashier discount 1000 bps, limit 1000                            | yes   | `granted`                  | -                                                                |
| Cashier discount 2000 bps, limit 1000                            | no    | `discount_exceeds_limit`   | `manager`, `owner`, `supervisor` (those whose limits cover 2000) |
| `abs(amount)` above `maxAmountMinor` (or missing)                | no    | `amount_exceeds_limit`     | approvers passing                                                |
| Outside `timeWindow`                                             | no    | `outside_time_window`      | approvers passing                                                |
| Device not in `deviceClass` (or unknown)                         | no    | `device_class_not_allowed` | approvers passing                                                |
| `requiresOpenShift` and no open shift                            | no    | `shift_not_open`           | approvers passing                                                |

## Override

Only condition denials carry `override: { permission, approverRoles }`. `approverRoles` = sorted roles in the matrix, not in `ctx.roles`, with a grant for that permission whose conditions pass for the same ctx and resource. Omitted when none qualify. Approvers share the requesting device/time context because overrides are a supervisor PIN on the same terminal. It names who may approve; the approval flow itself (second-person auth, audit row) lives in the calling use case.

## Snapshots

`signSnapshot({ tenantId, version, issuedAt, expiresAt, grants }, secretKey)` signs `utf8(SNAPSHOT_DOMAIN_TAG + canonicalize(payload))` (tag `wb-policy-snapshot-v1\0`) with Ed25519 (`@wise-biz/crypto`). `verifySnapshot(signed, publicKey, { now, tenantId, minVersion?, maxTtlMs? })` never throws and returns a frozen copy. Checks: finite `now`, signature, shape (`malformed`: version must be a non-negative safe integer, `issuedAt < expiresAt`, TTL <= `maxTtlMs` default 7 days, valid roles, no platform permissions, strict conditions), `tenant_mismatch`, `expired` (`now >= expiresAt`), `not_yet_valid` (`now < issuedAt`), `stale_version` (`version < minVersion`). The caller persists the highest version seen per tenant and passes it as `minVersion` to stop rollback/replay after revocation. Failure reasons: `bad_signature | expired | not_yet_valid | tenant_mismatch | stale_version | malformed`.
