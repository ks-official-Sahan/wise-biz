# Theming and brand customization

Every tenant (and optionally each branch) brands the POS, console widgets, storefront, receipts, loyalty cards, and letterheads without code.

## Token model

W3C Design Tokens (DTCG JSON), three tiers:

```
primitive  → color.brand.500, font.family.display, radius.md
semantic   → color.surface, color.accent, color.danger, text.money.lg
component  → button.primary.bg, cart.total.size, keypad.key.height
```

Tenants edit **primitives and a few semantic overrides** only. Component tokens derive from them, so a tenant cannot break layouts.

```json
{
  "color": {
    "brand": { "$type": "color", "$value": "#0E7C66" },
    "accent": { "$type": "color", "$value": "{color.brand}" }
  },
  "font": {
    "display": { "$type": "fontFamily", "$value": "Poppins" },
    "body": { "$type": "fontFamily", "$value": "Inter" }
  },
  "radius": { "md": { "$type": "dimension", "$value": "10px" } },
  "density": { "$value": "comfortable" }
}
```

## Pipeline

`@wise-biz/theme`:
1. Validate (zod) → contrast check (WCAG AA for text pairs, AA large for totals) → auto-adjust suggestions if failing.
2. Generate tonal scale (OKLCH) from one brand color, light and dark variants.
3. Compile: CSS custom properties (console, storefront, POS web), RN theme object (POS native), ESC/POS-safe settings (logo bitmap dithered, header font size).
4. Version and publish → `theming.theme.published` → devices pull.

Theme resolution: platform default → tenant theme → branch override → terminal (density, left-handed only).

## Fonts

- Choose from a curated list (Google Fonts with OFL license, subsetted, self-hosted via media-kit/R2) or upload (owner confirms license; WOFF2 only; size limit).
- POS caches fonts offline. Fallback stack always defined; numeric font must have tabular figures.

## Assets

Logo (light/dark), favicon/app icon (white-label builds P3), receipt logo (monochrome), letterhead, loyalty card artwork, storefront hero. Uploaded through media-kit with validation (type, size, dimensions) and tenant folder prefix.

## Editors (console)

- Theme editor: live preview on POS sell screen, receipt, storefront card, loyalty card side by side; contrast warnings; reset to default.
- Receipt template editor: block list + preview (58/80 mm, A4), sample data.
- Loyalty card designer: templates (front/back), fields (name, number, QR/barcode, tier), export print-ready PDF and Apple/Google Wallet pass (P2).
- Letterhead builder: header/footer blocks or uploaded PDF background.

## Guard rails

- Danger, success, warning colors stay semantic (not brandable) so status meaning holds across stores.
- Minimum font sizes and target sizes are not tenant-editable.
- Theme changes are audited and can be rolled back to any previous version.
