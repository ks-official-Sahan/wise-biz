# P0-09 · Design system foundation: `@wise-biz/theme` + `@wise-biz/ui`

Effort: **H** · Needs: P0-04 · Gate: confirm plan + pick visual direction
Read: `docs/design/theming.md`, `docs/design/ux.md` (Design direction, Layouts), `docs/adr/0002-expo-plus-electron.md`
Libraries: W3C Design Tokens (DTCG) format, OKLCH color math (culori or similar), React Native + react-native-web, styling system candidates (NativeWind, Tamagui, Unistyles, plain StyleSheet + tokens), Expo (for the gallery app), Tabler icons
Skills: `impeccable`, `emil-design-eng`, `design-taste-frontend`, `ecc:design-system`, `ux-principles`, `accessibility-audit`, `frontend-design`, `ponytail`

## Goal
A token pipeline any tenant can brand safely, and a small set of accessible, fast, cross-platform components that the POS app, desktop, and console widgets share.

## Decision first (gate)
ADR 0010 "Styling system": compare at most 3 options on RN + web parity, runtime cost on low-end Android, theming at runtime (tenant switch without rebuild), Next.js compatibility, maturity. Recommend one. Also present **2 visual directions** (calm-minimal vs. bold-industrial) as screenshots of the gallery sell-screen mock (phone + desktop). Wait for my pick.

## Scope
1. `@wise-biz/theme`:
   - DTCG token schema (zod), 3 tiers (primitive → semantic → component), locked semantic status colors.
   - Tonal scale generator from one brand color (OKLCH), light + dark.
   - Contrast validator (WCAG 2.2 AA; AA-large for totals) with fix suggestions.
   - Compilers: CSS custom properties, RN theme object, receipt settings.
   - Default platform theme.
2. `@wise-biz/ui` (RN primitives, render on web via react-native-web): Text (tabular numerals variant), Button, IconButton, TextField, SearchField (debounced), NumberPad, QuantityStepper, Sheet, Dialog, Toast, Badge, Chip, Card, ListRow, Tabs, Skeleton, Divider, StatusDot, MoneyText (uses `@wise-biz/money` format). Every component: a11y role/label props required by types, focus ring, min target sizes, reduced motion.
3. `apps/ui-gallery` (Expo, web + native): every component in light/dark, 3 sample tenant themes, a static sell-screen mock at phone/tablet/desktop widths.
4. Visual regression: Playwright screenshots of the gallery web build at 390/834/1440 px.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Styling options facts (versions, RN new architecture support, web support) |
| 2 | wb-builder (sonnet) | `packages/theme/**` | Item 1 with tests |
| 3 | wb-ui-builder (sonnet) | `packages/ui/**` | Item 2 (after ADR 0010 decided) |
| 4 | wb-ui-builder (sonnet) | `apps/ui-gallery/**` | Item 3 + 2 visual directions |
| 5 | wb-tester (haiku) | `apps/ui-gallery/e2e/**` | Item 4 |

## Acceptance
- Theme tests: generated palettes pass AA for all text pairs; a failing brand color gets an adjusted suggestion.
- Gallery runs on web (`pnpm -F ui-gallery web`) and Android emulator/device.
- `accessibility-audit` on gallery web: no serious/critical issues; axe in Playwright passes.
- Switching tenant theme at runtime re-renders without reload in < 100 ms (measure).
- Screenshots committed under `apps/ui-gallery/e2e/__screenshots__`.

## Review
`ecc:react-reviewer`, `ecc:a11y-architect`, `design-review` skill pass by orchestrator
