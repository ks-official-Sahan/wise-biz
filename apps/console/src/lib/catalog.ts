"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { checkDigit } from "@wise-biz/barcode";

import { api } from "./api.ts";
import { STALE } from "./queries.ts";

// ---- shapes (mirror modules/catalog/src/schemas.ts) ----

export interface Barcode {
  readonly code: string;
  readonly format: string;
}
export interface Variant {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unitId: string | null;
  readonly tracksBatches: boolean;
  readonly taxCategory: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly archived: boolean;
  readonly updatedAt: string;
  readonly barcodes?: readonly Barcode[];
}
export interface Product {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  readonly version: number;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly variants?: readonly Variant[];
}
export interface Category {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly path: readonly string[];
}
export interface Tag {
  readonly id: string;
  readonly name: string;
}
export interface Unit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly decimals: number;
}

export interface ProductFilter {
  readonly categoryId?: string | undefined;
  readonly tagId?: string | undefined;
  readonly archived?: "false" | "true" | "all" | undefined;
}

export const catalogKeys = {
  all: (t: string) => [t, "catalog"] as const,
  products: (t: string, f: ProductFilter) => [t, "catalog", "products", f] as const,
  product: (t: string, id: string) => [t, "catalog", "product", id] as const,
  categories: (t: string) => [t, "catalog", "categories"] as const,
  tags: (t: string) => [t, "catalog", "tags"] as const,
  units: (t: string) => [t, "catalog", "units"] as const,
  imports: (t: string) => [t, "catalog", "imports"] as const,
};

export function productsQueryString(filter: ProductFilter, after: string | null): string {
  const p = new URLSearchParams({ limit: "50", include: "variants,barcodes" });
  if (filter.categoryId) p.set("categoryId", filter.categoryId);
  if (filter.tagId) p.set("tagId", filter.tagId);
  p.set("archived", filter.archived ?? "false");
  if (after) p.set("after", after);
  return p.toString();
}

/** Server-paginated: a page of 50 at a time, never the whole catalog (a tenant can have 100k products). */
export const useProducts = (t: string, filter: ProductFilter) =>
  useInfiniteQuery({
    queryKey: catalogKeys.products(t, filter),
    queryFn: ({ signal, pageParam }) =>
      api<{ products: Product[]; next: string | null }>(
        "GET",
        `/v1/catalog/products?${productsQueryString(filter, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: STALE.list,
  });

export const useProduct = (t: string, id: string | null) =>
  useQuery({
    queryKey: catalogKeys.product(t, id ?? "none"),
    queryFn: ({ signal }) =>
      api<Product>("GET", `/v1/catalog/products/${id ?? ""}?include=variants,barcodes`, { signal }),
    enabled: id !== null,
    staleTime: 0,
  });

export const useCategories = (t: string) =>
  useQuery({
    queryKey: catalogKeys.categories(t),
    queryFn: ({ signal }) =>
      api<{ categories: Category[] }>("GET", "/v1/catalog/categories", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.categories,
  });

export const useTags = (t: string) =>
  useQuery({
    queryKey: catalogKeys.tags(t),
    queryFn: ({ signal }) => api<{ tags: Tag[] }>("GET", "/v1/catalog/tags", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.tags,
  });

export const useUnits = (t: string) =>
  useQuery({
    queryKey: catalogKeys.units(t),
    queryFn: ({ signal }) => api<{ units: Unit[] }>("GET", "/v1/catalog/units", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.units,
  });

// ---- CSV ----

/** RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, a trailing newline. Rows are capped. */
export function parseCsv(text: string, maxRows = 200_000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (src.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src.charAt(i + 1) === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error("This file has too many rows.");
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/**
 * Quotes a field when it needs it. Values are uploaded as they are (a product called "+1 Drink" must stay that way);
 * the server treats every cell as text. A future export must neutralise leading = + - @ for spreadsheets.
 */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The columns the server import reads (modules/catalog/src/import/rows.ts). */
export const IMPORT_COLUMNS = [
  { key: "product", label: "Product name", required: true },
  { key: "variant", label: "Variant name", required: false },
  { key: "sku", label: "SKU", required: true },
  { key: "barcode", label: "Barcodes (separate with |)", required: false },
  { key: "unit", label: "Unit", required: false },
  { key: "category", label: "Category (Drinks > Soda)", required: false },
  { key: "tags", label: "Tags", required: false },
  { key: "tax_category", label: "Tax category", required: false },
  { key: "tracks_batches", label: "Tracks batches (yes/no)", required: false },
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number]["key"];
export type ColumnMapping = Readonly<Record<ImportColumn, number | null>>;

const SYNONYMS: Readonly<Record<ImportColumn, readonly string[]>> = {
  product: ["product", "productname", "name", "title", "item", "itemname", "description"],
  variant: ["variant", "variantname", "option", "size", "flavor", "flavour"],
  sku: ["sku", "code", "itemcode", "productcode", "partnumber", "ref", "reference"],
  barcode: ["barcode", "barcodes", "ean", "upc", "gtin", "ean13", "upca"],
  unit: ["unit", "uom", "unitofmeasure"],
  category: ["category", "categories", "department", "group"],
  tags: ["tags", "tag", "labels"],
  tax_category: ["taxcategory", "tax", "taxclass", "taxcode"],
  tracks_batches: ["tracksbatches", "batch", "batches", "trackbatches", "lot", "expiry"],
};

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Guesses which file column feeds each import column: exact synonym first, never the same file column twice. */
export function autoMap(headers: readonly string[]): ColumnMapping {
  const taken = new Set<number>();
  const out = {} as Record<ImportColumn, number | null>;
  for (const col of IMPORT_COLUMNS) {
    const names = SYNONYMS[col.key];
    let found: number | null = null;
    for (const name of names) {
      const i = headers.findIndex((h, idx) => !taken.has(idx) && squash(h) === name);
      if (i >= 0) {
        found = i;
        break;
      }
    }
    if (found !== null) taken.add(found);
    out[col.key] = found;
  }
  return out;
}

/** The file re-written with the import's own header names, in its own order: what is uploaded. */
export function applyMapping(rows: readonly string[][], mapping: ColumnMapping): string {
  const cols = IMPORT_COLUMNS.filter((c) => mapping[c.key] !== null);
  const lines = [cols.map((c) => c.key).join(",")];
  for (const r of rows.slice(1)) {
    lines.push(cols.map((c) => csvField((r[mapping[c.key] ?? -1] ?? "").trim())).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Problems that stop a mapping from being usable, before anything is uploaded. */
export function mappingProblems(mapping: ColumnMapping): string[] {
  return IMPORT_COLUMNS.filter((c) => c.required && mapping[c.key] === null).map(
    (c) => `Choose the column for ${c.label}.`,
  );
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- barcodes ----

/**
 * An in-store EAN-13 for items that have no manufacturer code: prefix 2 (GS1 restricted circulation, never a real
 * product), 11 digits from the sequence, check digit last. The same sequence number always gives the same code.
 */
export function inStoreBarcode(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 99_999_999_999)
    throw new RangeError("sequence out of range");
  const body = `2${String(sequence).padStart(11, "0")}`;
  return `${body}${String(checkDigit(body))}`;
}

/** A starting sequence that will not collide between two clerks generating at the same time (time based, 11 digits). */
export function barcodeSequenceSeed(now = Date.now()): number {
  return now % 100_000_000_000;
}

// ---- saved views ----

export interface SavedView {
  readonly name: string;
  readonly filter: ProductFilter;
}

const VIEWS_KEY = "wb.console.catalog.views";

export function parseSavedViews(raw: string | null): SavedView[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x): SavedView[] => {
      if (typeof x !== "object" || x === null) return [];
      const o = x as Record<string, unknown>;
      const f = (typeof o.filter === "object" && o.filter !== null ? o.filter : {}) as Record<
        string,
        unknown
      >;
      if (typeof o.name !== "string" || o.name === "" || o.name.length > 60) return [];
      const archived =
        f.archived === "true" || f.archived === "all" || f.archived === "false"
          ? f.archived
          : undefined;
      return [
        {
          name: o.name,
          filter: {
            ...(typeof f.categoryId === "string" ? { categoryId: f.categoryId } : {}),
            ...(typeof f.tagId === "string" ? { tagId: f.tagId } : {}),
            ...(archived === undefined ? {} : { archived }),
          },
        },
      ];
    });
  } catch {
    return [];
  }
}

export function loadSavedViews(): SavedView[] {
  try {
    return parseSavedViews(globalThis.localStorage.getItem(VIEWS_KEY));
  } catch {
    return [];
  }
}

export function storeSavedViews(views: readonly SavedView[]): void {
  try {
    globalThis.localStorage.setItem(VIEWS_KEY, JSON.stringify(views.slice(0, 20)));
  } catch {
    // Private mode or blocked storage: views simply do not persist.
  }
}

// ---- change summary ----

export interface EditableVariant {
  readonly id: string | null;
  readonly sku: string;
  readonly name: string;
  readonly taxCategory: string;
  readonly unitId: string | null;
  readonly tracksBatches: boolean;
  readonly barcodes: readonly string[];
  readonly version: number;
}
export interface EditableProduct {
  readonly name: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  readonly variants: readonly EditableVariant[];
}

/** Plain-words list of what a save changes, with the critical fields (tax category, SKU, barcodes) named first. */
export function changeSummary(before: EditableProduct | null, after: EditableProduct): string[] {
  if (before === null)
    return [`Create "${after.name}" with ${String(after.variants.length)} variant(s).`];
  const out: string[] = [];
  const byId = new Map(before.variants.map((v) => [v.id, v]));
  for (const v of after.variants) {
    const old = v.id === null ? undefined : byId.get(v.id);
    if (old === undefined) {
      out.push(`Add variant ${v.sku} (${v.name}), tax category ${v.taxCategory}.`);
      continue;
    }
    if (old.taxCategory !== v.taxCategory)
      out.push(`${v.sku}: tax category ${old.taxCategory} → ${v.taxCategory}.`);
    if (old.sku !== v.sku) out.push(`${old.sku}: SKU → ${v.sku}.`);
    if (old.barcodes.join("|") !== v.barcodes.join("|"))
      out.push(
        `${v.sku}: barcodes ${old.barcodes.join(", ") || "none"} → ${v.barcodes.join(", ") || "none"}.`,
      );
    if (old.name !== v.name) out.push(`${v.sku}: name "${old.name}" → "${v.name}".`);
    if (old.unitId !== v.unitId) out.push(`${v.sku}: unit changed.`);
    if (old.tracksBatches !== v.tracksBatches)
      out.push(`${v.sku}: batch tracking ${v.tracksBatches ? "on" : "off"}.`);
  }
  if (before.name !== after.name) out.push(`Name "${before.name}" → "${after.name}".`);
  if (before.description !== after.description) out.push("Description changed.");
  if (before.categoryId !== after.categoryId) out.push("Category changed.");
  if (before.tagIds.join("|") !== after.tagIds.join("|")) out.push("Tags changed.");
  return out;
}

/**
 * Which rows of a long list to render: the ones in the viewport plus a margin. Rows have one fixed height, so the rest
 * is two spacer rows; a list of 100k products keeps about 40 rows in the DOM.
 */
export function windowRange(o: {
  /** Distance from the top of the first row to the top of the viewport (negative while the list is below it). */
  offset: number;
  viewport: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}): { start: number; end: number } {
  const over = o.overscan ?? 8;
  const first = Math.floor(o.offset / o.rowHeight);
  const last = Math.ceil((o.offset + o.viewport) / o.rowHeight);
  const start = Math.min(Math.max(0, first - over), o.count);
  const end = Math.max(start, Math.min(o.count, last + over));
  return { start, end };
}
