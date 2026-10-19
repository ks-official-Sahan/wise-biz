# Progress

Updated by the orchestrator at the end of every step (`/wb-step`, protocol step 10). Keep entries to one line plus follow-ups.

Legend: ⬜ todo · 🟡 in progress · ✅ done · ⛔ blocked

## P0 — Foundations

| Step | Status | Date | Commit | Notes / deviations |
|---|---|---|---|---|
| P0-01 Monorepo | ✅ | 2026-10-19 | 6c6d7e8 | Branch `cc/gracious-allen-044iq6` (harness) not `step/P0-01`. TS 6.0.3 not 7 (typescript-eslint <6.1). No eslint-plugin-react/jsx-a11y (no ESLint 10 support). Packages ship TS source (ADR 0008). Prose `.md` excluded from Prettier. Added `apps/ modules/ services/.gitkeep`, rule `modules-not-to-apps`, root `lint:root` task. |
| P0-02 Local infra + env | ⬜ | | | |
| P0-03 CI baseline | ⬜ | | | |
| P0-04 Core packages | ⬜ | | | |
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
- [ ] (P0-01) Add jsx-a11y / RN a11y lint once a plugin supports ESLint 10 — owner: P0-09

## Decisions taken during build

<!-- - 2026-10-20 P0-04: money as safe-integer number in TS (ADR 0005 addendum) -->
- 2026-10-19 P0-01: internal packages ship TS source, Node 24 type stripping, `erasableSyntaxOnly`; toolchain pins (ADR 0008)
