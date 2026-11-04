# UI principles (design system build rules)

Binding for `@wise-biz/theme`, `@wise-biz/ui`, `apps/ui-gallery`, and every screen built on them. Distilled from
the design skills the team uses (impeccable, emil-design-eng, design-taste-frontend, high-end-visual-design,
platform-design, mobile-design, ux-principles, design-dna, bencium-innovative-ux-designer, agentic-ux-design,
ux-researcher, frontend-design). Where a marketing-oriented skill conflicts with the POS hot path, this file wins:
the sell screen is product UI, not a landing page. `docs/design/ux.md` keeps the layouts and checkout flow.

## Scene

A cashier at a counter under mixed store light (fluorescent, window glare), scanning fast while a queue waits, often
one-handed on a tablet or with a scanner. An owner checks the same app on a phone in the back office. Speed and
legibility beat decoration. Light is the default theme; dark ships for bars, restaurants and evening shifts.

## Register and dials

- Register: product (design serves the task). Marketing patterns (hero sections, scroll reveals, bento grids,
  double-bezel cards, eyebrow labels) are out of scope for app UI. The storefront may use them later.
- Dials: variance 3, motion 2 on the checkout path (4 elsewhere), density 6 on the sell screen, 4 in management.

## Color

- Perceptual color: palettes are generated in HCT (ADR 0011); hand-written colors use OKLCH. Neutrals are a
  low-chroma palette on the tenant brand hue, never a default warm or cool tint. No cream, sand or beige body
  backgrounds. No pure #000 or #fff.
- Restrained strategy: brand color on at most about 10% of the surface (primary action, selection, focus ring).
  Data surfaces (cart, totals, tables) stay neutral.
- Status colors (danger, warning, success, info) are locked semantic tokens, not brandable. Status is never
  conveyed by color alone: pair it with an icon or text.
- Contrast: body text and placeholders 4.5:1, large text and totals 3:1 minimum, non-text UI (borders of inputs,
  focus ring) 3:1. The theme validator enforces this and proposes the nearest passing color.

## Type

- One family in several weights plus a mono or tabular numeral face. Default platform pair: Geist + Geist Mono
  (OFL, self-hosted, tabular figures). Tenants pick from a curated OFL list; the numeric face must have tabular
  figures.
- Base 16 px, scale ratio at least 1.25 between steps, totals 32 to 48 px. Money always uses tabular numerals.
- Sentence case. No all-caps sentences; uppercase only for short badges.

## Shape and depth

- One radius scale: controls 8, cards and sheets 12, pills full. Never above 16 on cards.
- Depth from surface steps and a single hairline, not drop shadows. If a shadow is used (sheet, dialog), it is
  tinted and at most 8 px blur, never combined with a border on the same element.
- Banned: side-stripe accent borders, gradient text, glassmorphism as decoration, nested cards, identical card
  grids as a default, decorative status dots, em dashes in UI copy.

## Motion

- Never animate keyboard- or scanner-initiated actions (scan, add line, quantity keys, tender keys).
- Allowed: press feedback (scale 0.97, 120 to 160 ms), sheet and dialog enter (200 to 250 ms), toast, payment
  success (at most 200 ms on the checkout path). Exit faster than enter.
- Easing: strong ease-out `cubic-bezier(0.23, 1, 0.32, 1)` for enter and feedback; `cubic-bezier(0.32, 0.72, 0, 1)`
  for sheets. Never ease-in. Animate transform and opacity only; RN animations run on the native driver.
- Reduced motion: replace movement with a short opacity change or nothing.

## Touch, focus, platform

- Targets at least 48 dp (44 pt iOS, 24 px CSS minimum on pointer devices, 48 preferred). At least 8 px between
  adjacent targets. Primary actions (pay, tender) in the thumb zone on phones.
- Visible focus ring on every interactive element (2 px, brand color at 3:1, offset 2 px). Full keyboard flow on
  desktop terminals.
- Platform conventions for sheets, back navigation and pickers; one icon set (Tabler, stroke 1.75) with text labels
  on primary actions.
- Every interactive primitive requires an accessibility label and role by type. Lists use virtualized lists with
  memoized rows and stable keys.

## States and copy

- Every data view ships loading (skeleton matching the final shape), empty (what to do next), error (what happened,
  how to recover, retry) and offline states.
- Copy: verb plus object on buttons ("Pay LKR 1,403.00", "Void line"), plain language, no "please", no
  "successfully", no exclamation marks, no em dashes.

## Assistant surfaces (agentic UX)

- AI suggestions (reorder, anomalies, MCP answers) are labeled as suggestions, show their reason, and never act
  without an explicit confirm. The cashier's flow is never interrupted by them.

## Review gate

Before a UI change merges: contrast and target-size checks pass, axe has no serious or critical issues, reduced
motion verified, light and dark checked, and the screen passes the "would someone say AI made this" test.
