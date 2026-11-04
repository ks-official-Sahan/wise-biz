// Demo data only: Sri Lankan cafe items and LKR prices. Amounts are minor units (cents). Not real merchant data.
import { format, money, percent, sum } from "@wise-biz/money";

import type { Money } from "@wise-biz/money";

export const LOCALE = "en-LK";
export const CURRENCY = "LKR";
/** VAT rate in basis points for the demo cart (18 %). */
export const TAX_BPS = 1800;

export type CategoryKey = "all" | "coffee" | "food" | "drinks" | "bakery";

export const CATEGORIES: readonly { readonly key: CategoryKey; readonly label: string }[] = [
  { key: "all", label: "All" },
  { key: "coffee", label: "Coffee" },
  { key: "food", label: "Food" },
  { key: "drinks", label: "Drinks" },
  { key: "bakery", label: "Bakery" },
];

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: Exclude<CategoryKey, "all">;
  readonly price: Money;
}

const lkr = (rupees: number): Money => money(Math.round(rupees * 100), CURRENCY);

const MILK_TEA: Product = {
  id: "p-milk-tea",
  name: "Ceylon milk tea",
  category: "drinks",
  price: lkr(350),
};
const FLAT_WHITE: Product = {
  id: "p-flat-white",
  name: "Flat white",
  category: "coffee",
  price: lkr(690),
};
const ICED_COFFEE: Product = {
  id: "p-iced-coffee",
  name: "Iced coffee",
  category: "coffee",
  price: lkr(550),
};
const KOTTU: Product = { id: "p-kottu", name: "Chicken kottu", category: "food", price: lkr(1250) };
const EGG_HOPPER: Product = {
  id: "p-egg-hopper",
  name: "Egg hopper",
  category: "food",
  price: lkr(180),
};
const POL_SAMBOL: Product = {
  id: "p-pol-sambol",
  name: "Pol sambol toast",
  category: "bakery",
  price: lkr(480),
};
const WATALAPPAN: Product = {
  id: "p-watalappan",
  name: "Watalappan",
  category: "bakery",
  price: lkr(420),
};
const KING_COCONUT: Product = {
  id: "p-king-coconut",
  name: "King coconut",
  category: "drinks",
  price: lkr(320),
};
const CLUB_SANDWICH: Product = {
  id: "p-club-sandwich",
  name: "Club sandwich",
  category: "food",
  price: lkr(890),
};

/** Nine items for the product grid. */
export const PRODUCTS: readonly Product[] = [
  MILK_TEA,
  FLAT_WHITE,
  ICED_COFFEE,
  KOTTU,
  EGG_HOPPER,
  POL_SAMBOL,
  WATALAPPAN,
  KING_COCONUT,
  CLUB_SANDWICH,
];

export interface CartLine {
  readonly product: Product;
  readonly qty: number;
}

/** Starting cart for the sell screen mock: three lines. */
export const SEED_CART: readonly CartLine[] = [
  { product: MILK_TEA, qty: 2 },
  { product: KOTTU, qty: 1 },
  { product: WATALAPPAN, qty: 1 },
];

export function subtotalOf(lines: readonly CartLine[]): Money {
  return sum(
    lines.map((line) => money(line.product.price.minor * line.qty, CURRENCY)),
    CURRENCY,
  );
}

/** Tax on the subtotal, rounded half-even by @wise-biz/money. */
export function taxOf(subtotal: Money): Money {
  return percent(subtotal, TAX_BPS);
}

/** "LKR 1,403.00" style text for buttons and labels. */
export function formatMoney(value: Money): string {
  return format(value, LOCALE, { display: "code" });
}
