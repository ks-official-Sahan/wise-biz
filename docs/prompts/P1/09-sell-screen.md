# P1-09 · Sell screen

Effort: **H** · Needs: P1-07, P1-08 · Gate: confirm UI direction (screenshots at 3 widths before wiring logic)
Read: `docs/design/ux.md` (Checkout flow, Layouts), `docs/architecture/performance.md` (Checkout budgets, Client rules), `docs/features/payments-hardware.md` (Barcodes, Keyboard and touch), `docs/research/pos-market.md` (findings 1, 4)
Libraries: FlashList, camera barcode scanning (expo-camera or VisionCamera + ML Kit; choose by perf), `@wise-biz/pricing-engine`, `@wise-biz/sync`, `@wise-biz/ui`
Skills: `impeccable`, `emil-design-eng`, `design-taste-frontend`, `ux-principles`, `mobile-design`, `vercel-react-native-skills`, `ecc:latency-critical-systems`, `accessibility-audit`

## Goal
The fastest, calmest checkout screen we can build: a 10-item sale in ≤ 30 s, scan to visible line ≤ 50 ms p95, no network on the hot path.

## Scope
1. Scan pipeline: HID keyboard-wedge detection by inter-key timing (< 30 ms), global capture anywhere on the screen; camera scan sheet; GS1/EAN custom-2x parsing via `@wise-biz/barcode` (create the package here with parsers + tests); lookup via in-memory map; unknown code → inline "Add quick item / Search".
2. Search: local FTS, debounce 120 ms, cancel stale, keyboard navigation, results virtualized.
3. Quick keys / favorites grid (per terminal layout), category tabs.
4. Cart: merge same SKU, qty/weight entry (keypad, scale input later), line discount (permission; over limit → supervisor PIN override sheet), remove/decrease after the 5 s undo window → override, notes per line and per sale, customer attach placeholder (F4).
5. Totals: incremental pricing on each change (≤ 16 ms budget), tax summary, big total with tabular numerals.
6. Park / resume (multiple carts per terminal), cart drafts persisted (debounced 150 ms) with TTL rules.
7. Keyboard map from payments-hardware.md; command palette on tablet/desktop.
8. Customer display state publisher (local event stream; consumed in P1-12).
9. Instrumentation: scan→line and add→totals timings sampled to local metrics; dev overlay.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-ui-builder (sonnet) | `apps/pos/src/features/sell/ui/**` | Layouts (phone/tablet/desktop) first → screenshots for the gate; then components |
| 2 | wb-builder (sonnet) | `apps/pos/src/features/sell/model/**`, `packages/barcode/**` | Items 1–2, 4–6 logic, selectors, scan pipeline |
| 3 | wb-builder (sonnet) | `apps/pos/src/features/overrides/**` | Supervisor PIN override flow (shared for later steps) |
| 4 | wb-tester (haiku) | Maestro + Playwright web flows, `packages/barcode/test/**` | 10-item sale timing, override, park/resume, unknown barcode |

## Acceptance
- Maestro timed flow: 10 scanned items to pay screen ≤ 30 s including operator taps on mid-range Android; scan→line p95 ≤ 50 ms from instrumentation over 500 scans.
- Works fully in airplane mode.
- Line removal after 5 s without permission → override sheet; approval recorded locally for the command payload.
- `accessibility-audit` (web build) no serious issues; screen reader labels on every control (spot check TalkBack/VoiceOver).
- Screenshots at 390/834/1440 committed; design review notes addressed.

## Review
`ecc:react-reviewer`, `ecc:performance-optimizer`, `ecc:a11y-architect`, `design-review` skill
