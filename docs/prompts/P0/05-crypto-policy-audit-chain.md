# P0-05 · Crypto, policy, audit-chain packages

Effort: **H** · Needs: P0-04 · Gate: confirm plan
Read: `docs/architecture/security.md` (Authorization, Request and transaction signing, Audit), `docs/research/sahan-packages.md` (gaps 1, 2, 5)
Libraries: `@noble/curves` (ed25519), `@noble/hashes` (sha256, hmac), RFC 8785 canonical JSON (implement or vetted lib), `@sahan-sac/auth-kit` `rbac/rules` (shape to stay compatible with)
Skills: `ecc:security-review`, `cybersecurity`, `ecc:tdd-workflow`

## Goal
Universal cryptographic and authorization building blocks used by the API, devices, sync, MCP, and audit, with test vectors from the standards.

## Scope
1. **`@wise-biz/crypto`** (universal; pure JS so it runs on Hermes):
   - `canonicalize(value)` per RFC 8785 (JCS).
   - `sha256`, `hmacSha256`, `constantTimeEqual` (hash both sides first, like Sahan's rule), base64url helpers.
   - Ed25519 `generateKeyPair`, `sign`, `verify`, public key fingerprint.
   - No key storage here; storage adapters come with devices (P1-01).
2. **`@wise-biz/audit-chain`**:
   - `link(prevHash, payload) → hash = sha256(canonical(payload) ‖ prevHash)`.
   - `verifyChain(rows)` returns the first broken index.
   - `merkleRoot(hashes)` for daily anchoring.
3. **`@wise-biz/policy`**:
   - Permission type `module:action[:scope]`; catalog built from module registrations (`definePermissions(module, [...])`).
   - Roles → permissions matrix (compatible with auth-kit `matrixFromRows` shape so it can be upstreamed), system roles: `owner`, `manager`, `supervisor`, `cashier`, `inventory_clerk`, `accountant`; tenant custom roles.
   - Membership scope: all branches or a branch list.
   - ABAC conditions as data: `maxAmountMinor`, `maxDiscountBps`, `timeWindow`, `deviceClass`, `requiresOpenShift`.
   - `decide(ctx, permission, resource) → { allow, reason, override?: { permission, approverRoles } }`.
   - Signed policy snapshot for devices: `{ tenantId, version, expiresAt, grants }` signed with Ed25519; `verifySnapshot`.
4. Fixtures and docs: `packages/policy/README.md` decision table; update `docs/architecture/security.md` only where details changed.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | @noble/curves + @noble/hashes current APIs, RFC 8785 test vectors source, RFC 8032 Ed25519 vectors |
| 2 | wb-builder (sonnet) | `packages/crypto/**` | Item 1 |
| 3 | wb-builder (sonnet) | `packages/audit-chain/**` | Item 2 (after crypto API is stubbed; sequential) |
| 4 | wb-builder (sonnet) | `packages/policy/**` | Item 3 |
| 5 | wb-tester (haiku) | `packages/*/test/vectors/**` | RFC 8785 and RFC 8032 vector tests; property: tampering any row/byte breaks `verifyChain` |

## Acceptance
- All RFC test vectors pass.
- `verifyChain` detects edit, delete, insert, and reorder anywhere (property test).
- Policy decision table tests: owner allow-all, cashier discount over limit → `override` with supervisor, branch-scoped manager denied on other branch, expired snapshot rejected.
- No `node:` imports in crypto, audit-chain, policy.

## Review
`ecc:security-reviewer`, `ecc:typescript-reviewer`
