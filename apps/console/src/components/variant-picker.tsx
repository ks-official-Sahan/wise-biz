"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "@/lib/api.ts";
import { useTenant } from "@/lib/tenant.tsx";

import { Button, TextField, styles } from "./ui.tsx";

export interface Hit {
  readonly variantId: string;
  readonly title: string;
  readonly sku: string;
  readonly barcodes?: readonly string[] | undefined;
}

export function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setV(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return v;
}

/** Search box over the catalog's variant search; hands back the variant the person chose. */
export function VariantPicker({
  label,
  onPick,
}: {
  readonly label: string;
  readonly onPick: (hit: Hit) => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const search = useQuery({
    queryKey: [t, "catalog", "search", q],
    queryFn: ({ signal }) =>
      api<{ hits: Hit[] }>("GET", `/v1/search/variants?q=${encodeURIComponent(q)}&limit=8`, {
        signal,
      }),
    enabled: q !== "",
    staleTime: 15_000,
  });
  return (
    <div>
      <TextField
        label={label}
        type="search"
        value={query}
        onKeyDown={(e) => {
          // Enter in the search box must not submit the form around it.
          if (e.key === "Enter") e.preventDefault();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      {q === "" ? null : (
        <ul>
          {(search.data?.hits ?? []).map((h) => (
            <li key={h.variantId}>
              {h.title} <span className={styles.muted}>{h.sku}</span>{" "}
              <Button
                variant="ghost"
                aria-label={`Add ${h.title}`}
                onClick={() => {
                  onPick(h);
                  setQuery("");
                }}
              >
                Add
              </Button>
            </li>
          ))}
          {search.isSuccess && search.data.hits.length === 0 ? <li>Nothing found.</li> : null}
        </ul>
      )}
    </div>
  );
}
