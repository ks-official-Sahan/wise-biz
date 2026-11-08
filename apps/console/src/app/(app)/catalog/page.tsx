"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import {
  catalogKeys,
  loadSavedViews,
  storeSavedViews,
  windowRange,
  useCategories,
  useProducts,
  useTags,
} from "@/lib/catalog.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./catalog.module.css";

import type { Product, ProductFilter, SavedView } from "@/lib/catalog.ts";

interface Hit {
  readonly variantId: string;
  readonly productId: string;
  readonly title: string;
  readonly sku: string;
  readonly barcodes: readonly string[];
}

const ROW_PX = 48;

const dateTime = (iso: string): string => new Date(iso).toLocaleDateString();

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

function BulkDialog({
  open,
  action,
  products,
  onClose,
  onDone,
}: {
  open: boolean;
  action: "archive" | "restore";
  products: readonly Product[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  // Cancel stops the loop: products already changed stay changed, the rest are left alone.
  const cancelled = useRef(false);
  const isCancelled = (): boolean => cancelled.current;

  async function run(): Promise<void> {
    setBusy(true);
    setDone(0);
    setFailed([]);
    cancelled.current = false;
    const bad: string[] = [];
    for (const p of products) {
      if (isCancelled()) break;
      try {
        await api("PATCH", `/v1/catalog/products/${p.id}`, {
          body: { version: p.version, archived: action === "archive" },
        });
      } catch (e) {
        bad.push(
          `${p.name}: ${e instanceof ApiError && e.status === 409 ? "changed by someone else, reload" : "failed"}`,
        );
      }
      setDone((n) => n + 1);
    }
    setFailed(bad);
    setBusy(false);
    onDone();
    if (bad.length === 0) onClose();
  }

  // Both the dialog close and the Cancel button stop a run that is still going (the loop checks `cancelled`).
  const close = () => {
    cancelled.current = true;
    onClose();
  };

  const verb = action === "archive" ? "Archive" : "Restore";
  return (
    <Dialog open={open} title={`${verb} ${String(products.length)} product(s)`} onClose={close}>
      <Stack>
        <p>
          {action === "archive"
            ? "Archived products stop appearing at the till after the next sync. Their sales history stays."
            : "Restored products appear at the till again after the next sync."}
        </p>
        <ul className={s.summary}>
          {products.slice(0, 8).map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
          {products.length > 8 ? <li>and {String(products.length - 8)} more</li> : null}
        </ul>
        {failed.length === 0 ? null : (
          <Alert tone="danger">
            <ul className={s.summary}>
              {failed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Alert>
        )}
        {busy ? (
          <p role="status">{`Working… ${String(done)} of ${String(products.length)}`}</p>
        ) : null}
        <Row spread>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={action === "archive" ? "danger" : "primary"}
            busy={busy}
            onClick={() => void run()}
          >
            {verb}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

export default function CatalogPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  // The API decides what a person may change (an unauthorised write answers 404); the screen offers the actions.
  const canWrite = useMemo(() => true, []);
  const [filter, setFilter] = useState<ProductFilter>({ archived: "false" });
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<"archive" | "restore" | null>(null);

  const categories = useCategories(t);
  const tags = useTags(t);
  const products = useProducts(t, filter);
  const search = useQuery({
    queryKey: [t, "catalog", "search", q],
    queryFn: ({ signal }) =>
      api<{ hits: Hit[] }>("GET", `/v1/search/variants?q=${encodeURIComponent(q)}&limit=30`, {
        signal,
      }),
    enabled: q !== "",
    staleTime: 15_000,
  });

  useEffect(() => {
    // Saved views live in this browser; read after mount so server and client render the same markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViews(loadSavedViews());
  }, []);

  const rows = useMemo(
    () => products.data?.pages.flatMap((p) => p.products) ?? [],
    [products.data],
  );

  // Infinite scroll: the next page loads when the sentinel nears the viewport.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = products;
  useEffect(() => {
    const el = sentinel.current;
    if (el === null || !hasNextPage || q !== "") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, q, rows.length]);

  // Windowing: render only the rows near the viewport; the rest of the height is two spacer rows.
  const tableBox = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = tableBox.current;
      if (el === null) return;
      const top = el.getBoundingClientRect().top + 44; // the header row is about 44px
      const next = windowRange({
        offset: -top,
        viewport: globalThis.innerHeight,
        rowHeight: ROW_PX,
        count: rows.length,
      });
      setRange((r) => (r.start === next.start && r.end === next.end ? r : next));
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    globalThis.addEventListener("scroll", onScroll, { passive: true });
    globalThis.addEventListener("resize", onScroll);
    return () => {
      globalThis.removeEventListener("scroll", onScroll);
      globalThis.removeEventListener("resize", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [rows.length]);
  const windowed = rows.slice(range.start, range.end);

  const chosen = rows.filter((r) => selected.has(r.id));
  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const categoryName = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c.path.join(" › ")])),
    [categories.data],
  );

  function saveView(): void {
    const name = globalThis.prompt("Name this view")?.trim();
    if (name === undefined || name === "") return;
    const next = [...views.filter((v) => v.name !== name), { name, filter }];
    setViews(next);
    storeSavedViews(next);
  }

  return (
    <Stack>
      <Row spread>
        <h1>Products</h1>
        <Row>
          {canWrite ? (
            <>
              <LinkButton variant="secondary" href="/catalog/import">
                Import
              </LinkButton>
              <LinkButton href="/catalog/new">New product</LinkButton>
            </>
          ) : null}
        </Row>
      </Row>

      <div className={s.toolbar}>
        <div className={s.search}>
          <TextField
            label="Search by name, SKU or barcode"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <SelectField
          label="Category"
          value={filter.categoryId ?? ""}
          options={[
            { value: "", label: "All categories" },
            ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.path.join(" › ") })),
          ]}
          onChange={(e) => {
            setFilter({
              ...filter,
              categoryId: e.target.value === "" ? undefined : e.target.value,
            });
          }}
        />
        <SelectField
          label="Tag"
          value={filter.tagId ?? ""}
          options={[
            { value: "", label: "Any tag" },
            ...(tags.data ?? []).map((x) => ({ value: x.id, label: x.name })),
          ]}
          onChange={(e) => {
            setFilter({ ...filter, tagId: e.target.value === "" ? undefined : e.target.value });
          }}
        />
        <SelectField
          label="Status"
          value={filter.archived ?? "false"}
          options={[
            { value: "false", label: "Active" },
            { value: "true", label: "Archived" },
            { value: "all", label: "All" },
          ]}
          onChange={(e) => {
            setFilter({ ...filter, archived: e.target.value as "false" | "true" | "all" });
          }}
        />
        <SelectField
          label="Saved views"
          value=""
          options={[
            { value: "", label: views.length === 0 ? "None saved" : "Choose a view" },
            ...views.map((v) => ({ value: v.name, label: v.name })),
          ]}
          onChange={(e) => {
            const v = views.find((x) => x.name === e.target.value);
            if (v !== undefined) setFilter(v.filter);
          }}
        />
        <Button variant="secondary" onClick={saveView}>
          Save view
        </Button>
        {views.length === 0 ? null : (
          <Button
            variant="ghost"
            onClick={() => {
              storeSavedViews([]);
              setViews([]);
            }}
          >
            Clear views
          </Button>
        )}
      </div>

      {q !== "" ? (
        search.isPending ? (
          <SkeletonRows label="Searching" />
        ) : search.isError ? (
          <ErrorState error={search.error} onRetry={() => void search.refetch()} />
        ) : search.data.hits.length === 0 ? (
          <Empty title="No match">Try a different word, a SKU or a barcode.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Search results</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Barcodes</th>
                </tr>
              </thead>
              <tbody>
                {search.data.hits.map((h) => (
                  <tr key={h.variantId}>
                    <td>
                      <Link href={`/catalog/${h.productId}` as never}>{h.title}</Link>
                    </td>
                    <td className="num">{h.sku}</td>
                    <td className="num">{h.barcodes.join(", ") || "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : products.isPending ? (
        <SkeletonRows label="Loading products" rows={8} />
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : rows.length === 0 ? (
        <Empty
          title="No products yet"
          action={
            canWrite ? (
              <LinkButton href="/catalog/new">Add your first product</LinkButton>
            ) : undefined
          }
        >
          Add products one by one or import a spreadsheet.
        </Empty>
      ) : (
        <>
          {chosen.length === 0 || !canWrite ? null : (
            <div className={s.bulk} role="region" aria-label="Bulk actions">
              <strong>{`${String(chosen.length)} selected`}</strong>
              {filter.archived === "true" ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setBulk("restore");
                  }}
                >
                  Restore…
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setBulk("archive");
                  }}
                >
                  Archive…
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setSelected(new Set());
                }}
              >
                Clear selection
              </Button>
            </div>
          )}
          <div className={styles.tableWrap} ref={tableBox}>
            <table className={styles.table} aria-rowcount={rows.length + 1}>
              <caption className="sr-only">Products</caption>
              <thead>
                <tr>
                  {canWrite ? (
                    <th scope="col" className={s.check}>
                      <input
                        type="checkbox"
                        aria-label="Select all loaded products"
                        checked={rows.length > 0 && chosen.length === rows.length}
                        onChange={(e) => {
                          setSelected(
                            e.target.checked ? new Set(rows.map((r) => r.id)) : new Set(),
                          );
                        }}
                      />
                    </th>
                  ) : null}
                  <th scope="col">Name</th>
                  <th scope="col">Category</th>
                  <th scope="col">SKUs</th>
                  <th scope="col">Barcodes</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody className={s.rows}>
                {range.start === 0 ? null : (
                  <tr aria-hidden style={{ height: range.start * ROW_PX }}>
                    <td colSpan={7} />
                  </tr>
                )}
                {windowed.map((p, wi) => {
                  const variants = p.variants ?? [];
                  const codes = variants.reduce((n, v) => n + (v.barcodes?.length ?? 0), 0);
                  return (
                    <tr key={p.id} className={s.item} aria-rowindex={range.start + wi + 2}>
                      {canWrite ? (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.name}`}
                            checked={selected.has(p.id)}
                            onChange={() => {
                              toggle(p.id);
                            }}
                          />
                        </td>
                      ) : null}
                      <td>
                        <Link href={`/catalog/${p.id}` as never}>{p.name}</Link>
                      </td>
                      <td>
                        {p.categoryId === null
                          ? "None"
                          : (categoryName.get(p.categoryId) ?? "None")}
                      </td>
                      <td className="num">
                        {variants[0]?.sku ?? "None"}
                        {variants.length > 1 ? ` +${String(variants.length - 1)}` : ""}
                      </td>
                      <td className={s.num}>
                        {codes === 0 ? <Badge tone="warning">None</Badge> : String(codes)}
                      </td>
                      <td>
                        {p.archived ? <Badge>Archived</Badge> : <Badge tone="accent">Active</Badge>}
                      </td>
                      <td>{dateTime(p.updatedAt)}</td>
                    </tr>
                  );
                })}
                {range.end >= rows.length ? null : (
                  <tr aria-hidden style={{ height: (rows.length - range.end) * ROW_PX }}>
                    <td colSpan={7} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div ref={sentinel} className={s.sentinel} aria-hidden />
          {hasNextPage ? (
            <Button
              variant="secondary"
              busy={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Load more
            </Button>
          ) : (
            <p className="muted">{`${String(rows.length)} product(s)`}</p>
          )}
        </>
      )}

      {bulk === null ? null : (
        <BulkDialog
          open
          action={bulk}
          products={chosen}
          onClose={() => {
            setBulk(null);
          }}
          onDone={() => {
            setSelected(new Set());
            void qc.invalidateQueries({ queryKey: catalogKeys.all(t) });
          }}
        />
      )}
    </Stack>
  );
}
