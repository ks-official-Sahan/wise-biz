# Progress

Updated by the orchestrator at the end of every step (`/wb-step`, protocol step 10). Keep entries to one line plus follow-ups.

Legend: ⬜ todo · 🟡 in progress · ✅ done · ⛔ blocked

## P0 — Foundations

| Step | Status | Date | Commit | Notes / deviations |
|---|---|---|---|---|
| P0-01 Monorepo | ✅ | 2026-10-19 | 6c6d7e8 | Branch `cc/gracious-allen-044iq6` (harness) not `step/P0-01`. TS 6.0.3 not 7 (typescript-eslint <6.1). No eslint-plugin-react/jsx-a11y (no ESLint 10 support). Packages ship TS source (ADR 0008). Prose `.md` excluded from Prettier. Added `apps/ modules/ services/.gitkeep`, rule `modules-not-to-apps`, root `lint:root` task. |
| P0-02 Local infra + env | ✅ | 2026-10-19 | 05f2d35 | MinIO images unpublished → RustFS 1.0.3 (S3 API) + aws-cli `storage-init` (profile `init`, run after `up --wait`, which fails on exited one-shots). Check script runs on plain `node` (no tsx). `env:check` added to `pnpm check`. Prod rejects `.env.example` placeholder secrets. Up ≈8 s. |
| P0-03 CI baseline | ✅ | 2026-10-19 | bff48fa | Local: actionlint, audit, licenses, gitleaks, renovate-validator green. Awaiting first CI run (workflows trigger on PR / push to `master` only). Default branch is `master`, not `main`. gitleaks + actionlint as checksum-verified binaries (gitleaks-action needs an org license). GHSA-vfj7-8cjw-p6xm (braces, no patch, lint-only path) ignored in `auditConfig`. caniuse-lite CC-BY-4.0 allowed as reviewed exception. |
| P0-04 Core packages | ✅ | 2026-10-19 | 416c081 | Single step (user chose over 04a/04b split). Own uuidv7 (no `uuid` dep), counter overflow advances a virtual ms. Money/Currency/Uuid7 branded; contracts parse to branded values. Per-document tax keeps line signs. JSON Schema generated with `io: "input"` (transforms). Heavy suites get explicit timeouts (parallel turbo + coverage). Coverage ids 100%/94% br, money 100%/93% br. |
| P0-05 Crypto, policy, audit-chain | ⬜ | | | |
| P0-06 API, DB, RLS | ⬜ | | | |
| P0-07 Outbox, idempotency, audit | ⬜ | | | |
| P0-08 Identity + tenancy | ⬜ | | | |
| P0-09 Design system | ⬜ | | | |
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

## Follow-ups

<!-- - [ ] (P0-04) example: add GS1 exponent edge cases — owner: next step that touches money -->
- [ ] (P0-01) `prepare: lefthook install` fails without `.git` (Docker/CI): set `LEFTHOOK=0` or guard it — owner: P0-02/P0-03
- [ ] (P0-01) Lefthook `stage_fixed` with partially staged files: confirm unstaged hunks are not staged — owner: P0-03
- [ ] (P0-01) `deps:graph` pipe has no pipefail — owner: P0-03
- [ ] (P0-01) Remove `minimumReleaseAgeExclude` (commitlint 21.2.4) from `pnpm-workspace.yaml` after 2026-10-21 — owner: next step touching deps
- [ ] (P0-02) `assertProductionEnv` skips everything when NODE_ENV is unset/misspelled: call it at API startup with the resolved env and test the call — owner: P0-06
- [ ] (P0-02) Length/placeholder checks cover `*_SECRET` (+ placeholder on `*_KEY`/`*_PASSWORD`); list prod-sensitive keys explicitly (API keys, DB passwords) — owner: P0-06
- [ ] (P0-02) Dev storage creds duplicated in compose.yaml and .env.example; `db:psql` puts dev password in argv (dev-only) — owner: P0-03
- [ ] (P0-03) CI guard: fail if any shipped app/package lists `@wise-biz/config` under `dependencies` (keeps the braces GHSA ignore valid) — owner: P0-06
- [ ] (P0-03) Remove `GHSA-vfj7-8cjw-p6xm` ignore once braces ships a fix — owner: Renovate eslint group PR
- [ ] (P0-04) `pageOf()` needs a `.meta` id when OpenAPI generation lands; registry `defineEvent` throws on double module evaluation (HMR) — owner: P0-06
- [ ] (P0-04) `Timestamp` accepts year 0000 / 9-digit fractions; `format()` output with symbol does not round-trip through `parse()` (by design, documented) — owner: next step touching contracts/money
- [ ] (P0-04) ISO 4217: confirm XAD (Arab Accounting Dinar) status and add if active — owner: next step touching money
- [ ] (P0-01) Add jsx-a11y / RN a11y lint once a plugin supports ESLint 10 — owner: P0-09

## Decisions taken during build

<!-- - 2026-10-20 P0-04: money as safe-integer number in TS (ADR 0005 addendum) -->
- 2026-10-19 P0-01: internal packages ship TS source, Node 24 type stripping, `erasableSyntaxOnly`; toolchain pins (ADR 0008)
