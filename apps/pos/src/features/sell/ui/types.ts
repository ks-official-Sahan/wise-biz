/** What the sell view needs to draw. The model (P1-09c) fills it; the view holds no sale logic. */
export interface SellLine {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly qty: number;
  readonly lineTotalMinor: number;
  readonly discountMinor?: number;
}

export interface QuickItem {
  readonly id: string;
  readonly name: string;
  readonly priceMinor: number;
}

export interface SellTotals {
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly itemCount: number;
  readonly currency: string;
}

export interface SellViewProps {
  readonly lines: readonly SellLine[];
  readonly totals: SellTotals;
  readonly categories: readonly { key: string; label: string }[];
  readonly category: string;
  readonly quickItems: readonly QuickItem[];
  readonly query: string;
  readonly leftHanded: boolean;
  readonly locale: string;
  readonly onQuery: (text: string) => void;
  readonly onSearch: (text: string) => void;
  readonly onCategory: (key: string) => void;
  readonly onAddQuick: (id: string) => void;
  readonly onQty: (lineId: string, qty: number) => void;
  readonly onRemove: (lineId: string) => void;
  readonly onPark: () => void;
  readonly onCustomer: () => void;
  readonly onPay: () => void;
  readonly onScan: () => void;
  /** Phone only: opens the product grid as a sheet. */
  readonly onShowCatalog?: () => void;
  readonly parkedCount?: number;
  readonly onShowParked?: () => void;
}

export type LayoutClass = "phone" | "tabletPortrait" | "tabletLandscape" | "desktop";

/** Breakpoints from docs/design/ux.md. */
export function layoutClass(width: number, height: number): LayoutClass {
  if (width < 600) return "phone";
  if (width < 900) return height >= width ? "tabletPortrait" : "tabletLandscape";
  if (width < 1280) return "tabletLandscape";
  return "desktop";
}
