import { execFileSync } from "node:child_process";

// SPDX ids accepted for dependencies. Anything else is an offender.
const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

// Reviewed exceptions: package name -> the exact license string it reports.
// Add an entry only with a written reason in the comment.
const EXCEPTIONS = new Map<string, string>([
  // Browser-support data table (browserslist), not shipped in app bundles.
  ["caniuse-lite", "CC-BY-4.0"],
]);

type LicenseEntry = { name: string; versions?: string[] };
type LicenseReport = Record<string, LicenseEntry[]>;

// Evaluates an SPDX expression: OR needs one allowed branch, AND needs all.
// Throws on malformed input so unparseable licenses count as offenders.
function allowedExpression(expr: string): boolean {
  const tokens = expr
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let pos = 0;
  const peekOp = (): string | undefined => tokens[pos]?.toUpperCase();

  function parseOr(): boolean {
    let value = parseAnd();
    while (peekOp() === "OR") {
      pos++;
      value = parseAnd() || value;
    }
    return value;
  }

  function parseAnd(): boolean {
    let value = parseAtom();
    while (peekOp() === "AND") {
      pos++;
      value = parseAtom() && value;
    }
    return value;
  }

  function parseAtom(): boolean {
    const token = tokens[pos++];
    if (
      token === undefined ||
      token === ")" ||
      token.toUpperCase() === "AND" ||
      token.toUpperCase() === "OR"
    ) {
      throw new Error(`malformed SPDX expression: ${expr}`);
    }
    if (token === "(") {
      const value = parseOr();
      if (tokens[pos++] !== ")") throw new Error(`missing ) in: ${expr}`);
      return value;
    }
    if (peekOp() === "WITH") {
      // Exception clause: judged by its base license only.
      pos += 2;
    }
    return ALLOWED.has(token);
  }

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in: ${expr}`);
  return result;
}

const raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod", "--recursive"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
const report = JSON.parse(raw) as LicenseReport;

const offenders = new Map<string, Set<string>>();
for (const [license, entries] of Object.entries(report)) {
  for (const entry of entries) {
    if (EXCEPTIONS.get(entry.name) === license) continue;
    let ok = false;
    try {
      ok = allowedExpression(license);
    } catch {
      ok = false;
    }
    if (ok) continue;
    const list = offenders.get(license) ?? new Set<string>();
    list.add(entry.name);
    offenders.set(license, list);
  }
}

if (offenders.size > 0) {
  console.error("Disallowed licenses:");
  for (const [license, names] of offenders) {
    console.error(`  ${license} -> ${[...names].sort().join(", ")}`);
  }
  process.exitCode = 1;
} else {
  const count = Object.values(report).reduce((sum, entries) => sum + entries.length, 0);
  console.log(`License check passed (${count} packages).`);
}
