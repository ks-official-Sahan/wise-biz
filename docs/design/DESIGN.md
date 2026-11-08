---
version: alpha
name: wise-biz
description: "Product UI for a multi-tenant POS and its management console. Neutral, low-chroma surfaces on the tenant brand hue, one restrained accent, depth from surface steps and a single hairline, tabular numerals for money. Light by default, dark for evening shifts."
register: product
dials: { variance: 3, motion: 2, density: 6 }

typography:
  family: { body: Geist, numeric: "Geist Mono" }
  weights: { regular: 400, medium: 500 }
  size: { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, 2xl: 32, 3xl: 40, 4xl: 48 }
  lineHeight: { heading: 1.25, body: 1.5 }
  money: { fontFeature: tnum, letterSpacing: 0 }
  total: { compact: 32, comfortable: 48 }

rounded: { control: 8, card: 12, pill: 999 }
spacing: [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]
target: { min: 48, minPointer: 24, gap: 8 }
control: { compact: { control: 44, key: 48 }, comfortable: { control: 52, key: 56 } }
motion: { press: 140, enter: 220, exit: 160, easeOut: [0.23, 1, 0.32, 1], easeSheet: [0.32, 0.72, 0, 1] }
---

# DESIGN.md: wise-biz

Distilled reference for agents building UI. It does not replace `docs/design/ui-principles.md` (binding build rules),
`docs/design/theming.md` (tenant theming) or ADR 0011 (engine). Where this file and those disagree, they win.
Token names and numbers match `packages/theme/src/scales.ts` and `defaults.ts`. Read the screen layouts in
`docs/design/ux.md`.

## Overview

A cashier under store light, scanning fast, queue waiting. An owner on a phone in the back office. Speed and
legibility beat decoration. The sell screen is product UI, not a landing page: no hero bands, gradients, scroll
reveals or bento grids.

## Colors

Colors are generated, never hand-picked per screen (HCT tonal palettes from the tenant brand seed, ADR 0011). Use
semantic roles only, never hex in components.

| Role | Light tone | Dark tone | Use |
|---|---|---|---|
| `canvas` | neutral 98 | neutral 6 | App background |
| `surface` | neutral 99 | neutral 10 | Cards, sheets, inputs, tables |
| `surfaceRaised` | neutral 99 | neutral 17 | Keypad keys, hovered or selected rows |
| `surfaceSunken` | neutral 95 | neutral 4 | Chips, wells, pressed secondary |
| `border` / `borderStrong` | variant 87 / 50 | variant 30 / 60 | Hairline / input and control edges |
| `text` / `textMuted` | neutral 10 / variant 30 | neutral 92 / variant 80 | Body / secondary |
| `accent`, `accentPressed`, `accentSubtle`, `accentText` | brand 40, 30, 92, 40 | brand 80, 75, 25, 80 | Primary action, selection, focus |
| `danger`, `warning`, `success`, `info` (+ `Subtle`, `Text`) | locked seeds | locked seeds | Status. Never brandable |

Rules:
- Hierarchy comes from the surface ladder (`surfaceSunken` < `canvas` < `surface` < `surfaceRaised` in dark; steps
  are tone gaps). Do not skip steps. In light, `surface` and `surfaceRaised` share a tone, so separate them with
  the hairline.
- Brand color covers at most about 10% of a screen: primary action, selection, focus ring. Cart, totals and tables
  stay neutral.
- Status is never color alone: add an icon or text. Body text 4.5:1, large text and totals 3:1, input borders and
  focus ring 3:1.
- No pure `#000` or `#fff`, no cream, sand or beige body background.

## Typography

One family, two weights (400, 500), plus a numeric face.

| Style | Size | Weight | Notes |
|---|---|---|---|
| `total` | 32 compact, 48 comfortable | 500 | Cart total. Numeric face, `tnum` |
| `title` | 24 | 500 | Screen and sheet titles |
| `heading` | 20 | 500 | Section heading |
| `body` | 16 | 400 | Default |
| `body-sm` | 14 | 400 | Tables, helper text, dense console rows |
| `label` | 14 | 500 | Buttons, form labels, column headers |
| `caption` | 12 | 400 | Meta, timestamps. 4.5:1 minimum |

- Money, quantities, SKUs and any column of numbers: numeric face or `tnum`, right-aligned, never letter-spaced.
- Sentence case. Uppercase only for short badges.
- Proposal, not yet in `@wise-biz/theme`: tighten tracking only on text at 32 px and above (about -0.02em). Body,
  tables and money stay at 0.

## Layout and spacing

Spacing steps: 4, 8, 12, 16, 24, 32, 48 cover almost everything (full scale in the frontmatter). Minimum 8 between
adjacent targets. Targets 48 dp (44 pt iOS), 24 px CSS minimum on pointer devices. Console tables and forms may use
32 to 40 px controls on pointer devices; POS and phone controls follow `control` by density.

## Elevation and depth

| Level | Treatment | Use |
|---|---|---|
| 0 | `canvas`, no border | Page |
| 1 | `surface` + 1 px `border` | Cards, tables, inputs |
| 2 | `surfaceRaised` + 1 px `border` | Keypad keys, hovered rows, menus |
| 3 | Tinted shadow, at most 8 px blur, no border | Dialog and sheet only |
| Focus | 2 px `focusRing`, offset 2 px | Every interactive element |

No drop shadows on cards. Never a shadow and a border on the same element.

## Shapes

Controls 8, cards and sheets 12, pills full. Never above 16 on a card. Buttons are 8 px controls, not pills:
pills are for chips, badges and filters.

## Components

Maps to `packages/theme/src/component.ts`.

- **Button.** `primary` (accent), `secondary` (surface + `borderStrong`), `ghost` (`accentText`), `danger`. Label is
  verb plus object ("Pay LKR 1,403.00"). One primary per view. Pressed: scale 0.97 over 140 ms.
- **Input.** `surface`, `borderStrong`, focus swaps border to `focusRing`. Label above, error text below with an icon.
  Placeholder is `textMuted` and never the label.
- **Keypad key.** `surfaceRaised`, `control.key` tall, numeric face. No animation on key input.
- **Cart.** Neutral surface. Line rows 1 px `border` dividers, quantity and price right-aligned in `tnum`, total in
  `total` style. Totals never wait on the network.
- **Table (console).** Header `label` in `textMuted`, sentence case, 1 px `border` row dividers, numeric columns
  right-aligned. Virtualized rows with stable keys. Skeleton matches the final shape.
- **Chip and badge.** Pills. Badge uses status `Subtle` bg + `Text` fg and carries text or an icon.
- **Toast.** Inverse (`text` bg, `surface` fg). 200 to 250 ms enter, faster exit.
- **Sheets and dialogs.** Level 3. Enter 220 ms with `easeSheet`. Focus trapped, Escape closes.
- **States.** Every data view ships loading, empty (what to do next), error (what happened, retry) and offline.

## Motion

Never animate scan, add line, quantity or tender keys. Allowed: press feedback, sheet and dialog enter, toast,
payment success (at most 200 ms). Transform and opacity only. Reduced motion replaces movement with a short fade
or nothing. Never ease-in.

## Do

- Reach for a role token, then a scale token, then ask. No new raw values.
- Keep data surfaces neutral and let one accent carry the action.
- Check light and dark, reduced motion, and 4.5:1 text contrast before merging.

## Don't

- No gradients, gradient text, glassmorphism, side-stripe accent borders, nested cards, identical card grids as a
  default, or decorative status dots.
- No weights above 500, no all-caps sentences, no em dashes in UI copy, no "please", "successfully" or "!".
- Do not copy a reference brand's hex, font or logo. Tenants own the brand; this file owns structure.

## Provenance

Distilled on 2026-11-08 from three public design-analysis files in
[VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT). They analyze marketing sites,
so only product-UI structure was kept. No colors, fonts or marks were copied.

| Source | Adopted | Rejected |
|---|---|---|
| `vercel` | Neutral low-chroma palette, hairline-first borders, Geist + Geist Mono pairing, 6 to 8 px control radius family | Mesh gradients, 600 display weight, pill buttons, uppercase mono table headers |
| `linear.app` | Stepped surface ladder plus hairline for depth, single restrained accent for brand mark, CTA and focus, 8 px button corners, no shadows on dark | Near-black `#010102` canvas (we use neutral tone 6), marketing screenshot framing, 600 display weight |
| `stripe` | Tabular figures (`tnum`) for money and numeric tables, tight corner radii, light fintech cards on near-white | Thin 300 weights, gradient mesh, cream canvas, `ss01` stylistic set |
