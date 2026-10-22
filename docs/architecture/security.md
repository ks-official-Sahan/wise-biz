# Security

Baseline: OWASP ASVS L2, L3 for identity/payments/devices/MCP. Threat model reviewed per phase.

## Identity and sessions

| Actor | Auth | Session |
|---|---|---|
| Owner / manager / staff (console) | Email + password (policy from auth-kit), passkeys (WebAuthn), emailed OTP MFA, SSO (Enterprise, OIDC/SAML) | httpOnly, `Secure`, `SameSite=Strict` cookie for console; `Lax` only on the storefront where cross-site return from payment gateways is needed |
| Operator on terminal | Quick PIN (4–8 digits) **only on a registered terminal**, or full login | Device-bound session: token bound to device key (DPoP-style proof per request) |
| Customer (storefront) | Email link / OTP, optional passkey | Separate cookie name and audience |
| MCP clients | OAuth 2.1 + PKCE, scoped tokens | Short-lived access, rotating refresh |
| Machine (webhooks, integrations) | HMAC signatures / API keys (hashed at rest, scoped, rotatable) | — |

PIN rules: per-tenant unique, hashed with Argon2id + pepper, 5 tries → lockout with supervisor reset, PIN snapshot on device is a salted hash list signed by server and expiring.

### Implementation (P0-08a, ADR 0010)

- Engine: `better-auth` behind `IdentityPort` (`modules/identity`), mounted at `/v1/auth/*`. Tenancy is our own module.
- Identity tables (`identity.*`) are global, granted only to DB role `wb_identity`; `wb_app`, `wb_worker`, `wb_chainer`
  have no privileges (enforced by `rls-check`). Every identity row id is UUIDv7.
- Session cookie `__Host-wb_session`: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`; 12 h, rolling
  every 1 h; no cookie cache, so revocation is immediate.
- Tenant context: only `identity.sessions.active_tenant_id`, written by switch-tenant / create-business after an active
  membership is verified, and re-checked against `tenancy.memberships` on every request. Missing → no tenant → 404.
- Permissions: policy rows per tenant, matrix cached in-process (LRU) and in Redis under `t:{tenant}:perm:v{n}`;
  `permissions_version` is bumped by a trigger on any grant change (a grant change outside the tenant context fails).
  Redis must be private and authenticated: whoever can write it can grant permissions.
- Rate limits (Redis fixed window, fail closed with 503 `RATE_LIMIT_UNAVAILABLE`): sign-in 10/min per IP and 5/min per
  email, sign-up 5/min per IP, other unsafe `/v1/auth/*` 10/min per session, create-business 5/min per user; at most 20
  owned tenants per user. Client IP = socket peer, or the Nth `X-Forwarded-For` entry from the right with
  `TRUST_PROXY_HOPS=N`; IPv6 bucketed by /64. Better Auth receives the same trusted IP.
- CSRF: cookie-bearing unsafe requests need an allowlisted `Origin` or `Sec-Fetch-Site: same-origin` (403
  `ORIGIN_REJECTED`); `*` is never a trusted origin and is rejected in production.
- Known gaps (P0-08b): sign-up reveals whether an email is registered and accounts are not email-verified until
  email delivery lands (`requireEmailVerification`); per-email sign-in limit allows a cheap lockout of one account.

## Authorization

`@wise-biz/policy`: RBAC + ABAC.
- Role grants permissions (`sales:void`).
- Membership scope narrows to branches.
- Conditions: amount limits (`discount ≤ 10%`, `refund ≤ 5,000 LKR`), time windows, device class, shift open.
- Decision cached per (user, tenant, version) in Redis and shipped to devices as a signed snapshot for offline checks.
- Super-roles: `owner` (tenant), `platform_admin` (platform). Never grantable via UI: platform permissions.

Overrides: when an operator lacks permission (edit qty after add, price override, discount above limit, void, return without receipt, open drawer without sale), the UI asks for a supervisor PIN or step-up. The audit row records requester, approver, reason, before/after.

## Devices

1. **Enroll:** app generates an Ed25519 keypair in secure storage (Android Keystore / iOS Secure Enclave-backed Keychain / Electron `safeStorage`; web: non-extractable WebCrypto key in IndexedDB, flagged low-trust).
2. App shows enrollment code/QR; owner approves in console, assigns branch and name. Optional: attestation (Play Integrity / App Attest) on P2.
3. Server stores public key, fingerprint, platform, app version, IP, first seen.
4. **Allow/deny lists:** status `pending | active | suspended | revoked | blacklisted`. Only `active` terminals can submit sales. Console and reports can be used from any authenticated device; transactions only from active terminals.
5. Heartbeat every 60 s online: battery, app version, unsynced count, last user, connection type, IP. Stored for 90 days; missed heartbeats alert.
6. Lost device: revoke → key rejected; on next contact device wipes local data.

## Request and transaction signing

- **Request signing** (devices, MCP platform): header `Signature-Input`/`Signature` per RFC 9421 over method, path, `content-digest`, `x-pos-timestamp`, `x-pos-nonce`. Server rejects skew > 5 min and replayed nonces (Redis SET with TTL).
- **Transaction signing:** every sale/return/void/shift close is hashed (canonical JSON, RFC 8785) and chained per terminal (`prev_hash`), then signed by the device key. Server verifies and stores both. A daily Merkle root per tenant is written to the WORM audit bucket → external tamper evidence.

## Audit

- `audit.audit_log(id, tenant_id, actor, action, entity, entity_id, before jsonb, after jsonb, reason, ip, device_id, request_id, prev_hash, hash, at)`, partitioned monthly, **append-only** (DB role has no UPDATE/DELETE).
- Written inside the same transaction as the change (Sahan rule).
- Hash chain per tenant, sealed asynchronously by the `audit-chainer` worker (chain order = `chain_seq`; ADR 0009); daily Merkle anchor per tenant; verification always checks against the anchor.
- Read in console with filters; export signed CSV.
- Every operation is logged: views of sensitive data (customer PII export, reports export) included.

## Web security

| Control | Rule |
|---|---|
| CSP | Nonce-based strict CSP on console and storefront (auth-kit `security/csp`); `frame-ancestors 'none'` except payment iframes allowlisted |
| CSRF | Origin/`Sec-Fetch-Site` check on all unsafe methods (auth-kit `check-origin`); double-submit token for forms; machine paths (webhooks, device API) excluded but signature-verified |
| Cookies | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict` (console), short TTL + rolling |
| Headers | HSTS preload, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal; COOP/COEP on POS web build |
| Rate limits | Edge (per IP), API (per user, per device, per tenant), auth endpoints fail-closed |
| Input | zod at every boundary; output encoding; rich text sanitized on write and read |
| SSRF | Allowlist for outbound integrations/webhooks; block private IP ranges |
| Secrets | Env + secret manager; parameters to pure functions; rotation without code change; constant-time compare |
| Admin hiding | Unauthorized admin/platform routes return 404 |

## Glass-break

Platform emergency access to a tenant (support incident, legal):
- Requires two platform admins (request + approve), reason, ticket ID, time box (default 60 min).
- Session watermarked, all actions audited with `glass_break=true`, tenant owner notified (unless legal hold).
- Tenant-side glass-break (owner locked out): recovery codes + platform-verified identity flow.
- Hidden unlock gate and IP allowlist for the platform console (auth-kit `login-unlock`, `security/allowlist`).

## Payments and PCI

- Card data never touches our code or devices: **semi-integrated** terminals (the terminal talks to the processor; we send amount, receive result + token) and hosted fields / redirect for online.
- Store only gateway tokens, last4, brand, auth code. Scope target: SAQ A (online) / P2PE-validated terminals in store.
- Webhooks from gateways: signature verified before parsing; idempotent by gateway event ID.

## Data protection

- Encryption at rest: Postgres (provider), object storage, device DB (SQLCipher or OS-level + key from keystore).
- PII minimization: customer phone/email hashed for lookup (`hmac(pepper, normalized)`), plaintext encrypted with tenant DEK (envelope encryption, KMS).
- Data export and delete per customer (GDPR-style; Sri Lanka PDPA 2022 compliant workflow).
- Backups encrypted; restore drills quarterly.

## Monitoring

- Security events to `audit` topic → SIEM (P2): failed PINs, device revocations, permission changes, glass-break, MCP destructive calls, anomalous refunds/voids per operator.
- Fraud signals for DSS: refunds without receipt, voids after payment, drawer opens without sale, discount abuse, sales at odd hours.
