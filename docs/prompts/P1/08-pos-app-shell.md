# P1-08 · POS app shell (Expo)

Effort: **M** · Needs: P1-01, P0-09 (P1-07 for sync wiring; stub until done) · Gate: none
Read: `docs/adr/0002-expo-plus-electron.md`, `docs/design/ux.md` (Layouts by device class), `docs/architecture/offline-sync.md` (Device storage), `docs/architecture/security.md` (Devices)
Libraries: Expo SDK (current), Expo Router, expo-sqlite, expo-secure-store / Keychain/Keystore access for keys, expo-crypto, Redux Toolkit + redux-persist (or RTK listener + MMKV), TanStack Query, Sentry RN, i18n (expo-localization + a small i18n lib)
Skills: `vercel-react-native-skills`, `ecc:react-native-patterns`, `mobile-design`, `impeccable`

## Goal
An installable POS app on Android, iOS, and web that enrolls as a terminal, unlocks by PIN, loads the tenant's theme and data offline, and shows sync health, ready for the sell screen.

## Scope
1. `apps/pos`: Expo Router, dev client, app config for android/ios/web; web build served with COOP/COEP headers; Hermes.
2. Platform `KeyStore` (Ed25519 private key in secure storage; web: non-extractable WebCrypto key in IndexedDB flagged low-trust) and `StorageAdapter` from `@wise-biz/sync`.
3. Flows: first launch → enrollment (show code + QR, poll until approved) → bootstrap download with progress → operator PIN screen → home (sell placeholder).
4. State: Redux Toolkit slices `session`, `ui`, `cart` (normalized), persisted for UI/session only; server data via TanStack Query only for online lookups; local data via sync package hooks (`useLiveQuery`).
5. Theme: load compiled tenant theme from local DB; switch without reload.
6. Responsive shells per device class (phone, tablet portrait/landscape, desktop); left-handed mode.
7. Global sync status chip, offline banner, error boundary, Sentry with PII scrubbing; i18n-ready (English first; Sinhala and Tamil keys added later).
8. Run `@wise-biz/pricing-engine` determinism check and `@wise-biz/sync` perf on Hermes (dev screen); record numbers in PROGRESS.md.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Current Expo SDK: router, secure store, sqlite web headers, Hermes + crypto polyfills |
| 2 | wb-builder (sonnet) | `apps/pos/src/platform/**`, `src/state/**` | Items 2, 4, 8 |
| 3 | wb-ui-builder (sonnet) | `apps/pos/app/**`, `src/screens/**` | Items 1, 3, 5–7 |
| 4 | wb-tester (haiku) | `apps/pos/e2e/**` (Maestro) + web Playwright | Enrollment → PIN → home |

## Acceptance
- Android release build runs on a low-end device/emulator; cold start to PIN screen ≤ 2.5 s.
- Enrollment and PIN flows pass Maestro on Android and Playwright on web.
- Airplane mode after bootstrap: app opens, PIN works (offline verifier), data visible.
- Pricing determinism on Hermes matches Node output for the golden carts.

## Review
`ecc:react-reviewer`, `ecc:security-reviewer` (key storage), `ecc:a11y-architect`
