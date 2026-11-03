"use client";

import { useState } from "react";

import { Row, Stack } from "@/components/ui.tsx";

import s from "./branding.module.css";
import { ReceiptEditor } from "./receipt-editor.tsx";
import { ThemeEditor } from "./theme-editor.tsx";

const TABS = [
  { id: "theme", label: "Theme" },
  { id: "receipt", label: "Receipt" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function BrandingPage() {
  const [tab, setTab] = useState<TabId>("theme");
  return (
    <Stack>
      <Row spread>
        <h1>Branding</h1>
      </Row>
      <div className={s.tabs} role="tablist" aria-label="Branding">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`brand-tab-${t.id}`}
            type="button"
            role="tab"
            className={s.tab}
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? "brand-panel" : undefined}
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
              document.getElementById(`brand-tab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="brand-panel" role="tabpanel" aria-labelledby={`brand-tab-${tab}`}>
        {tab === "theme" ? <ThemeEditor /> : <ReceiptEditor />}
      </div>
    </Stack>
  );
}
