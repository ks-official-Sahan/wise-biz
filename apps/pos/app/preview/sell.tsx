import { Redirect } from "expo-router";
import { useState } from "react";

import { SellView } from "../../src/features/sell/ui/SellView.tsx";

import type { SellLine } from "../../src/features/sell/ui/types.ts";

const LINES: SellLine[] = [
  { id: "1", name: "Green Tea 500 g", detail: "GT-500 · 4.50 each", qty: 2, lineTotalMinor: 900 },
  {
    id: "2",
    name: "Whole Milk 1 L",
    detail: "ML-1 · 1.80 each",
    qty: 3,
    lineTotalMinor: 540,
    discountMinor: 60,
  },
  { id: "3", name: "Sourdough Loaf", detail: "BK-12 · 5.20 each", qty: 1, lineTotalMinor: 520 },
  {
    id: "4",
    name: "Bananas (kg)",
    detail: "FR-7 · 2.40 per kg · 1.250 kg",
    qty: 1,
    lineTotalMinor: 300,
  },
];

const QUICK = [
  "Green Tea 500 g",
  "Whole Milk 1 L",
  "Sourdough Loaf",
  "Free-range Eggs 12",
  "Cheddar 200 g",
  "Orange Juice 1 L",
  "Basmati Rice 1 kg",
  "Olive Oil 500 ml",
  "Dark Chocolate",
  "Sparkling Water",
].map((name, i) => ({ id: String(i), name, priceMinor: 180 + i * 95 }));

/** Layout preview with sample data (design gate for P1-09). Only served when EXPO_PUBLIC_PREVIEW=1. */
export default function SellPreview() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("fav");
  if (process.env.EXPO_PUBLIC_PREVIEW !== "1") return <Redirect href="/" />;
  const noop = () => undefined;
  return (
    <SellView
      lines={LINES}
      totals={{
        subtotalMinor: 2260,
        discountMinor: 60,
        taxMinor: 176,
        totalMinor: 2376,
        itemCount: 7,
        currency: "USD",
      }}
      categories={[
        { key: "fav", label: "Favorites" },
        { key: "dairy", label: "Dairy" },
        { key: "bakery", label: "Bakery" },
        { key: "produce", label: "Produce" },
        { key: "drinks", label: "Drinks" },
      ]}
      category={category}
      quickItems={QUICK}
      query={query}
      leftHanded={false}
      locale="en-US"
      onQuery={setQuery}
      onSearch={noop}
      onCategory={setCategory}
      onAddQuick={noop}
      onQty={noop}
      onRemove={noop}
      onPark={noop}
      onCustomer={noop}
      onPay={noop}
      onScan={noop}
    />
  );
}
