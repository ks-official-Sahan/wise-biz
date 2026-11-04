"use client";

import { useQuery } from "@tanstack/react-query";
import { COLOR_NAMES, PLATFORM_THEME, resolveTheme, validateTheme } from "@wise-biz/theme";

import { api } from "./api.ts";

import type { ContrastIssue, Mode, ResolvedTheme, ThemeInput } from "@wise-biz/theme";

// ---- shapes (mirror modules/theming/src/schemas.ts) ----

export interface ThemeVersion {
  readonly id: string;
  readonly version: number | null;
  readonly status: "draft" | "published" | "archived";
  readonly name: string;
  readonly input: ThemeInput;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}
export interface ThemeState {
  readonly published: ThemeVersion | null;
  readonly draft: ThemeVersion | null;
}

export const BLOCKS = [
  { type: "logo", label: "Logo" },
  { type: "business", label: "Business name and address" },
  { type: "sale-info", label: "Sale number, date and cashier" },
  { type: "lines", label: "Items" },
  { type: "totals", label: "Totals and tax" },
  { type: "payments", label: "Payments and change" },
  { type: "text", label: "Free text" },
  { type: "qr", label: "QR code (digital receipt)" },
  { type: "barcode", label: "Receipt barcode" },
] as const;
export type BlockType = (typeof BLOCKS)[number]["type"];
export interface ReceiptBlock {
  readonly type: BlockType;
  readonly text?: string | undefined;
  readonly align?: "left" | "center" | "right" | undefined;
}
export interface ReceiptTemplate {
  readonly id: string;
  readonly branchId: string | null;
  readonly version: number;
  readonly paper: "58" | "80";
  readonly invoicePrefix: string;
  readonly footerText: string;
  readonly blocks: readonly ReceiptBlock[];
  readonly updatedAt: string;
}

export const brandingKeys = {
  theme: (t: string) => [t, "branding", "theme"] as const,
  versions: (t: string) => [t, "branding", "versions"] as const,
  receipts: (t: string) => [t, "branding", "receipts"] as const,
};

export const useThemeState = (t: string) =>
  useQuery({
    queryKey: brandingKeys.theme(t),
    queryFn: ({ signal }) => api<ThemeState>("GET", "/v1/theming/theme", { signal }),
    staleTime: 0,
  });

export const useThemeVersions = (t: string) =>
  useQuery({
    queryKey: brandingKeys.versions(t),
    queryFn: ({ signal }) =>
      api<{ versions: ThemeVersion[] }>("GET", "/v1/theming/theme/versions", { signal }),
    staleTime: 0,
    select: (d) => d.versions,
  });

export const useReceiptTemplates = (t: string) =>
  useQuery({
    queryKey: brandingKeys.receipts(t),
    queryFn: ({ signal }) =>
      api<{ templates: ReceiptTemplate[] }>("GET", "/v1/theming/receipt-templates", { signal }),
    staleTime: 0,
    select: (d) => d.templates,
  });

// ---- theme editing ----

export const BODY_FONT_OPTIONS = [
  { value: "geist", label: "Geist" },
  { value: "inter", label: "Inter" },
  { value: "ibm-plex-sans", label: "IBM Plex Sans" },
  { value: "noto-sans", label: "Noto Sans" },
] as const;
export const NUMERIC_FONT_OPTIONS = [
  { value: "geist-mono", label: "Geist Mono" },
  { value: "ibm-plex-mono", label: "IBM Plex Mono" },
  { value: "jetbrains-mono", label: "JetBrains Mono" },
] as const;

/** What the editor starts from: the draft, else what is live, else the platform theme. */
export function startingInput(state: ThemeState): ThemeInput {
  return state.draft?.input ?? state.published?.input ?? PLATFORM_THEME;
}

/** A `#rrggbb` the person typed, normalised to lower case; null when it is not one. */
export function cleanHex(text: string): string | null {
  const t = text.trim().replace(/^(?!#)/, "#");
  return /^#[0-9a-f]{6}$/i.test(t) ? t.toLowerCase() : null;
}

/** The brand colour as text, whether the document stores it as #rrggbb or as a DTCG colour. */
export function seedText(c: ThemeInput["brand"]["seed"]): string {
  if (typeof c === "string") return c.toLowerCase();
  if (c.hex !== undefined) return c.hex.toLowerCase();
  const [r, g, b] = c.components.map((x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${r ?? "00"}${g ?? "00"}${b ?? "00"}`;
}

export interface Preview {
  readonly resolved: ResolvedTheme | null;
  readonly issues: readonly ContrastIssue[];
  readonly error: string | null;
}

/** Resolve exactly as a terminal does (platform theme under the tenant's), and list the contrast failures. */
export function previewOf(input: ThemeInput): Preview {
  try {
    const resolved = resolveTheme({ platform: PLATFORM_THEME, tenant: input });
    return { resolved, issues: validateTheme(resolved), error: null };
  } catch (e) {
    return {
      resolved: null,
      issues: [],
      error: e instanceof Error ? e.message : "This theme cannot be shown.",
    };
  }
}

/** The pair in plain words: "Text on accent buttons is 1.05:1, needs 4.5:1". */
export function describeIssue(i: ContrastIssue): string {
  return `${i.mode === "light" ? "Light" : "Dark"} mode: ${spaced(i.fg)} on ${spaced(i.bg)} is ${i.ratio.toFixed(2)}:1, needs ${String(i.required)}:1.`;
}
const spaced = (name: string): string => name.replace(/([A-Z])/g, " $1").toLowerCase();

/**
 * One-click fix: when the failing background is one the owner overrode (accent, canvas or surface), put the suggested
 * colour in its place. Other failures come from the brand colour itself: the fix is a different brand colour.
 */
export function applyFix(input: ThemeInput, issue: ContrastIssue): ThemeInput | null {
  const overridable = ["accent", "canvas", "surface"] as const;
  const bg = overridable.find((n) => n === issue.bg);
  const mine = input.overrides?.[issue.mode];
  if (bg === undefined || issue.suggestion === undefined || mine?.[bg] === undefined) return null;
  return {
    ...input,
    overrides: { ...input.overrides, [issue.mode]: { ...mine, [bg]: issue.suggestion } },
  };
}

/** Inline custom properties for a scoped preview: every colour token of one mode, as --pv-<name>. */
export function previewVars(theme: ResolvedTheme, mode: Mode): Record<string, string> {
  const tokens = theme.tokens[mode] ?? theme.tokens[theme.modes.default];
  const vars: Record<string, string> = {};
  if (tokens === undefined) return vars;
  for (const name of COLOR_NAMES)
    vars[`--pv-${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`] = tokens.color[name];
  vars["--pv-radius"] = `${String(theme.scales.radius.card)}px`;
  return vars;
}

// ---- receipts ----

export const DEFAULT_BLOCKS: readonly ReceiptBlock[] = [
  { type: "logo", align: "center" },
  { type: "business", align: "center" },
  { type: "sale-info" },
  { type: "lines" },
  { type: "totals" },
  { type: "payments" },
  { type: "text", text: "Thank you!", align: "center" },
  { type: "qr", align: "center" },
];

/** Move block `index` one place up (-1) or down (+1); out of range leaves the list as it is. */
export function moveBlock<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  const out = [...list];
  const item = out[index];
  if (item === undefined || to < 0 || to >= out.length) return out;
  out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

/** Why a layout cannot be saved, in the words of the editor. */
export function templateProblems(blocks: readonly ReceiptBlock[], prefix: string): string[] {
  const out: string[] = [];
  if (!blocks.some((b) => b.type === "lines")) out.push("A receipt needs the items block.");
  if (!blocks.some((b) => b.type === "totals")) out.push("A receipt needs the totals block.");
  if (blocks.length > 30) out.push("A receipt can have at most 30 blocks.");
  if (!/^[A-Z0-9-]{0,8}$/.test(prefix))
    out.push("The invoice prefix is up to 8 capital letters, digits or dashes.");
  return out;
}

export interface SampleSale {
  readonly business: string;
  readonly address: string;
  readonly number: string;
  readonly when: string;
  readonly cashier: string;
  readonly lines: readonly { name: string; qty: number; total: string }[];
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
  readonly paid: string;
  readonly change: string;
}
export const SAMPLE_SALE: SampleSale = {
  business: "Sample Cafe",
  address: "12 Main Street",
  number: "42",
  when: "2026-11-03 10:15",
  cashier: "Ayesha",
  lines: [
    { name: "Flat white", qty: 2, total: "9.00" },
    { name: "Almond croissant", qty: 1, total: "4.50" },
  ],
  subtotal: "13.50",
  tax: "1.08",
  total: "14.58",
  paid: "20.00",
  change: "5.42",
};

const align = (text: string, width: number, a: ReceiptBlock["align"]): string => {
  const t = text.slice(0, width);
  if (a === "center") return " ".repeat(Math.floor((width - t.length) / 2)) + t;
  if (a === "right") return " ".repeat(width - t.length) + t;
  return t;
};
const row = (left: string, right: string, width: number): string =>
  left.slice(0, Math.max(0, width - right.length - 1)).padEnd(width - right.length) + right;

/** Characters per line on the paper: the same counts the receipt printer uses (58 mm: 32, 80 mm: 48). */
export const paperWidth = (paper: "58" | "80"): number => (paper === "58" ? 32 : 48);

/** A text rendering of the receipt at the paper width, from the block list and a sample sale. */
export function renderPreview(
  blocks: readonly ReceiptBlock[],
  paper: "58" | "80",
  invoicePrefix: string,
  footerText: string,
  sale: SampleSale = SAMPLE_SALE,
): string[] {
  const w = paperWidth(paper);
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "logo") out.push(align("[ LOGO ]", w, b.align ?? "center"));
    else if (b.type === "business") {
      out.push(
        align(sale.business, w, b.align ?? "center"),
        align(sale.address, w, b.align ?? "center"),
      );
    } else if (b.type === "sale-info") {
      out.push(
        row(`Sale ${invoicePrefix}${sale.number}`, sale.when.slice(11), w),
        row(`Cashier ${sale.cashier}`, sale.when.slice(0, 10), w),
      );
    } else if (b.type === "lines") {
      out.push("-".repeat(w));
      for (const l of sale.lines) out.push(row(`${String(l.qty)} x ${l.name}`, l.total, w));
      out.push("-".repeat(w));
    } else if (b.type === "totals") {
      out.push(
        row("Subtotal", sale.subtotal, w),
        row("Tax", sale.tax, w),
        row("TOTAL", sale.total, w),
      );
    } else if (b.type === "payments") {
      out.push(row("Cash", sale.paid, w), row("Change", sale.change, w));
    } else if (b.type === "text") out.push(align(b.text ?? "", w, b.align ?? "left"));
    else if (b.type === "qr") out.push(align("[ QR ]", w, b.align ?? "center"));
    else out.push(align("||| ||| || |||", w, b.align ?? "center"));
  }
  if (footerText !== "") out.push(align(footerText, w, "center"));
  return out;
}
