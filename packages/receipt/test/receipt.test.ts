import { describe, expect, it } from "vitest";

import {
  DRAWER_KICK,
  ditherToMono,
  encodeEscPos,
  escapeHtml,
  formatDateTime,
  formatMinor,
  qrCode,
  rasterLogo,
  renderHtml,
  row,
} from "../src/index.ts";

import type { ReceiptDoc } from "../src/index.ts";

const doc: ReceiptDoc = {
  currency: "USD",
  locale: "en-US",
  number: "Receipt 000123",
  at: "2026-11-02T10:15:00Z",
  operator: "Amara",
  store: {
    name: "Café Wise & Sons",
    address: ["12 Galle Road", "Colombo 03"],
    taxIds: ["VAT 123456789"],
  },
  header: ["Thank you for shopping with us"],
  lines: [
    { name: "Green Tea 500 g", qty: "2", unitMinor: 500, totalMinor: 1000 },
    {
      name: "Whole Milk 1 L extra long product name that must wrap",
      qty: "3",
      unitMinor: 180,
      totalMinor: 540,
      discountMinor: 60,
      note: "for Sam",
    },
  ],
  subtotalMinor: 1540,
  discountMinor: 60,
  taxes: [{ name: "VAT 10%", amountMinor: 148 }],
  roundingMinor: -3,
  totalMinor: 1625,
  tenders: [{ label: "Cash", amountMinor: 2000 }],
  changeMinor: 375,
  loyalty: { balance: "120 pts" },
  note: "Gift receipt",
  footer: ["No returns without receipt"],
  qrUrl: "https://r.example.com/abc123",
  openDrawer: true,
};

/** Bytes as text: printable ASCII as is, controls as <hex>, so a golden snapshot is reviewable in a diff. */
const view = (b: Uint8Array): string =>
  [...b]
    .map((x) =>
      x === 0x0a
        ? "\n"
        : x >= 0x20 && x < 0x7f
          ? String.fromCharCode(x)
          : `<${x.toString(16).padStart(2, "0")}>`,
    )
    .join("");

/** Printed text lines of a document without QR or logo: control commands removed, split at line feeds. */
const printed = (b: Uint8Array): string[] => {
  const params: Record<number, number> = { 0x40: 0, 0x74: 1, 0x61: 1, 0x45: 1, 0x70: 3 };
  let text = "";
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    if (x === 0x1b) i += 1 + (params[b[i + 1]!] ?? 0);
    else if (x === 0x1d) i += b[i + 1] === 0x21 ? 2 : 3;
    else text += String.fromCharCode(x);
  }
  return text.split(String.fromCharCode(10));
};

describe("ESC/POS", () => {
  it("matches the 80 mm golden receipt", () => {
    expect(view(encodeEscPos(doc, { width: 80, timeZone: "UTC" }))).toMatchSnapshot();
  });

  it("matches the 58 mm golden receipt", () => {
    expect(view(encodeEscPos(doc, { width: 58, timeZone: "UTC" }))).toMatchSnapshot();
  });

  it("never prints a text line wider than the paper", () => {
    for (const [width, cols] of [
      [58, 32],
      [80, 48],
    ] as const) {
      const lines = printed(
        encodeEscPos(
          { ...doc, qrUrl: undefined, openDrawer: false },
          { width, timeZone: "UTC", cut: false },
        ),
      );
      for (const line of lines)
        if (!line.startsWith("TOTAL")) expect(line.length).toBeLessThanOrEqual(cols);
      // The total is double width: half the columns.
      expect(lines.find((l) => l.startsWith("TOTAL"))?.length).toBeLessThanOrEqual(cols / 2);
    }
  });

  it("folds accents on CP437 and keeps them on CP858", () => {
    const d = { ...doc, store: { name: "Café Müller" } };
    expect(view(encodeEscPos(d, { codePage: 0, timeZone: "UTC" }))).toContain("Cafe Muller");
    const b = encodeEscPos(d, { codePage: 19, timeZone: "UTC" });
    expect([...b]).toContain(0x82); // é in CP858
    expect([...b]).toContain(0x81); // ü in CP858
  });

  it("replaces unprintable characters with ? and handles empty docs", () => {
    const b = view(
      encodeEscPos(
        {
          ...doc,
          store: { name: "日本" },
          lines: [],
          taxes: [],
          tenders: [],
          changeMinor: 0,
          discountMinor: 0,
          roundingMinor: 0,
          loyalty: undefined,
          note: undefined,
          footer: undefined,
          qrUrl: undefined,
          header: undefined,
          operator: undefined,
          openDrawer: false,
        },
        { timeZone: "UTC", cut: false, feed: 0 },
      ),
    );
    expect(b).toContain("??");
    expect(b).not.toContain("<1d><56>");
  });

  it("cuts, feeds and kicks the drawer", () => {
    const b = encodeEscPos(doc, { timeZone: "UTC" });
    expect([...b.slice(-5)]).toEqual([...DRAWER_KICK]);
    expect(view(b)).toContain("<1d>VB<00>");
  });

  it("prints a raster logo first", () => {
    const logo = rasterLogo([true, false, false, false, false, false, false, true, true], 9, 1);
    expect([...logo]).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 1, 0, 0x81, 0x80]);
    const b = encodeEscPos(doc, { logo, timeZone: "UTC" });
    expect([...b.slice(5, 9)]).toEqual([0x1b, 0x61, 0x01, 0x1d]);
  });

  it("builds a QR command with the right length", () => {
    const q = qrCode("abc");
    // store command: GS ( k pL pH 31 50 30 data -> pL = len + 3
    const at = q.findIndex((_, i) => q[i] === 0x31 && q[i + 1] === 0x50);
    expect(q[at - 2]).toBe(6);
    expect(q.slice(at + 3, at + 6)).toEqual([97, 98, 99]);
  });

  it("is deterministic", () => {
    expect(encodeEscPos(doc, { timeZone: "UTC" })).toEqual(encodeEscPos(doc, { timeZone: "UTC" }));
  });
});

describe("layout helpers", () => {
  it("puts the amount on the right and wraps long names", () => {
    expect(row("Tea", "1.00", 16)).toEqual(["Tea         1.00"]);
    const wrapped = row("A very long product name indeed", "12.00", 20);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.at(-1)?.endsWith("12.00")).toBe(true);
    expect(row("x", "123456789012345678", 20)).toEqual(["x", "  123456789012345678"]);
  });

  it("breaks a word longer than the paper", () => {
    const b = view(
      encodeEscPos({ ...doc, header: ["A".repeat(70)] }, { width: 58, timeZone: "UTC" }),
    );
    expect(b).toContain("A".repeat(32));
    expect(b).not.toContain("A".repeat(33));
  });

  it("dithers a gradient and keeps solid colors", () => {
    expect(ditherToMono(new Uint8Array(4).fill(0), 2, 2)).toEqual([true, true, true, true]);
    expect(ditherToMono(new Uint8Array(4).fill(255), 2, 2)).toEqual([false, false, false, false]);
    const mid = ditherToMono(new Uint8Array(16).fill(128), 4, 4);
    expect(mid.some(Boolean)).toBe(true);
    expect(mid.some((x) => !x)).toBe(true);
  });

  it("formats money by currency digits and dates", () => {
    expect(formatMinor(450, "USD", "en-US")).toBe("4.50");
    expect(formatMinor(450, "JPY", "en-US")).toBe("450");
    expect(formatDateTime("2026-11-02T10:15:00Z", "en-US", "UTC")).toContain("Nov 2, 2026");
    expect(formatDateTime("not a date", "en-US")).toBe("not a date");
  });
});

describe("HTML receipt", () => {
  it("renders every block and escapes user text", () => {
    const html = renderHtml(
      {
        ...doc,
        store: { name: "<script>alert(1)</script>" },
        lines: [
          { name: "Tea & <b>Co</b>", qty: "1", unitMinor: 100, totalMinor: 100, note: '"quoted"' },
        ],
      },
      { timeZone: "UTC" },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Tea &amp; &lt;b&gt;Co&lt;/b&gt;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("Total");
    expect(html).toContain("Change");
    expect(html).toContain("120 pts");
    expect(html).toContain('<a href="https://r.example.com/abc123">');
  });

  it("links only http(s) URLs and works without optional blocks", () => {
    const html = renderHtml({
      ...doc,
      qrUrl: "javascript:alert(1)",
      discountMinor: 0,
      roundingMinor: undefined,
      loyalty: undefined,
      note: undefined,
      changeMinor: 0,
      operator: undefined,
      lines: [{ name: "x", qty: "1", unitMinor: 1, totalMinor: 1, discountMinor: 0 }],
    });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Change");
    expect(renderHtml({ ...doc, qrUrl: "nonsense" })).not.toContain("<a ");
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });
});

describe("code page 858", () => {
  it("maps the euro sign and sharp s to their real code points", () => {
    const b = encodeEscPos(
      { ...doc, store: { name: "€ß" }, header: undefined },
      { codePage: 19, timeZone: "UTC" },
    );
    expect([...b]).toContain(0xd5);
    expect([...b]).toContain(0xe1);
  });
});
