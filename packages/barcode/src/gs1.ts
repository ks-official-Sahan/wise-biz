/**
 * GS1 element strings (GS1-128, DataMatrix, GS1 QR): application identifiers for batch, expiry and measure.
 * Input is either the raw data with FNC1 as the group separator (0x1d) or the human form "(01)...(10)...".
 */

const GS = "\u001d";

/** AI -> [fixed length] or [min, max] for variable fields (variable fields end at GS or the end of data). */
const FIXED: Readonly<Record<string, number>> = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "13": 6,
  "15": 6,
  "17": 6,
};
const VARIABLE: Readonly<Record<string, number>> = {
  "10": 20,
  "21": 20,
  "37": 8,
  "240": 30,
  "241": 30,
};

export interface Gs1Fields {
  readonly gtin?: string;
  readonly batch?: string;
  readonly serial?: string;
  /** ISO dates (YYYY-MM-DD). A day of 00 means "end of month" per GS1, resolved here. */
  readonly productionDate?: string;
  readonly bestBefore?: string;
  readonly expiry?: string;
  /** Net weight in grams (AI 310n) or pounds*1000 (320n is not converted: see `unit`). */
  readonly netWeightG?: number;
  readonly count?: number;
}

export type Gs1Result =
  | { ok: true; fields: Gs1Fields; ais: Readonly<Record<string, string>> }
  | { ok: false; reason: string };

function toIsoDate(yymmdd: string): string | undefined {
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return undefined;
  // GS1: years 00-50 are 20xx, 51-99 are 19xx (rolling window simplified for a retail shelf life).
  const year = yy <= 50 ? 2000 + yy : 1900 + yy;
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if (dd === 0) dd = last;
  if (dd > last) return undefined;
  return `${String(year)}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function aiLength(data: string, at: number): string | undefined {
  for (const n of [2, 3, 4]) {
    const ai = data.slice(at, at + n);
    if (ai in FIXED || ai in VARIABLE) return ai;
    // 310n..369n: measures with an implied decimal point; 4 digits, fixed 6-digit value.
    if (n === 4 && /^(31|32)\d\d$/.test(ai)) return ai;
  }
  return undefined;
}

function split(
  data: string,
): { ok: true; ais: Record<string, string> } | { ok: false; reason: string } {
  const ais: Record<string, string> = {};
  const human = /\((\d{2,4})\)([^(]*)/g;
  if (data.startsWith("(")) {
    for (const m of data.matchAll(human)) {
      const v = (m[2] ?? "").replace(GS, "");
      if (v === "") return { ok: false, reason: `AI ${m[1] ?? ""} is empty` };
      ais[m[1] ?? ""] = v;
    }
    return Object.keys(ais).length > 0
      ? { ok: true, ais }
      : { ok: false, reason: "no application identifiers" };
  }
  let i = 0;
  while (i < data.length) {
    if (data[i] === GS) {
      i++;
      continue;
    }
    const ai = aiLength(data, i);
    if (ai === undefined)
      return { ok: false, reason: `unknown application identifier at ${String(i)}` };
    i += ai.length;
    const fixed = FIXED[ai] ?? (/^(31|32)\d\d$/.test(ai) ? 6 : undefined);
    if (fixed !== undefined) {
      const v = data.slice(i, i + fixed);
      if (v.length !== fixed) return { ok: false, reason: `AI ${ai} is too short` };
      ais[ai] = v;
      i += fixed;
    } else {
      const max = VARIABLE[ai] ?? 0;
      let end = data.indexOf(GS, i);
      if (end === -1) end = data.length;
      if (end - i > max || end === i) return { ok: false, reason: `AI ${ai} has a bad length` };
      ais[ai] = data.slice(i, end);
      i = end;
    }
  }
  return Object.keys(ais).length > 0 ? { ok: true, ais } : { ok: false, reason: "empty" };
}

export function parseGs1(data: string): Gs1Result {
  const s = split(data);
  if (!s.ok) return s;
  const { ais } = s;
  const out: { -readonly [K in keyof Gs1Fields]: Gs1Fields[K] } = {};
  const gtin = ais["01"];
  if (gtin !== undefined) {
    if (!/^\d{14}$/.test(gtin)) return { ok: false, reason: "AI 01 is not 14 digits" };
    out.gtin = gtin;
  }
  if (ais["10"] !== undefined) out.batch = ais["10"];
  if (ais["21"] !== undefined) out.serial = ais["21"];
  for (const [ai, key] of [
    ["11", "productionDate"],
    ["13", "bestBefore"],
    ["15", "bestBefore"],
    ["17", "expiry"],
  ] as const) {
    const v = ais[ai];
    if (v === undefined) continue;
    const d = /^\d{6}$/.test(v) ? toIsoDate(v) : undefined;
    if (d === undefined) return { ok: false, reason: `AI ${ai} is not a date` };
    out[key] = d;
  }
  for (const [ai, v] of Object.entries(ais)) {
    if (/^310\d$/.test(ai)) {
      if (!/^\d{6}$/.test(v)) return { ok: false, reason: `AI ${ai} is not numeric` };
      // 310n: kilograms with n decimals. Grams = value * 10^(3-n).
      const n = Number(ai[3]);
      out.netWeightG = Math.round(Number(v) * 10 ** (3 - n));
    }
  }
  if (ais["37"] !== undefined) {
    if (!/^\d+$/.test(ais["37"])) return { ok: false, reason: "AI 37 is not numeric" };
    out.count = Number(ais["37"]);
  }
  return { ok: true, fields: out, ais };
}
