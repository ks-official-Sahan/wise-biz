import { formatDateTime, formatMinor } from "./model.ts";

import type { ReceiptDoc } from "./model.ts";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Every value that reaches the page goes through here: names, notes and URLs come from users. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** Only http(s) links are linked; anything else prints as plain text. */
function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The digital receipt: a small self-contained HTML document (inline CSS, no scripts, no remote assets), safe to email,
 * show behind a shortlink or print from a browser.
 */
export function renderHtml(doc: ReceiptDoc, options: { timeZone?: string } = {}): string {
  const m = (v: number) => escapeHtml(formatMinor(v, doc.currency, doc.locale));
  const rows = (items: readonly { label: string; value: string; strong?: boolean }[]) =>
    items
      .map(
        (r) =>
          `<tr${r.strong === true ? ' class="strong"' : ""}><td>${escapeHtml(r.label)}</td><td class="num">${r.value}</td></tr>`,
      )
      .join("");
  const lines = doc.lines
    .map((l) => {
      const discount =
        l.discountMinor !== undefined && l.discountMinor > 0
          ? `<tr class="sub"><td>Discount</td><td class="num">-${m(l.discountMinor)}</td></tr>`
          : "";
      const note =
        l.note === undefined
          ? ""
          : `<tr class="sub"><td colspan="2">${escapeHtml(l.note)}</td></tr>`;
      return `<tr><td>${escapeHtml(l.name)}</td><td class="num">${m(l.totalMinor)}</td></tr><tr class="sub"><td>${escapeHtml(l.qty)} x ${m(l.unitMinor)}</td><td></td></tr>${discount}${note}`;
    })
    .join("");
  const totals: { label: string; value: string; strong?: boolean }[] = [
    { label: "Subtotal", value: m(doc.subtotalMinor) },
    ...(doc.discountMinor > 0 ? [{ label: "Discounts", value: `-${m(doc.discountMinor)}` }] : []),
    ...(doc.feeMinor !== undefined && doc.feeMinor > 0
      ? [{ label: "Fees", value: m(doc.feeMinor) }]
      : []),
    ...doc.taxes.map((t) => ({ label: t.name, value: m(t.amountMinor) })),
    ...(doc.roundingMinor !== undefined && doc.roundingMinor !== 0
      ? [{ label: "Rounding", value: m(doc.roundingMinor) }]
      : []),
    { label: "Total", value: m(doc.totalMinor), strong: true },
  ];
  const paid = [
    ...doc.tenders.map((t) => ({ label: t.label, value: m(t.amountMinor) })),
    ...(doc.changeMinor > 0 ? [{ label: "Change", value: m(doc.changeMinor), strong: true }] : []),
  ];
  const link = doc.qrUrl === undefined ? undefined : safeUrl(doc.qrUrl);
  const para = (items: readonly string[] | undefined) =>
    (items ?? []).map((t) => `<p>${escapeHtml(t)}</p>`).join("");
  return `<!doctype html>
<html lang="${escapeHtml(doc.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.number)}</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;background:#f4f4f4;color:#111}main{max-width:380px;margin:16px auto;background:#fff;padding:20px;border-radius:8px}h1{font-size:18px;text-align:center;margin:0 0 4px}p{margin:2px 0;text-align:center;color:#444}table{width:100%;border-collapse:collapse;margin:10px 0;border-top:1px dashed #999}td{padding:2px 0;vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}.sub td{color:#555;font-size:13px}.strong td{font-weight:700;font-size:17px}</style></head>
<body><main>
<h1>${escapeHtml(doc.store.name)}</h1>${para(doc.store.address)}${para(doc.store.taxIds)}${para(doc.header)}
<p>${escapeHtml(doc.number)}</p><p>${escapeHtml(formatDateTime(doc.at, doc.locale, options.timeZone))}</p>${doc.operator === undefined ? "" : `<p>Served by ${escapeHtml(doc.operator)}</p>`}
<table>${lines}</table>
<table>${rows(totals)}</table>
<table>${rows(paid)}</table>
${doc.loyalty === undefined ? "" : `<p>Loyalty balance: ${escapeHtml(doc.loyalty.balance)}</p>`}${doc.note === undefined ? "" : `<p>${escapeHtml(doc.note)}</p>`}${para(doc.footer)}${link === undefined ? "" : `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`}
</main></body></html>`;
}
