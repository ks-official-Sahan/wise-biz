# ADR 0011: Styling system and theme engine

Status: accepted · 2026-10-22

(Numbered 0011: ADR 0010, tenancy store and auth engine, lives on the P0-08 branch.)

## Context
One design system serves the POS (Expo: Android, iOS, web via react-native-web), the Electron terminal (Expo web
export) and widgets in the Next.js console. Every store brands it from one color, and each store chooses light only,
dark only, or both modes with a runtime toggle and separate light and dark customizations. Tenant switches happen at
sign-in or store switch and must re-render in under 100 ms. The checkout path runs on low-end Android. Text contrast
must meet WCAG 2.2 AA for every generated or customized theme.

## Decision
- **Styling: plain `StyleSheet` + tokens through React context.** No styling library. Styles are created once per
  theme id and cached; the theme value context is split from the mode/toggle context so a toggle re-renders only
  themed consumers. The console and storefront consume the same tokens as CSS custom properties.
- **Palette generation: `@material/material-color-utilities` (HCT).** Tonal palettes from one brand seed (Google's
  dynamic color engine; Apache-2.0, no runtime dependencies). HCT tone equals L\*, so tone gaps map predictably to
  contrast. Neutrals are a low-chroma palette on the brand hue. Status colors (danger, warning, success, info) come
  from fixed seeds and are not brandable.
- **Contrast: own WCAG 2.2 checker** (relative luminance with the 0.04045 linearization threshold, ratio
  `(L1 + 0.05) / (L2 + 0.05)`). The generator picks tones that pass for any seed; tenant overrides that fail are
  reported with the nearest passing tone from the same palette. APCA is not used (not normative).
- **Tokens: DTCG 2025.10.** Three tiers (primitive, semantic, component). Color values use the DTCG color object
  (`colorSpace`, `components`, `hex`). Light and dark are contexts of a `theme` modifier (DTCG resolver module).
  Tenants edit only the seed, fonts, density and a short list of semantic overrides per mode; component tokens are
  derived.
- **Modes per store:** `modes.available` is `["light"]`, `["dark"]` or both, with `modes.default`. The toggle exists
  only when both are available. Resolution order: platform default, tenant, branch override, terminal (density,
  left-handed).
- **Compilers:** CSS custom properties, a frozen RN theme object, and receipt settings (monochrome, ESC/POS-safe).

## Why not
- Unistyles 3: fastest native path (C++ shadow tree, no re-render), but needs its Babel plugin and its web/SSR story
  is weak for the console. Revisit if the < 100 ms switch fails on low-end Android.
- Tamagui: best web parity, but the heaviest runtime and an optimizing compiler to maintain.
- NativeWind: v5 is a release candidate and brings Tailwind 4 + PostCSS into the native build.
- Own OKLCH ramp code or culori: a lightness ramp does not by itself guarantee contrast pairs; MCU's tone model and
  contrast utilities are the established approach, and culori adds 1.1 MB for conversions we do not need.

## Consequences
- MCU is about 1 MB unpacked (tree-shakeable). Terminals should receive precompiled themes from the theming module
  instead of generating them at runtime (follow-up when theming publishing lands).
- A theme is a pure function of its input: same input, same output, testable with property tests over random seeds.
