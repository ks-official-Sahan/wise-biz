# ADR 0002: Expo for mobile/web, Electron for desktop

Status: accepted · 2026-10-18

## Context
Targets: Android, iOS, tablets, web, Windows, macOS, Linux (HarmonyOS later). Desktop terminals need reliable USB/serial/HID hardware, kiosk mode, auto-update. Options: Expo only (react-native-windows/macos), Electron only, Tauri, Expo + Electron.

## Decision
- `apps/pos`: Expo (React Native + Expo Router) for Android, iOS, and web (react-native-web).
- `apps/desktop`: Electron loads the Expo web export; the main process provides a hardware bridge (`@pos/hardware` over IPC) and SQLite (better-sqlite3).
- Shared UI in `@pos/ui`, shared logic in packages; platform code behind ports.

## Why not
- react-native-windows/macos: no Linux; smaller ecosystem for POS peripherals.
- Tauri: smaller footprint, but Rust-side hardware work and webview differences per OS add risk; revisit if Electron size becomes a problem.

## Consequences
- One React codebase for the sell screen across every platform.
- Web build must satisfy COOP/COEP for expo-sqlite web; web terminals are secondary (limited hardware).
- Two packaging pipelines (EAS, electron-builder).
