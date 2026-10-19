# P1-12 · Desktop (Electron) + hardware bridge

Effort: **H** · Needs: P1-10 · Gate: confirm plan
Read: `docs/adr/0002-expo-plus-electron.md`, `docs/features/payments-hardware.md` (Hardware support table), `docs/architecture/offline-sync.md` (Electron row), `docs/architecture/security.md` (Devices)
Libraries: Electron (current), electron-builder, electron-updater, better-sqlite3 (rebuild for Electron ABI), `usb`/`serialport` (node), Electron `safeStorage`
Skills: `ecc:security-review`, `ecc:windows-desktop-e2e`, `ecc:latency-critical-systems`

## Goal
A desktop terminal for Windows, macOS, and Linux that runs the same POS UI with first-class USB/serial/network hardware, a customer display, kiosk mode, and safe auto-updates.

## Scope
1. `apps/desktop`: main process loads the Expo web export (bundled, `file://` or custom protocol with COOP/COEP); security: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, navigation and `window.open` locked, IPC channel allowlist.
2. Typed preload bridge exposing `@wise-biz/hardware` ports and a `StorageAdapter` (better-sqlite3 in main, single writer) and `KeyStore` (key encrypted with `safeStorage`).
3. Hardware in main: USB and serial ESC/POS printers, network printers, drawer kick, HID scanner pass-through, scale over serial (one protocol), device discovery UI.
4. Customer display: second `BrowserWindow` on a chosen screen subscribing to cart state over IPC.
5. Kiosk/terminal mode (fullscreen, disable shortcuts that exit, admin escape with supervisor PIN).
6. Auto-update via electron-updater with channels (`staging`, `production`); signing config placeholders (Windows cert, Apple notarization) documented.
7. Packaging: NSIS (Windows), dmg (macOS), AppImage + deb (Linux).

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Electron security checklist (current), better-sqlite3 + electron-rebuild, usb/serialport status |
| 2 | wb-builder (sonnet) | `apps/desktop/src/main/**`, `src/preload/**` | Items 1–3, 5 |
| 3 | wb-ui-builder (sonnet) | `apps/desktop/src/customer-display/**`, device discovery screen in `apps/pos` (desktop-only route) | Item 4 + discovery UI |
| 4 | wb-scaffolder (haiku) | `apps/desktop/electron-builder.*`, update config | Items 6–7 |
| 5 | wb-tester (haiku) | `apps/desktop/e2e/**` (Playwright Electron) | Launch, sell, print to a virtual printer (TCP listener capturing bytes) |

## Acceptance
- Builds for all three OSes in CI (P1-15 wires the workflow; here run locally or in a matrix branch).
- Electron security: `@electron/fuses` or checklist items verified; `ecc:security-reviewer` clean.
- Sale on desktop prints to the virtual printer with bytes equal to the receipt snapshot; drawer kick sent.
- Customer display mirrors cart within 50 ms.
- Offline sale + sync identical to mobile behavior (shared chaos suite run with better-sqlite3 adapter).

## Review
`ecc:security-reviewer`, `ecc:typescript-reviewer`
