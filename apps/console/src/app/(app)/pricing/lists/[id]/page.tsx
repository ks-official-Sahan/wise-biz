"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SkeletonRows,
  Stack,
  TextField,
  cx,
  styles,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import {
  batches,
  formatPrice,
  pricingKeys,
  priceChanges,
  priceText,
  summariseChanges,
  usePriceList,
  usePricePages,
  useVariantNames,
} from "@/lib/pricing.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../../pricing.module.css";

import type { PriceRow } from "@/lib/pricing.ts";

interface Hit {
  readonly variantId: string;
  readonly title: string;
  readonly sku: string;
}

function useDebounced(value: string, ms: number): string {
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

export default function PriceListPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const list = usePriceList(t, id);
  const pages = usePricePages(t, id);
  const [edited, setEdited] = useState<ReadonlyMap<string, string>>(new Map());
  const [added, setAdded] = useState<ReadonlyMap<string, Hit>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
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

  const currency = list.data?.currency ?? "";
  const stored = useMemo(
    () =>
      new Map(
        pages.data?.pages.flatMap((p) => p.items).map((i) => [i.variantId, i.priceMinor]) ?? [],
      ),
    [pages.data],
  );
  const ids = useMemo(() => [...stored.keys(), ...added.keys()], [stored, added]);
  const names = useVariantNames(t, ids);

  const rows: PriceRow[] = useMemo(
    () =>
      ids.map((variantId) => ({
        variantId,
        stored: stored.get(variantId) ?? null,
        edited: edited.get(variantId),
      })),
    [ids, stored, edited],
  );
  const { changes, errors } = useMemo(() => priceChanges(rows, currency), [rows, currency]);
  const summary = summariseChanges(changes);
  const label = (variantId: string): { title: string; sku: string } => {
    const n = names.get(variantId);
    if (n !== undefined) return { title: `${n.productName} · ${n.name}`, sku: n.sku };
    const a = added.get(variantId);
    return { title: a?.title ?? "…", sku: a?.sku ?? "" };
  };

  async function save(): Promise<void> {
    const current = list.data;
    if (current === undefined) return;
    setBusy(true);
    setError(null);
    const done: string[] = [];
    try {
      let version = current.version;
      // The API takes 1000 prices per call and raises the list version each time.
      for (const batch of batches(changes, 1000)) {
        const res = await api<{ version: number }>("PUT", `/v1/pricing/price-lists/${id}/prices`, {
          body: {
            version,
            prices: batch.map((c) => ({ variantId: c.variantId, priceMinor: c.to })),
          },
        });
        version = res.version;
        for (const c of batch) done.push(c.variantId);
      }
      setSaved(changes.length);
      setEdited(new Map());
      setAdded(new Map());
      setReviewing(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: pricingKeys.prices(t, id) }),
        qc.invalidateQueries({ queryKey: pricingKeys.list(t, id) }),
      ]);
    } catch (e) {
      if (done.length > 0) {
        // Earlier batches are saved: drop them from the edits and reload so the next save starts from the new version.
        const saved = new Set(done);
        setEdited((cur) => new Map([...cur].filter(([k]) => !saved.has(k))));
        setAdded((cur) => new Map([...cur].filter(([k]) => !saved.has(k))));
        await Promise.all([
          qc.invalidateQueries({ queryKey: pricingKeys.prices(t, id) }),
          qc.invalidateQueries({ queryKey: pricingKeys.list(t, id) }),
        ]);
      }
      setError(
        e instanceof ApiError && e.status === 409
          ? "Someone else changed this list. Reload to see their prices, then enter yours again."
          : e instanceof Error
            ? e.message
            : "Saving failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (list.isPending) return <SkeletonRows label="Loading price list" />;
  if (list.isError) {
    return (
      <ErrorState
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }
  const l = list.data;
  const dirty = changes.length > 0;
  const rowCount = rows.length;

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{l.name}</h1>
          <p className={styles.muted}>
            {l.currency} · version {l.version}{" "}
            {l.archived ? <Badge tone="warning">Archived</Badge> : null}
          </p>
        </div>
        <LinkButton variant="secondary" href="/pricing">
          All price lists
        </LinkButton>
      </Row>
      {saved === null ? null : (
        <Alert tone="success">{`Saved ${String(saved)} price change(s). Tills get them at the next sync.`}</Alert>
      )}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}

      <div className={s.grid}>
        <TextField
          label="Add a product to this list"
          type="search"
          value={query}
          help="Search by name, SKU or barcode."
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <div>
          {q === "" ? null : search.isPending ? (
            <p className={styles.muted}>Searching…</p>
          ) : (search.data?.hits.length ?? 0) === 0 ? (
            <p className={styles.muted}>Nothing found.</p>
          ) : (
            <ul className={s.summary}>
              {search.data?.hits.map((h) => (
                <li key={h.variantId}>
                  {h.title} <span className={styles.muted}>{h.sku}</span>{" "}
                  <Button
                    variant="ghost"
                    disabled={ids.includes(h.variantId)}
                    onClick={() => {
                      setAdded((cur) => new Map(cur).set(h.variantId, h));
                      setQuery("");
                    }}
                  >
                    {ids.includes(h.variantId) ? "On the list" : "Add"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pages.isPending ? <SkeletonRows label="Loading prices" /> : null}
      {pages.isError ? (
        <ErrorState
          error={pages.error}
          onRetry={() => {
            void pages.refetch();
          }}
        />
      ) : null}
      {rowCount === 0 && pages.isSuccess ? (
        <Empty title="No prices yet">Search for a product above to price it.</Empty>
      ) : null}
      {rowCount > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Prices in {l.name}</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">SKU</th>
                <th scope="col" className={s.num}>
                  Current
                </th>
                <th scope="col" className={s.num}>
                  New price ({l.currency})
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const n = label(r.variantId);
                const err = errors.get(r.variantId);
                return (
                  <tr key={r.variantId} className={r.edited === undefined ? undefined : s.changed}>
                    <th scope="row">{n.title}</th>
                    <td>{n.sku}</td>
                    <td className={s.num}>
                      {r.stored === null ? "Not set" : formatPrice(r.stored, l.currency)}
                    </td>
                    <td className={s.num}>
                      <input
                        aria-label={`New price for ${n.title}`}
                        aria-invalid={err !== undefined || undefined}
                        inputMode="decimal"
                        className={cx(styles.input, s.priceInput)}
                        value={
                          r.edited ?? (r.stored === null ? "" : priceText(r.stored, l.currency))
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setSaved(null);
                          setEdited((cur) => {
                            const next = new Map(cur);
                            if (r.stored !== null && v === priceText(r.stored, l.currency))
                              next.delete(r.variantId);
                            else next.set(r.variantId, v);
                            return next;
                          });
                        }}
                      />
                      {err === undefined ? null : <div role="alert">{err}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {pages.hasNextPage ? (
        <Button
          variant="secondary"
          busy={pages.isFetchingNextPage}
          onClick={() => {
            void pages.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}

      {dirty || errors.size > 0 ? (
        <div className={s.stickybar}>
          <Row spread>
            <span role="status">
              {errors.size > 0
                ? `${String(errors.size)} price(s) need fixing.`
                : `${String(changes.length)} unsaved change(s).`}
            </span>
            <Row>
              <Button
                variant="ghost"
                onClick={() => {
                  setEdited(new Map());
                  setAdded(new Map());
                }}
              >
                Discard
              </Button>
              <Button
                disabled={!dirty || errors.size > 0}
                onClick={() => {
                  setReviewing(true);
                }}
              >
                Review and save
              </Button>
            </Row>
          </Row>
        </div>
      ) : null}

      <Dialog
        open={reviewing}
        title="Review price changes"
        onClose={() => {
          setReviewing(false);
        }}
      >
        <Stack>
          <p>
            {`${String(summary.added)} new, ${String(summary.changed)} changed, ${String(summary.removed)} removed.`}
          </p>
          <ul className={s.summary}>
            {changes.slice(0, 10).map((c) => (
              <li key={c.variantId}>
                {label(c.variantId).title}:{" "}
                {c.from === null ? "not set" : formatPrice(c.from, l.currency)} →{" "}
                {c.to === null ? "removed" : formatPrice(c.to, l.currency)}
              </li>
            ))}
            {changes.length > 10 ? <li>{`and ${String(changes.length - 10)} more`}</li> : null}
          </ul>
          <p className={styles.muted}>Tills use the new prices after their next sync.</p>
          <Row spread>
            <Button
              variant="ghost"
              onClick={() => {
                setReviewing(false);
              }}
            >
              Keep editing
            </Button>
            <Button busy={busy} onClick={() => void save()}>
              Save prices
            </Button>
          </Row>
        </Stack>
      </Dialog>
    </Stack>
  );
}
