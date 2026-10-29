# Progress

Updated by the orchestrator at the end of every step (`/wb-step`, protocol step 10). Keep entries to one line plus follow-ups.

Legend: ⬜ todo · 🟡 in progress · ✅ done · ⛔ blocked

## P0 — Foundations

| Step | Status | Date | Commit | Notes / deviations |
|---|---|---|---|---|
| P0-01 Monorepo | ✅ | 2026-10-19 | 6c6d7e8 | Branch `cc/gracious-allen-044iq6` (harness) not `step/P0-01`. TS 6.0.3 not 7 (typescript-eslint <6.1). No eslint-plugin-react/jsx-a11y (no ESLint 10 support). Packages ship TS source (ADR 0008). Prose `.md` excluded from Prettier. Added `apps/ modules/ services/.gitkeep`, rule `modules-not-to-apps`, root `lint:root` task. |
| P0-02 Local infra + env | ✅ | 2026-10-19 | 05f2d35 | MinIO images unpublished → RustFS 1.0.3 (S3 API) + aws-cli `storage-init` (profile `init`, run after `up --wait`, which fails on exited one-shots). Check script runs on plain `node` (no tsx). `env:check` added to `pnpm check`. Prod rejects `.env.example` placeholder secrets. Up ≈8 s. |
| P0-03 CI baseline | ✅ | 2026-10-19 | bff48fa | CI ran on PR #2 (merged): check, actionlint, audit, gitleaks, licenses, CodeQL green; `Dependency review` green on PR #3 after the owner enabled Dependency graph (2026-10-21). Default branch is `master`, not `main`. gitleaks + actionlint as checksum-verified binaries (gitleaks-action needs an org license). GHSA-vfj7-8cjw-p6xm (braces, no patch, lint-only path) ignored in `auditConfig`. caniuse-lite CC-BY-4.0 allowed as reviewed exception. |
| P0-04 Core packages | ✅ | 2026-10-19 | 416c081 | Single step (user chose over 04a/04b split). Own uuidv7 (no `uuid` dep), counter overflow advances a virtual ms. Money/Currency/Uuid7 branded; contracts parse to branded values. Per-document tax keeps line signs. JSON Schema generated with `io: "input"` (transforms). Heavy suites get explicit timeouts (parallel turbo + coverage). Coverage ids 100%/94% br, money 100%/93% br. |
| P0-05 Crypto, policy, audit-chain | ✅ | 2026-10-19 | d27dca0 | Own RFC 8785 canonicalize + hand-written UTF-8 (Hermes); @noble/hashes+curves 2.4 (strict RFC 8032). Vectors from pyca/cryptography + C2SP/wycheproof mirrors (rfc-editor.org/nist.gov blocked by proxy). verifyChain takes an anchor (tail truncation only detectable against one). Policy fails closed (scope, context, unknown condition keys); snapshots domain-separated, minVersion rollback guard, TTL cap. Overrides: approvers share the requesting terminal context (PIN on same device) — review suggestion declined. |
| P0-06 API, DB, RLS | ✅ | 2026-10-20 | 005e670 | Split 06a/06b (user). **06a ✅**: @wise-biz/db (pg 8 + drizzle 0.45; withTenantTx via set_config; RLS `nullif(current_setting(…), '')::uuid` so pooled empty setting = zero rows; own SQL migrator per module, wb_migrations bookkeeping; rls-check incl. partitions/matviews/views/policy content; query counter) + testcontainers harness (PG18 template clone ~100 ms). rls-check proven with a temporary module. **06b ✅**: apps/api (Hono 4.13 + zod-openapi, middleware order per spec with CORS before body limit, problem+json incl. PAYLOAD_TOO_LARGE, /ready cached 1 s single-flight, NODE_ENV now required so dev auth can never be inferred), @wise-biz/module-kit (modules can't import apps), modules/_template (PK (tenant_id,id), RESTRICT FKs, 2 queries for 50 rows, EXPLAIN as wb_app). Verified: fresh infra → migrate → rls-check → 82 api tests; real server curl /health 200, /ready 503 with PG stopped. |
| P0-07 Outbox, idempotency, audit | ✅ | 2026-10-21 | 260d2e4 | Split 07a/07b (user). **07a ✅**: modules/infra (outbox, processed_events, dead_letters; forced RLS + per-command wb_worker policies; new wb_worker role, no BYPASSRLS), @wise-biz/events (EventBus port, memory + pg adapters, shared contract test), apps/workers relay. Review CRITICALs fixed by a **lease-based relay** (claim in short tx, publish with no tx open, mark only delivered; quarantine after max attempts; pruning). Tenant-scoped idempotency keys; consumer tx sets app.tenant_id. **07b ✅**: infra.idempotency_keys decided in the mutation tx under an advisory xact lock (byte-identical text replay; key scoped per user; Redis = best-effort cache), modules/audit (partitioned audit_log, async chainer with chainer-assigned chain_seq — ADR 0009, daily anchors, partition job 6 months ahead), runCommand in module-kit (7 statements per create). **Deviation: load smoke target NOT met in this container** — 1 API process ~520 req/s, p50 16 ms, p97.5 41 ms at 16 conns, 0 errors, no lock waits sampled; 2 processes ~575 req/s combined (4-core box shared by API, PG, Redis, docker-proxy, load generator = machine-bound). Re-run on a laptop/perf box. |
| P0-08 Identity + tenancy | ✅ | 2026-10-22 | 71a97e7 (08a), ad99169 (08b) | Split 08a/08b (user). ADR 0010 (council-backed): own tenancy tables; `better-auth` 1.7.12 directly for identity (auth-kit engine has v4 IDs, Upstash-only limiter, Next peers — upstream in P0-11; password policy ported). **08a ✅**: modules/identity (global `identity` schema, role `wb_identity`, `__Host-wb_session`, UUIDv7 ids), modules/tenancy (8 RLS tables, own-rows SELECT policies only without an active tenant, SECURITY DEFINER version-bump trigger on grants that fails outside tenant context), create business (client UUIDv7 tenantId, one tx, cap 20), me/tenants, switch (audited), API kernel (session → membership resolver fail closed, LRU+Redis+DB policy matrix, fail-closed Redis rate limits, `TRUST_PROXY_HOPS`, origin guard), `API_DEV_AUTH` removed, rls-check global schemas + policy-shape lint. Deviation: sign-up is two steps (account, then business) — no cross-module tx. Reviews: 4 HIGH fixed (cross-tenant own-rows policy, tenants grants, getSession swallowing infra errors, XFF trust). Test infra: vitest maxWorkers 4 per package (Docker saturation); graceful shutdown no longer hangs when Redis is lost. **08b ✅** (single step, user): email verification + uniform sign-up, emailed OTP 2FA, passkeys (UV required), invites (HMAC-derived tokens, never stored; accept/revoke terminal by trigger), member roles with last-owner 409, custom roles + grants, `@wise-biz/mailer` (SMTP/Resend, TLS required in prod), invite email via outbox consumer, `pnpm db:seed` demo tenant. Deviations: `AuthContext.email` optional; `invite-token.ts` sits outside `domain/` (node:crypto ban); seed script is `.mts` like the other root scripts (not type-checked). Reviews: 3 security HIGH fixed (privilege ceiling: role edits owner-only, non-owners assign only roles they hold; passkey UV; prod SMTP TLS), 2 DB HIGH fixed (terminal invite trigger, accepted pair CHECK), plus owner-member guard, seed allow-list, pending-only invite index. |
| P0-09 Design system | ✅ | 2026-10-24 | 43f15de (09a), 402176d (09b) | Split 09a/09b (user). ADR 0011: plain StyleSheet + context (no styling lib), Material Color Utilities (HCT) palettes, own WCAG 2.2 checker, DTCG 2025.10 tokens with light/dark as a theme modifier. Per store: light only, dark only, or both (toggle + per-mode seed and accent/canvas/surface overrides); status/text not brandable. Platform default teal "Counter" light + amber "Workshop" dark. **09a ✅** `@wise-biz/theme`: zod schema, palettes, guarantee step (any seed passes AA, property-tested 300 seeds), validator with suggestions, resolve (platform → tenant → branch → terminal, memo keyed by canonical input), compilers (CSS vars, RN object, receipt, DTCG). MCU 0.4.0 patched (`patches/`) to load on plain Node ESM. Design rules distilled from the design skills into `docs/design/ui-principles.md`. Review: 1 HIGH fixed (memo keyed by forgeable hash). **09b ✅** `@wise-biz/ui`: 20 RN primitives on react-native-web, split theme/mode contexts, per-theme StyleSheet cache, required a11y labels by type, 48 dp targets, focus ring, press feedback (reduced motion respected), modal focus trap + return, APG spinbutton, roving tabs, persistent toast live region (danger persists, pause on hover). 90 tests, 97 % statements. `apps/ui-gallery` (Expo SDK 58 web): components + sell screen at 390/834/1440, URL state, Playwright 26/26 (visual baselines, axe WCAG 2.2 AA serious/critical = 0, theme switch < 100 ms, keyboard focus ring, no console errors). Deviations: vitest + RNW + jsdom instead of jest-expo; web font fallback stacks in ThemeProvider; OFL-1.1 (Geist) and argparse Python-2.0 added to the license allowlist. Review: 2 CRITICAL + 6 HIGH (focus trap, toast timing, spinbutton, keypad key capture) fixed. |
| P0-10 Console shell | ✅ | 2026-10-27 | c815d99, d00c805 (10a), P0-10b commit | Split 10a/10b. **10a ✅** API: business profile, onboarding draft/complete, branches, locations (tenancy 0003); audit read API (keyset, detail, CSV export capped 10k, itself audited, formula-injection guard). **10b ✅** `apps/console`: Next.js 16.4.3 App Router, `proxy.ts` per-request CSP nonce + static security headers, `/v1/*` rewritten to the API (first-party `__Host-` cookie, connect-src self); auth (password, emailed OTP, passkey, sign-up with uniform response), setup, invite accept (token in URL fragment, stripped on load), app shell (sidebar → bottom nav, tenant switcher, Ctrl/Cmd+K palette), onboarding wizard with autosaved draft, people, roles matrix with summary before save, audit viewer (filters, diff drawer, CSV), settings (profile, branches, locations). TanStack Query keys tenant-prefixed, staleTime by data class. Better Auth client lazy-loaded (sign-in/up only); shell reads session via plain query. Bundle: every route < 200 KB gzip JS (measured from served HTML). Playwright shell spec 11/11 (CSP nonce per request, headers, 404, no-referrer on /invite, signed-out redirect, axe at 390/834/1440); full owner journey spec gated on `E2E_FULL=1`. Reviews: security (open redirect via backslash/control chars, invite token in query) and React (idempotency key reuse, empty role on invite, unguarded tenant switch, settings tabs keyboard, form reset on refetch, export flag, step focus) fixed. Deviations: `@next/bundle-analyzer` replaced by Turbopack `next experimental-analyze`; styling is CSS Modules on `--wb-*` tokens, not RN-web. |
| P0-11 Upstream Sahan packages | ✅ | 2026-10-28 | Sahan `1ac3d8a` (branch `feat/wise-biz-upstream`, unpushed) | Scoped to what wise-biz consumes (only `@sahan-sac/email-kit`; ponytail). **email-kit** (minor, changeset): generic SMTP relay provider `./providers/smtp` (AUTH optional, TLS required in production, plain for local Mailpit), `SmtpConfig.user/pass` optional, `renderEmail` `theme` (accent, canvas, https logo; invalid values fall back). Sahan `pnpm test` 667/667, `typecheck`, `verify:packages` pass; email-kit 76/76. Gap #19 (WebAuthn UV) is not a defect: UV-less assertions are only accepted as a second factor after the password; passwordless already requires UV. Deferred until wise-biz consumes them: auth-kit scoped RBAC + ID injection (#15–18; wise-biz uses Better Auth directly per ADR 0010), media-kit tenant prefix/quota, ai-core budgets. wise-biz bump waits for the email-kit release. |
| P0-12 Gate | 🟨 | 2026-10-28 | this commit | Report `docs/reports/P0-gate.md`: P0 exit proven by the owner-journey e2e; security (no HIGH; fixed auth-write per-IP bucket and Better Auth cookie defaults) and DB reviews (RLS on every tenant table, FK indexes) done; audit and licenses clean; depcruise fixed for the console alias. One container-health flake in the parallel run. **Waiting for your OK to tag `v0.1.0`.** |

## P1 — Sell and stock, offline

| Step | Status | Date | Commit | Notes / deviations |
|---|---|---|---|---|
| P1-01 Devices | ✅ | 2026-10-28 | 8ca3bcb, 8289019 (01a), 76b81f7 (01b) | Split 01a/01b. **01a ✅** `@wise-biz/http-signatures` (RFC 9421 profile + RFC 9530 digest; unsigned, wrong-key, tampered-body, replay and skew tests; verify p95 < 2 ms opt-in perf test); `modules/devices` (enrollment by owner one-time code redeemed with proof of possession, `withLookupTx` single-row lookups, kernel `deviceAuth`, nonces in Redis fail closed, `requireDevice`/`requireTerminal` with `DEVICE_REVOKED` wipe and `DEVICE_INACTIVE`, heartbeat). Deviation: owner creates the code (approval) instead of approving a pending device, so no unauthenticated pending rows; no `device_keys`/`device_events` tables yet (one key per device; audit_log holds events). **01b ✅** operator PIN: `PUT /v1/devices/pin` (4–8 digits, weak PINs refused, unique per business via HMAC lookup), Argon2id m=19 MiB t=2 with `PIN_PEPPER` as secret (`@node-rs/argon2`, MIT, server only), offline verifier hash stored (m=8 MiB t=1, no pepper), signed `pin-login` with per-operator counter committed before the 401, lock at 5, supervisor unlock (`devices:unlock`, audited), 12 h operator session per terminal, `pin-logout`. Default grants: manager/supervisor get devices permissions, every role gets `devices:pin`. Deferred: offline verifier delivery (P1-06 snapshot), heartbeat retention and missed-heartbeat job. |
| P1-02 Catalog + search | 🟨 | 2026-10-28 | f3274ed (02a), see log (02b) | Split 02a catalog core / 02b search projection / 02c import / 02d media. **02a ✅** `modules/catalog`: products + variants + barcodes + units/conversions + category tree + tags + product_media; CRUD via `runCommand` with optimistic locking (`version`, 409), constraint violations mapped to 409/422; keyset list with category-subtree/tag/archived/updatedSince filters and `include=variants,barcodes,media` (4 queries for 50 products, tested); barcode lookup for active terminals or `catalog:read`; 4 self-sufficient events (a category rename/move re-emits its subtree's products, batched). EXPLAIN on 300 tenants: no seq scans; lookup on `barcodes_code_key`. Default grants add `catalog:read` to every role, `catalog:write` to manager and inventory clerk. **02b ✅** `modules/search`: projection consumer (wb_worker, tenant-scoped tx, tolerant reader of `catalog.variant.upserted`, older events never overwrite newer docs); hybrid query in one round trip. "cocacola 1.5" finds "Coca-Cola 1.5L" (unit + perf test). Perf (opt-in `test:perf`, 100k variants in one tenant + 20k noise): p50 52 ms, p95 87 ms, max 122 ms over 200 queries; trigram leg is a GiST KNN (33 ms). Deviation: GIN trigram at a 0.3 threshold measured p95 866 ms, so the trigram leg is a GiST KNN. **02c–02d ⬜**. |
| P1-03 Pricing + tax | ⬜ | | | |
| P1-04 Inventory | ⬜ | | | |
| P1-05 Sales server | ⬜ | | | |
| P1-06 Sync server + realtime | ⬜ | | | |
| P1-07 Sync client | ⬜ | | | |
| P1-08 POS app shell | ⬜ | | | |
| P1-09 Sell screen | ⬜ | | | |
| P1-10 Tender, receipts, hardware | ⬜ | | | |
| P1-11 Returns, shifts UI | ⬜ | | | |
| P1-12 Desktop | ⬜ | | | |
| P1-13a Console catalog/stock | ⬜ | | | |
| P1-13b Console sales/devices | ⬜ | | | |
| P1-13c Console branding | ⬜ | | | |
| P1-14 Reporting + notifications | ⬜ | | | |
| P1-15 Deploy + release | ⬜ | | | |
| P1-16 Gate | ⬜ | | | |

## P2 — Enterprise

Tracked in `docs/prompts/P2/README.md` order; add rows here when P2 starts.

## Resume here

- Next step: P0-09 (`docs/prompts/README.md` order). Branch `feat/p0-08-identity-tenancy` holds P0-08a+b, not yet pushed/PR'd.
- After pulling P0-08: `pnpm infra:reset` (new DB role `wb_identity`), then `pnpm db:migrate`. `.env` needs `DATABASE_IDENTITY_URL`, `TRUST_PROXY_HOPS`, `INVITE_SECRET`, `CONSOLE_URL`, `AUTH_RP_ID`, `MAIL_*` (see `.env.example`); `API_DEV_AUTH` is gone. Demo data: `DEMO_PASSWORD=... pnpm db:seed`. Root/package scripts load the repo `.env` via `node --env-file-if-exists` (shell env wins); `infra:reset` is a Node script (the old `sh -c` one-liner silently did nothing under cmd.exe).
- Run tests with `REDIS_URL` unset in the shell (the env test assumes it is absent; containers provide Redis).
- P0-01–P0-07 merged via PR #3; all CI checks green (check, actionlint, audit, gitleaks, licenses, CodeQL, dependency review).
- Local prerequisites: Node 24 LTS, pnpm 12 (Corepack), Docker. `pnpm i && cp .env.example .env && pnpm infra:up && pnpm check`.
- gitleaks false positives go in `.gitleaksignore` (fingerprint, reviewed) — never real secrets.
- Commit scopes are restricted by commitlint (`commitlint.config.*`); subjects lowercase.

## Follow-ups

<!-- - [ ] (P0-04) example: add GS1 exponent edge cases — owner: next step that touches money -->
- [ ] (P0-01) `prepare: lefthook install` fails without `.git` (Docker/CI): set `LEFTHOOK=0` or guard it — owner: P0-02/P0-03
- [ ] (P0-01) Lefthook `stage_fixed` with partially staged files: confirm unstaged hunks are not staged — owner: P0-03
- [ ] (P0-01) `deps:graph` pipe has no pipefail — owner: P0-03
- [ ] (P0-01) Remove `minimumReleaseAgeExclude` (commitlint 21.2.4) from `pnpm-workspace.yaml` after 2026-10-21 — owner: next step touching deps
- [x] (P0-02) `assertProductionEnv` skips everything when NODE_ENV is unset/misspelled — fixed in P0-06b: NODE_ENV required, main.ts calls assertProductionEnv
- [ ] (P0-02) Length/placeholder checks cover `*_SECRET` (+ placeholder on `*_KEY`/`*_PASSWORD`); list prod-sensitive keys explicitly (API keys, DB passwords) — owner: P0-06
- [ ] (P0-02) Dev storage creds duplicated in compose.yaml and .env.example; `db:psql` puts dev password in argv (dev-only) — owner: P0-03
- [x] (P0-03) Repo settings: enable Dependency graph + Private vulnerability reporting (owner action) — done 2026-10-21
- [ ] (P0-03) CI guard: fail if any shipped app/package lists `@wise-biz/config` under `dependencies` (keeps the braces GHSA ignore valid) — owner: P0-06
- [ ] (P0-03) Remove `GHSA-vfj7-8cjw-p6xm` ignore once braces ships a fix — owner: Renovate eslint group PR
- [ ] (P0-04) `pageOf()` needs a `.meta` id when OpenAPI generation lands; registry `defineEvent` throws on double module evaluation (HMR) — owner: P0-06
- [ ] (P0-04) `Timestamp` accepts year 0000 / 9-digit fractions; `format()` output with symbol does not round-trip through `parse()` (by design, documented) — owner: next step touching contracts/money
- [ ] (P0-04) ISO 4217: confirm XAD (Arab Accounting Dinar) status and add if active — owner: next step touching money
- [ ] (P0-05) Cross-check RFC 8032 TEST 1–3 and RFC 8785 Appendix B number table against rfc-editor.org when reachable; add SHA-256 1M×"a" vector — owner: next step touching crypto
- [x] (P0-05) Audit verification passes the daily anchor and asserts `anchored: true` — done in P0-07b (anchors unsigned: see P0-07b follow-up)
- [ ] (P0-05) Devices persist the highest policy snapshot version per tenant and pass it as `minVersion` — owner: P1-01
- [ ] (P0-05) Tenant-wide permissions (no branch) for branch-scoped users currently deny; add an explicit tenant-wide marker when reports need it — owner: P1-14
- [ ] (P0-06a) Append-only tables (audit, outbox history, movements) must REVOKE UPDATE/DELETE from wb_app in their migration (default privileges grant DML) — owner: P0-07, P1-04
- [ ] (P0-06a) rls-check matches `app.tenant_id` in policy text; a hand-written `true OR …` would pass — review migrations for policy shape — owner: every module PR
- [ ] (P0-06a) Pool startup `-c` options break behind pgbouncer transaction mode; move timeouts to role settings only if pgbouncer is introduced — owner: P1-15
- [x] (P0-06b) Create endpoint goes through runCommand (idempotency + audit + outbox in one tx) — done in P0-07b
- [x] (P0-06b) Auth is a dev-header placeholder (API_DEV_AUTH) — replaced in P0-08a by Better Auth sessions + tenancy memberships (devices remain P1-01)
- [ ] (P0-06b) `main.ts`/OTel bootstrap lack direct unit tests (covered by the listening-server integration test only) — owner: P0-12 gate
- [ ] (P0-07a) Multiple relays publish out of per-key order (SKIP LOCKED); partition relays by hash(key) or rely on Kafka partitioning when the Kafka adapter lands — owner: P2 Kafka adapter
- [ ] (P0-07b) Load smoke: re-run `pnpm load:template` (1,000 req/s, 30 s, p95 < 50 ms) on a laptop/perf box with ≥ 2 API replicas; this 4-core container topped out at ~575 req/s — owner: P0-12 gate
- [ ] (P0-07b) Sign daily audit anchors (Ed25519) and export to WORM storage; wb_chainer can currently insert future anchors — owner: P1-15
- [ ] (P0-07b) Audit retention: verify-chained-and-anchored → export → DETACH PARTITION CONCURRENTLY → drop; PII redaction/crypto-shredding policy for before/after — owner: P1-14
- [ ] (P0-07b) HMAC Redis idempotency cache values; partition idempotency_keys by expires_at if volume requires — owner: P1-15
- [ ] (P0-07b) API metrics sink (startServer hooks.onMetric) not wired; workers log metrics every 60 s pending OTel export — owner: P0-12 gate
- [ ] (P0-07b) module-audit tests failed twice under full parallel load right after heavy Docker activity, then passed 5 cold runs; capture output if it recurs — owner: P0-12 gate
- [ ] (P0-01) Add jsx-a11y / RN a11y lint once a plugin supports ESLint 10 — owner: P0-09
- [ ] (P0-09a) Contrast pairs cover semantic tokens only; add component-state pairs (chip selected/unselected, keypad, button pressed and disabled) — owner: P0-12 gate
- [ ] (P0-09a) Property test does not generate overrides or tenant/branch layering; extend and assert suggestions pass — owner: P0-12 gate
- [ ] (P0-09b) Roving tabindex for radio chip groups (Tabs done); add a ChipGroup primitive — owner: P1-09
- [ ] (P0-09b) Announce loading (Skeleton container aria-busy + status text) and SearchField result counts via a polite live region — owner: P1-09
- [ ] (P0-09b) Move reduce-motion listener from each component into ThemeProvider; Button surfaces onPress rejections; SearchField stale debounce; usePressFeedback mid-press flip — owner: P1-08
- [ ] (P0-09b) Theme switch: warm 44 ms, cold 145 ms in jsdom (first StyleSheet creation per theme); precompile/prewarm styles at store switch — owner: P1-08
- [ ] (P0-09b) Font pipeline for POS native (expo-font Geist assets bundled); web uses system fallback stacks until loaded — owner: P1-08
- [ ] (P0-09b) `@tabler/icons-react-native` ships no `.d.cts`; tsconfig `paths` maps its types — drop when upstream fixes (third-party Tabler, not a Sahan package) — owner: P1-08
- [ ] (P0-09b) Visual baselines are win32 only; generate linux baselines in CI — owner: P0-12 gate
- [ ] (P0-09b) UI theme-switch perf test is opt-in (`pnpm -F @wise-biz/ui test:perf`, vitest `--mode perf`): wall clock under turbo parallel load read 378 ms vs 44 ms alone; add a dedicated CI perf job — owner: P0-12 gate
- [ ] (P0-09b) `@tabler/icons-react-native` also breaks depcruise resolution (`exports.require.types` → missing `.d.cts`); narrow `pathNot` exception in `.dependency-cruiser.cjs` (third-party) — owner: P1-08
- [x] (P0-10b) Gated owner-journey e2e (`E2E_FULL=1`) passes: sign up, Mailpit verify, sign in, setup, onboarding, invite, audit — found and fixed a setup→shell bounce from a stale tenant list
- [ ] (P0-10b) Owner-journey e2e lacks an "assign role" step (needs a second, accepted member) — owner: P0-12 gate
- [ ] (P0-10b) A field typed before hydration is reset on slow loads (controlled inputs); render forms after hydration or use uncontrolled defaults — owner: P1-15
- [ ] (P0-10b) `pnpm -F api dev` restart-loops on Windows: `node --watch` fires on node_modules changes; scope the watch paths — owner: P0-12 gate
- [ ] (P0-10b) Lighthouse mobile (a11y ≥ 95, best practices ≥ 95) on dashboard, people, audit — owner: P0-12 gate
- [ ] (P0-10b) Sign-in answers "verify your email first" for unverified accounts (Better Auth 403), which reveals the account exists; make the API answer uniformly — owner: P1-15
- [ ] (P0-10b) Members keyset pagination + search in the console waits on the identity names contract (below); prefetch on hover not wired yet — owner: P1-15
- [ ] (P0-10b) Notification bell and nav badges API are placeholders — owner: P1-15
- [ ] (P0-10a) Members and audit actors carry user ids only; add an identity contract (`displayNamesByIds`, one batched query) so the console shows names and member search (`q`) can work without cross-module reads — owner: P0-10b / P1-15
- [ ] (P0-10a) Default grants: give manager/accountant `audit:read` and owner-only `audit:export` explicitly once DEFAULT_ROLE_GRANTS spans modules — owner: P1-15
- [ ] (P0-10a) Audit CSV export is built in memory and capped at 10k rows; stream it (cursor + chunked response) for larger ranges — owner: P1-14
- [ ] (P0-10a) Onboarding draft saves are audited (rule 5); the console must save on step change, not per keystroke — owner: P0-10b
- [ ] (P0-09b) RN Modal on react-native-web does not inert siblings; focus trap covers keyboard, screen-reader virtual cursor can still leave — owner: P1-08
- [ ] (P0-09a) `toDtcg` returns `{ tokens, resolver }`; emit separate token set files plus a top-level 2025.10 resolver document when theming publishing lands — owner: P1 theming module
- [ ] (P0-09a) `resolveTheme` does not reject failing overrides (editor needs a preview); publishing must call `validateTheme` and refuse issues — owner: P1 theming module
- [ ] (P0-09a) Terminals should receive precompiled themes (MCU ~1 MB unpacked stays out of the POS bundle); regenerate the MCU patch on upgrade — owner: P1 theming module
- [ ] (P0-09a) Theme perf test is wall-clock (< 20 ms median); watch for CI flakes — owner: P0-12 gate
- [x] (P0-08a) Sign-up reveals registered emails; accounts unverified — fixed in P0-08b (`requireEmailVerification`, uniform response)
- [ ] (P0-08a) Per-email sign-in limit (5/min) lets an attacker lock one account out; add CAPTCHA/step-up or progressive delay — owner: P1-15
- [ ] (P0-08a) `identity.accounts` OAuth tokens are plaintext columns (unused today); encrypt (tenant-agnostic KMS key) before social login/SSO — owner: P2 SSO
- [ ] (P0-08a) Cluster default privileges grant wb_app DML on every new table, so each new global-schema table relies on its migration's REVOKE (caught by rls-check); scope defaults per schema — owner: P1-15
- [ ] (P0-08a) Passkey RP ID is one domain; per-tenant custom domains need a passkey strategy — owner: P2 storefront domains
- [ ] (P0-08a) Per request: session lookup + loadMembership tx (BEGIN, set_config, SELECT, COMMIT); collapse to one round trip or a 2–5 s (user, tenant) cache if p95 budget needs it — owner: P0-12 gate
- [ ] (P0-08a) `@wise-biz/env` "defaults to process.env" test fails when the shell has REDIS_URL; make it hermetic — owner: P0-12 gate
- [x] (P0-08a) `pnpm db:rls-check` verified against the dev DB after `pnpm infra:reset` (2026-10-22); `db:seed` verified too
- [ ] (P0-08b) OTP attempts reset per challenge; add a per-user failed-OTP counter or rate-limit `two-factor/*` by user — owner: P1-15
- [ ] (P0-08b) Sign-up limited per IP only (verification-mail flooding of one mailbox); add a per-email-digest limit; cap invites per tenant/user and limit `tenantName` length/charset in invite subjects — owner: P1-15
- [ ] (P0-08b) Passkey add/delete relies on Better Auth `freshAge` (1 day); consider password re-auth for factor changes — owner: P1-15
- [ ] (P0-08b) Passkey sign-in skips the email OTP by design (UV-verified passkey = MFA); revisit if a tenant policy demands OTP on every sign-in — owner: P2 policies
- [ ] (P0-08b) twoFactor plugin always mounts TOTP/backup-code endpoints; hide unused ones — owner: P1-15
- [ ] (P0-08b) Identity mail failures are logged via console.error (no PII), not the pino logger; inject a logger — owner: P0-12 gate
- [ ] (P0-08b) Console must strip the invite token from the URL (`history.replaceState`) and send `Referrer-Policy: no-referrer` — owner: P0-10 console
- [ ] (P0-08b) `listMembers` aggregates roles before LIMIT; page memberships in a CTE first, then join roles (EXPLAIN) — owner: P0-12 gate
- [ ] (P0-08b) Last-owner rule is enforced only under the advisory lock; any future suspend/remove path must take it (or add a constraint trigger) — owner: P1 member lifecycle
- [ ] (P0-08b) Missing DB tests: invite cursor page 2, concurrent accept/revoke, concurrent last-owner demotions; `replaceRoleGrants` bumps the version twice (DELETE+INSERT) — owner: P0-12 gate
- [ ] (P0-08b) Sign-up timing differs for new vs existing email (extra writes); add a timing assertion or constant-time padding — owner: P1-15
- [ ] (P0-08b) `scripts/seed-demo.mts` is linted but not type-checked (no root tsconfig); add `scripts/tsconfig.json` — owner: P0-12 gate
- [ ] (P0-08b) Flakes under full parallel `pnpm check`: e2e sign-up 503 `RATE_LIMIT_UNAVAILABLE` (200 ms Redis timeout), tenancy container "Health check not healthy after 120000ms" — owner: P0-12 gate
- [ ] (P1-01a) Heartbeat retention (90 days): monthly partitions or a per-tenant prune; missed-heartbeat job emits `devices.heartbeat.missed` — owner: P1-14
- [ ] (P1-01b) Ship each operator's offline PIN verifier in the signed policy snapshot; rotate on PIN change — owner: P1-06
- [ ] (P1-02a) Categories have no `version` (rename is last-writer-wins; tree writes are serialised per tenant) — owner: P1-13a console
- [ ] (P1-02a) `updatedSince` pages sort matches by id; switch to an `(updated_at, id)` keyset if change feeds get large — owner: P1-06
- [ ] (P1-02b) FTS leg of a no-match prefix query ("coka:* & cola:*") plans a parallel seq scan (~18 ms at 100k); force the GIN path or skip FTS when the trigram leg suffices — owner: P1-16 perf pass
- [ ] (P1-01a) Console screens for devices (codes, QR, list, suspend/revoke) — owner: P1-13b
- [ ] (P0-11) Push Sahan `feat/wise-biz-upstream`, release email-kit 0.6.0, then switch `@wise-biz/mailer` to `createGenericSmtpProvider` and drop its own nodemailer path — owner: P1-15
- [ ] (P0-11) auth-kit scoped RBAC/ID injection, media-kit tenant prefix + quota hook, ai-core budget/audit hooks: do when wise-biz first consumes those packages — owner: P1 media step / P2 AI step
- [x] (P0-08b) Upstream gaps found in Sahan packages (auth-kit IDs, Upstash limiter, Next peers, WebAuthn UV, email-kit generic SMTP) — see `docs/research/sahan-packages.md` #15–20 — owner: P0-11

## Decisions taken during build

<!-- - 2026-10-20 P0-04: money as safe-integer number in TS (ADR 0005 addendum) -->
- 2026-10-23 P0-09a: styling system and theme engine (ADR 0011); per-store light/dark mode availability with per-mode customization (user)
- 2026-10-22 P0-08b: tenancy privilege ceiling — only owners edit roles/grants or touch owner members; non-owners with `tenancy:manage` assign only roles they hold (security review HIGH)
- 2026-10-22 P0-08b: invite tokens are HMAC-derived from (tenant, invite) and never stored (user approved)
- 2026-10-19 P0-01: internal packages ship TS source, Node 24 type stripping, `erasableSyntaxOnly`; toolchain pins (ADR 0008)
