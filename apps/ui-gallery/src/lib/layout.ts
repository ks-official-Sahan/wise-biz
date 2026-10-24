/** Sell screen layout by width, per docs/design/ux.md. Breakpoints in dp / CSS px. */
export type SellLayoutKind = "phone" | "tablet" | "desktop";

export interface SellLayout {
  readonly kind: SellLayoutKind;
  readonly gridColumns: number;
}

export function sellLayoutFor(width: number): SellLayout {
  if (width < 600) return { kind: "phone", gridColumns: 2 };
  if (width < 900) return { kind: "tablet", gridColumns: 3 };
  if (width < 1280) return { kind: "desktop", gridColumns: 3 };
  return { kind: "desktop", gridColumns: 4 };
}
