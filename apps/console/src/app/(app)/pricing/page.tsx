"use client";

import { useState } from "react";

import { Row, Stack } from "@/components/ui.tsx";

import { FeesTab } from "./fees-tab.tsx";
import { PriceListsTab } from "./price-lists-tab.tsx";
import s from "./pricing.module.css";
import { PromotionsTab } from "./promotions-tab.tsx";
import { TaxTab } from "./tax-tab.tsx";

const TABS = [
  { id: "lists", label: "Price lists" },
  { id: "promotions", label: "Promotions" },
  { id: "tax", label: "Tax regions" },
  { id: "fees", label: "Fees" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function PricingPage() {
  const [tab, setTab] = useState<TabId>("lists");
  return (
    <Stack>
      <Row spread>
        <h1>Pricing</h1>
      </Row>
      <div className={s.tabs} role="tablist" aria-label="Pricing">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            className={s.tab}
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? `panel-${t.id}` : undefined}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => {
              setTab(t.id);
            }}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              const next = TABS[(i + step + TABS.length) % TABS.length];
              if (next === undefined) return;
              setTab(next.id);
              document.getElementById(`tab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "lists" ? <PriceListsTab /> : null}
        {tab === "promotions" ? <PromotionsTab /> : null}
        {tab === "tax" ? <TaxTab /> : null}
        {tab === "fees" ? <FeesTab /> : null}
      </div>
    </Stack>
  );
}
