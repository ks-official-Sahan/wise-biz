import { DomainError } from "@wise-biz/errors";

import { normaliseBarcode } from "../domain/barcode.ts";

import type { BarcodeFormat } from "../domain/barcode.ts";

/** CSV header names (case-insensitive). Only product and sku are required. */
export const COLUMNS = [
  "product",
  "variant",
  "sku",
  "barcode",
  "unit",
  "category",
  "tags",
  "tax_category",
  "tracks_batches",
] as const;
export type Column = (typeof COLUMNS)[number];

export interface RowError {
  /** 1-based data row (the header is row 0). */
  row: number;
  column: Column | "file";
  error: string;
}

export interface ImportRow {
  row: number;
  product: string;
  variant: string;
  sku: string;
  barcodes: { code: string; format: BarcodeFormat }[];
  unit: string | null;
  /** Category names root..leaf ("Drinks > Soda"). */
  category: string[] | null;
  tags: string[];
  taxCategory: string;
  tracksBatches: boolean;
}

const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const TAX = /^[a-z][a-z0-9_]{0,31}$/;
const BOOL: Readonly<Record<string, boolean>> = {
  "": false,
  true: true,
  yes: true,
  "1": true,
  false: false,
  no: false,
  "0": false,
};

const fail = (row: number, column: Column, error: string): RowError => ({ row, column, error });

/** Shape checks for one parsed record. Returns the row or every problem found in it. */
export function parseRow(
  row: number,
  rec: Partial<Record<Column, string>>,
): ImportRow | RowError[] {
  const get = (c: Column) => (rec[c] ?? "").trim();
  const errors: RowError[] = [];
  const product = get("product");
  if (product === "" || product.length > 200)
    errors.push(fail(row, "product", "Required, at most 200 characters."));
  const variant = get("variant") || "Default";
  if (variant.length > 200) errors.push(fail(row, "variant", "At most 200 characters."));
  const sku = get("sku");
  if (!SKU.test(sku)) errors.push(fail(row, "sku", "1-64 letters, digits, . _ / - (required)."));
  const barcodes: ImportRow["barcodes"] = [];
  for (const code of get("barcode")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "")) {
    try {
      barcodes.push(normaliseBarcode({ code }, 0));
    } catch (e) {
      errors.push(fail(row, "barcode", e instanceof DomainError ? e.message : "Invalid barcode."));
    }
  }
  const unit = get("unit").toLowerCase() || null;
  const categoryRaw = get("category");
  const category = categoryRaw === "" ? null : categoryRaw.split(">").map((s) => s.trim());
  if (category?.some((c) => c === "")) errors.push(fail(row, "category", 'Use "Parent > Child".'));
  const tags = get("tags")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const taxCategory = get("tax_category").toLowerCase() || "standard";
  if (!TAX.test(taxCategory))
    errors.push(fail(row, "tax_category", "Lowercase letters, digits and _."));
  const tracks = BOOL[get("tracks_batches").toLowerCase()];
  if (tracks === undefined) errors.push(fail(row, "tracks_batches", "Use yes or no."));
  if (errors.length > 0) return errors;
  return {
    row,
    product,
    variant,
    sku,
    barcodes,
    unit,
    category,
    tags,
    taxCategory,
    tracksBatches: tracks ?? false,
  };
}

/** Spreadsheet apps execute cells starting with = + - @ (and tab/CR): prefix them so the report stays inert. */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportCsv(errors: readonly RowError[]): string {
  return (
    [
      "row,column,error",
      ...errors.map((e) => [e.row, e.column, e.error].map(csvCell).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
