// Pure cart helpers for the sell screen mock. No I/O.
import type { CartLine, CategoryKey, Product } from "./demo.ts";

export const MAX_QTY = 20;

/** Adds one of a product, or raises its quantity up to MAX_QTY. */
export function addLine(lines: readonly CartLine[], product: Product): readonly CartLine[] {
  const index = lines.findIndex((line) => line.product.id === product.id);
  if (index === -1) return [...lines, { product, qty: 1 }];
  return lines.map((line, i) =>
    i === index ? { ...line, qty: Math.min(line.qty + 1, MAX_QTY) } : line,
  );
}

/** Sets a line quantity. Quantities are clamped to 1..MAX_QTY. */
export function setQty(
  lines: readonly CartLine[],
  productId: string,
  qty: number,
): readonly CartLine[] {
  const next = Math.min(Math.max(Math.trunc(qty), 1), MAX_QTY);
  return lines.map((line) => (line.product.id === productId ? { ...line, qty: next } : line));
}

/** Case-insensitive name match plus category filter. */
export function filterProducts(
  products: readonly Product[],
  category: CategoryKey,
  query: string,
): readonly Product[] {
  const needle = query.trim().toLowerCase();
  return products.filter(
    (product) =>
      (category === "all" || product.category === category) &&
      (needle === "" || product.name.toLowerCase().includes(needle)),
  );
}
