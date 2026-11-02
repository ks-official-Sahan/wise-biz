"use client";

import { useState } from "react";

import {
  Alert,
  Button,
  Empty,
  LinkButton,
  Row,
  SelectField,
  Stack,
  cx,
  styles,
} from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { barRuns, ean13Modules, isEan13, sheetCount, toEan13, toZpl } from "@/lib/labels.ts";

import s from "../stock.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { LabelItem } from "@/lib/labels.ts";

const PER_SHEET = 24;

/** Prefer a code that draws as EAN-13 or UPC-A; otherwise the first code; otherwise none. */
function bestCode(codes: readonly string[] | undefined): string | null {
  const all = codes ?? [];
  return all.find((c) => toEan13(c) !== null) ?? all[0] ?? null;
}

function Bars({ code }: { code: string }) {
  const modules = ean13Modules(code);
  if (modules === null) return <span className={s.labelMeta}>{code}</span>;
  const shown = toEan13(code) ?? code;
  return (
    <svg
      viewBox="0 0 95 40"
      role="img"
      aria-label={`Barcode ${shown}`}
      width="100%"
      preserveAspectRatio="none"
      style={{ maxWidth: 160, height: 44 }}
    >
      {barRuns(modules).map((r) => (
        <rect key={r.x} x={r.x} y={0} width={r.w} height={40} fill="#000" />
      ))}
    </svg>
  );
}

export default function LabelsPage() {
  const [items, setItems] = useState<readonly LabelItem[]>([]);
  const [format, setFormat] = useState<"sheet" | "zpl">("sheet");
  const [copied, setCopied] = useState(false);

  const add = (h: Hit) => {
    setCopied(false);
    setItems((cur) =>
      cur.some((i) => i.variantId === h.variantId)
        ? cur
        : [
            ...cur,
            {
              variantId: h.variantId,
              name: h.title,
              sku: h.sku,
              code: bestCode(h.barcodes),
              price: "",
              copies: 1,
            },
          ],
    );
  };
  const patch = (variantId: string, p: Partial<LabelItem>) => {
    setCopied(false);
    setItems((cur) => cur.map((i) => (i.variantId === variantId ? { ...i, ...p } : i)));
  };
  const zpl = toZpl(items);
  const totals = sheetCount(items, PER_SHEET);
  const noCode = items.filter((i) => i.code === null);
  const sheet = items.flatMap((i) =>
    Array.from({ length: Math.min(Math.max(i.copies, 0), 200) }, (_, n) => ({ item: i, n })),
  );

  async function copyZpl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(zpl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  function downloadZpl(): void {
    const url = URL.createObjectURL(new Blob([zpl], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "labels.zpl";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Stack>
      <Row spread>
        <h1 className={s.noPrint}>Print labels</h1>
        <span className={s.noPrint}>
          <LinkButton variant="secondary" href="/stock">
            Back to stock
          </LinkButton>
        </span>
      </Row>

      <div className={cx(s.noPrint, s.form)}>
        <VariantPicker label="Add a product" onPick={add} />
        {items.length === 0 ? (
          <Empty title="No labels yet">Search for a product to add its label.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Labels to print</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Barcode</th>
                  <th scope="col">Price on label</th>
                  <th scope="col" className={s.num}>
                    Copies
                  </th>
                  <th scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.variantId}>
                    <th scope="row">
                      {i.name} <span className={styles.muted}>{i.sku}</span>
                    </th>
                    <td>
                      {i.code ?? "None"}
                      {i.code !== null && !isEan13(i.code) && toEan13(i.code) === null
                        ? " (not EAN-13)"
                        : ""}
                    </td>
                    <td>
                      <input
                        className={styles.input}
                        aria-label={`Price on the label for ${i.name}`}
                        value={i.price}
                        maxLength={16}
                        onChange={(e) => {
                          patch(i.variantId, { price: e.target.value });
                        }}
                      />
                    </td>
                    <td className={s.num}>
                      <input
                        className={styles.input}
                        type="number"
                        min={1}
                        max={200}
                        aria-label={`Copies of ${i.name}`}
                        value={i.copies}
                        onChange={(e) => {
                          const n = Math.floor(Number(e.target.value));
                          patch(i.variantId, {
                            copies: Number.isFinite(n) ? Math.min(Math.max(n, 0), 200) : 1,
                          });
                        }}
                      />
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setCopied(false);
                          setItems((cur) => cur.filter((x) => x.variantId !== i.variantId));
                        }}
                      >
                        {`Remove ${i.name}`}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {noCode.length === 0 ? null : (
          <Alert tone="info">
            {`${String(noCode.length)} product(s) have no barcode, so their label shows the name and SKU only. Add a barcode in Products.`}
          </Alert>
        )}
        {format === "sheet" && items.some((i) => i.code !== null && toEan13(i.code) === null) ? (
          <Alert tone="info">
            Some barcodes are not EAN-13 and cannot be drawn on the A4 sheet. Their label shows the
            code as text; print those on a label printer.
          </Alert>
        ) : null}
        {items.length === 0 ? null : (
          <>
            <SelectField
              label="Print as"
              value={format}
              options={[
                {
                  value: "sheet",
                  label: `A4 sheet (${String(PER_SHEET)} labels per page, from any printer)`,
                },
                { value: "zpl", label: "Label printer (ZPL, 50 x 30 mm)" },
              ]}
              onChange={(e) => {
                setCopied(false);
                setFormat(e.target.value as "sheet" | "zpl");
              }}
            />
            <p className={styles.muted}>
              {`${String(totals.labels)} label(s)`}
              {format === "sheet" ? `, ${String(totals.sheets)} sheet(s)` : ""}
            </p>
            <Row>
              {format === "sheet" ? (
                <Button
                  onClick={() => {
                    globalThis.print();
                  }}
                  disabled={totals.labels === 0}
                >
                  Print sheet
                </Button>
              ) : (
                <>
                  <Button onClick={() => void copyZpl()} disabled={totals.labels === 0}>
                    Copy ZPL
                  </Button>
                  <Button variant="secondary" onClick={downloadZpl} disabled={totals.labels === 0}>
                    Download .zpl
                  </Button>
                </>
              )}
            </Row>
            {copied ? <p role="status">Copied. Send it to the printer.</p> : null}
          </>
        )}
      </div>

      {items.length === 0 ? null : format === "zpl" ? (
        <pre className={cx(s.zpl, s.noPrint)} aria-label="ZPL preview" tabIndex={0}>
          {zpl}
        </pre>
      ) : (
        <div className={s.sheet} aria-label="Label preview">
          {sheet.map(({ item, n }) => (
            <div key={`${item.variantId}-${String(n)}`} className={s.label}>
              <span className={s.labelName}>{item.name}</span>
              {item.code === null ? null : <Bars code={item.code} />}
              <span className={s.labelMeta}>
                {item.sku}
                {item.price === "" ? "" : ` · ${item.price}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </Stack>
  );
}
