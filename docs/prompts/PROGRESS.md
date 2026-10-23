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
| P0-08 Identity + tenancy | ⬜ | | | |
| P0-09 Design system | 🟡 | 2026-10-23 | 43f15de (09a) | Split 09a/09b (user). ADR 0011: plain StyleSheet + context (no styling lib), Material Color Utilities (HCT) palettes, own WCAG 2.2 checker, DTCG 2025.10 tokens with light/dark as a theme modifier. Per store: light only, dark only, or both (toggle + per-mode seed and accent/canvas/surface overrides); status/text not brandable. Platform default teal "Counter" light + amber "Workshop" dark. **09a ✅** `@wise-biz/theme`: zod schema, palettes, guarantee step (any seed passes AA, property-tested 300 seeds), validator with suggestions, resolve (platform → tenant → branch → terminal, memo keyed by canonical input), compilers (CSS vars, RN object, receipt, DTCG). MCU 0.4.0 patched (`patches/`) to load on plain Node ESM. Design rules distilled from the design skills into `docs/design/ui-principles.md`. Review: 1 HIGH fixed (memo keyed by forgeable hash). **09b ⬜** ui + gallery + visual tests. |
| P0-10 Console shell | ⬜ | | | |
| P0-11 Upstream Sahan packages | ⬜ | | | |
| P0-12 Gate | ⬜ | | | |

## P1 — Sell and stock, offline

| Step | Status | Date | Commit | Notes / deviations |
|---|---|---|---|---|
| P1-01 Devices | ⬜ | | | |
| P1-02 Catalog + search | ⬜ | | | |
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

- Next step: `/wb-step docs/prompts/P0/08-identity-tenancy.md` (gate step; ask single vs split first).
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
- [ ] (P0-06b) Auth is a dev-header placeholder (API_DEV_AUTH, development/test only); real sessions, devices and tenant membership — owner: P0-08
- [ ] (P0-06b) `main.ts`/OTel bootstrap lack direct unit tests (covered by the listening-server integration test only) — owner: P0-12 gate
- [ ] (P0-07a) Multiple relays publish out of per-key order (SKIP LOCKED); partition relays by hash(key) or rely on Kafka partitioning when the Kafka adapter lands — owner: P2 Kafka adapter
- [ ] (P0-07b) Load smoke: re-run `pnpm load:template` (1,000 req/s, 30 s, p95 < 50 ms) on a laptop/perf box with ≥ 2 API replicas; this 4-core container topped out at ~575 req/s — owner: P0-12 gate
- [ ] (P0-07b) Sign daily audit anchors (Ed25519) and export to WORM storage; wb_chainer can currently insert future anchors — owner: P1-15
- [ ] (P0-07b) Audit retention: verify-chained-and-anchored → export → DETACH PARTITION CONCURRENTLY → drop; PII redaction/crypto-shredding policy for before/after — owner: P1-14
- [ ] (P0-07b) HMAC Redis idempotency cache values; partition idempotency_keys by expires_at if volume requires — owner: P1-15
- [ ] (P0-07b) API metrics sink (startServer hooks.onMetric) not wired; workers log metrics every 60 s pending OTel export — owner: P0-12 gate
- [ ] (P0-07b) module-audit tests failed twice under full parallel load right after heavy Docker activity, then passed 5 cold runs; capture output if it recurs — owner: P0-12 gate
- [ ] (P0-01) Add jsx-a11y / RN a11y lint once a plugin supports ESLint 10 — owner: P0-09
- [ ] (P0-09a) Contrast pairs cover semantic tokens only; add component-state pairs (chip selected, keypad, pressed states) — owner: P0-09b
- [ ] (P0-09a) Property test does not generate overrides or tenant/branch layering; extend and assert suggestions pass — owner: P0-09b
- [ ] (P0-09a) `toDtcg` returns `{ tokens, resolver }`; emit separate token set files plus a top-level 2025.10 resolver document when theming publishing lands — owner: P1 theming module
- [ ] (P0-09a) `resolveTheme` does not reject failing overrides (editor needs a preview); publishing must call `validateTheme` and refuse issues — owner: P1 theming module
- [ ] (P0-09a) Terminals should receive precompiled themes (MCU ~1 MB unpacked stays out of the POS bundle); regenerate the MCU patch on upgrade — owner: P1 theming module
- [ ] (P0-09a) Theme perf test is wall-clock (< 20 ms median); watch for CI flakes — owner: P0-12 gate

## Decisions taken during build

<!-- - 2026-10-20 P0-04: money as safe-integer number in TS (ADR 0005 addendum) -->
- 2026-10-23 P0-09a: styling system and theme engine (ADR 0011); per-store light/dark mode availability with per-mode customization (user)
- 2026-10-19 P0-01: internal packages ship TS source, Node 24 type stripping, `erasableSyntaxOnly`; toolchain pins (ADR 0008)
