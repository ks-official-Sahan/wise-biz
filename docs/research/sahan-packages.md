# `@sahan-sac/*` packages: audit and upgrade plan

Source: `github.com/ks-official-Sahan/Sahan` (`packages/`), inspected 2026-10-18. All packages are ESM-only, Node ≥ 20, published from `dist/`, tarballs verified in CI.

## Inventory

| Package | Version | What it gives | Use in POS |
|---|---|---|---|
| `auth-kit` | 0.12.1 | Auth.js or Better Auth engines, RBAC generic over roles/permissions, emailed-OTP MFA, WebAuthn, step-up, hidden-login unlock, IP allowlist, CSRF/origin checks, CSP nonces, rate limits (Upstash/memory), password policy, invite tokens, short-link helpers, Prisma/Drizzle adapters, Hono helpers | Console + API auth base, security middleware, platform console hiding |
| `auth-kit-client` | 0.1.0 | Typed Better Auth client for React web and Expo, permission hooks, authed fetch | POS app + console client auth |
| `ai-core` | 0.5.0 | Provider chain with fallback (Gemini, OpenRouter, NVIDIA, OpenAI, Anthropic, DeepSeek, xAI, Perplexity, Vertex, any OpenAI-compatible), hedging, cooldowns, deadlines, image generation, prompt-injection guard | Insights narratives, MCP assistant, product description/image helpers, suggestions |
| `analytics-kit` | 0.2.0 | Cookie-free page analytics on Upstash Redis (views, uniques via HLL, top pages, referrers, devices, countries), browser beacon | Storefront traffic only |
| `media-kit` | 0.4.1 | Cloudinary, S3, R2 with ordered failover, upload validation, HMAC/SigV4 signing, delivery transforms, browser upload client | Product images, logos, letterheads, card art, exports, backups |
| `email-kit` | 0.4.0 | Resend + Brevo (API/SMTP) with fallback, header-injection guards, health, quota, tracking, escaped layout | Receipts, invites, alerts, campaigns, reports |
| `chat-kit` | 0.5.0 | Guarded chat runtime on ai-core, knowledge-base builder | Optional in-app help assistant |
| `blog-kit` | 0.5.0 | AI blog generation | Not needed (maybe storefront content later) |

## Admin panel patterns worth reusing (from `app/admin`)

Sections: account, users, roles, sessions, audit, backups, settings, trash, webhooks, emails, media, leads, content, blog, chatbot.

Reusable rules (already enforced there):
- Every mutating action calls `authorizeAction(permission)` first; unauthorized admin routes return `notFound()`.
- Audit write inside the same `$transaction` as the mutation.
- Secrets passed as parameters; constant-time compare.
- Cache invalidation plan per action.
- Rich text sanitized on write and read.
- Origin/CSRF checks on every unsafe `/api/*` call except signature-verified machine paths.
- Production refuses to start with weak secrets.

These carry straight into `AGENTS.md` non-negotiables.

## Gaps for an enterprise multi-tenant POS

| # | Gap | Where | Upgrade |
|---|---|---|---|
| 1 | **No tenancy.** RBAC matrix is global per role; no tenant, branch, or membership concept | auth-kit `rbac/*` | Add `tenantId` + optional `branchIds` to the permission context; matrix per tenant; memberships table in adapters; tenant-scoped role catalogs |
| 2 | **RBAC only.** No conditions (amount limits, time windows, device class) | auth-kit `rbac` | Add an ABAC condition layer (`@pos/policy` first, upstream later) |
| 3 | **Device = parsed user agent.** No device identity, keys, enrollment, or allow/deny list | auth-kit `security/device`, `request-device` | New `device` module: keypair enrollment, approval, device-bound tokens, RFC 9421 request signing verify |
| 4 | **No quick PIN or operator switch** | auth-kit credentials | PIN credential type (Argon2id, per-tenant uniqueness, lockout), fast operator switch on the same device session |
| 5 | **No offline auth.** Permission checks need a server or cache | auth-kit + client | Signed, expiring permission snapshot for devices; verify-only path in auth-kit-client |
| 6 | **cuid IDs** in the Prisma schema | Sahan app | UUIDv7 everywhere (`@pos/ids`); adapters accept an ID generator |
| 7 | **analytics-kit is web analytics**, not business analytics; Redis-only, 500-member caps per day | analytics-kit | Keep for storefront. Business analytics is a new event pipeline (Kafka → rollups) |
| 8 | **media-kit has no tenant scoping** | media-kit `accounts`, `storage` | Tenant folder prefix, per-tenant quotas, offline-sized variants for POS caching |
| 9 | **email-kit templates live in the app**; no per-tenant branding or queue | email-kit | Tenant layout tokens (from `@pos/theme`), send via outbox consumer for retries and rate shaping |
| 10 | **ai-core cost control is global** | ai-core | Per-tenant budgets/quotas, tool-call structured outputs for MCP and insights, audit hook |
| 11 | **Next.js-coupled pieces** (`next-auth` engine, cookie helpers) | auth-kit | Prefer the Better Auth engine + Hono helpers for the API; keep Next helpers for the console |
| 12 | **No MCP support** | — | New `@pos/mcp-core` reusing auth-kit OAuth/session, policy, audit hooks |
| 13 | **CMS not packaged** (noted in the repo's own packages README) | app | Not needed for POS; storefront content uses simple tenant pages |
| 14 | **Node crypto in server packages** | auth-kit, analytics-kit | Import only browser-safe subpaths in Expo; keep server subpaths out of the POS bundle (lint rule) |

## Plan

1. Fork-free: contribute upgrades to the Sahan repo packages where general (tenancy context in auth-kit RBAC, ID generator injection, tenant prefix in media-kit, budgets in ai-core). Bump minor versions; keep backward compatible.
2. POS-specific logic (devices, PIN, policy conditions, entitlements) lives in `@pos/*` and may be upstreamed later if it proves general.
3. Pin exact versions in the POS monorepo; Renovate PRs for upgrades; contract tests against packed tarballs (the Sahan repo already verifies tarballs).
