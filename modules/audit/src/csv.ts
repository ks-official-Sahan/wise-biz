/**
 * RFC 4180 CSV with spreadsheet formula-injection defence (OWASP "CSV injection"): a cell that starts with = + - @
 * TAB or CR is prefixed with a single quote so Excel/Sheets treat it as text. Every cell is quoted.
 */
const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else s = JSON.stringify(value);
  if (DANGEROUS.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}
