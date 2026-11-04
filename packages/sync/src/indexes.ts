import type { Dataset, PullChange } from "./pull.ts";
import type { LocalDb } from "./storage/local-db.ts";

export interface VariantHit {
  readonly variantId: string;
  readonly name: string;
  readonly sku: string;
}

/** Splits free text into FTS tokens: letters and digits only, so no user input ever reaches MATCH as syntax. */
export function ftsQuery(text: string): string | undefined {
  const tokens = text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu);
  if (tokens === null || tokens.length === 0) return undefined;
  // Every token must match; the last one is a prefix so results appear while the cashier types.
  return tokens
    .slice(0, 8)
    .map((t, i, all) => `"${t}"${i === all.length - 1 ? "*" : ""}`)
    .join(" ");
}

/** Letters and digits only, lower-cased: the tokens both search engines work from. */
function tokensOf(text: string): string[] {
  return (text.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 8)
    .map((t) => t.toLowerCase());
}

interface BarcodePayload {
  readonly variantId: string;
  readonly codes: readonly string[];
}

/**
 * In-memory lookups that must not touch SQLite on the checkout hot path. The barcode map (`Map<code, variantId>`) is
 * built from the pulled `barcodes` entities and updated from each page as it is applied; scanning is one Map read.
 * Text search stays in SQLite (FTS5), which is fast enough for typing.
 */
export function createIndexes(db: LocalDb) {
  const byCode = new Map<string, string>();
  const codesOf = new Map<string, readonly string[]>();

  function setCodes(variantId: string, codes: readonly string[]): void {
    for (const old of codesOf.get(variantId) ?? []) {
      if (byCode.get(old) === variantId) byCode.delete(old);
    }
    for (const code of codes) byCode.set(code, variantId);
    if (codes.length === 0) codesOf.delete(variantId);
    else codesOf.set(variantId, codes);
  }

  let fts: boolean | undefined;
  /** Web SQLite builds may lack FTS5; the migration then created a plain table and search scans it. */
  async function hasFts(): Promise<boolean> {
    fts ??= (
      (await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'variant_search'"))
        ?.sql ?? ""
    )
      .toUpperCase()
      .includes("VIRTUAL");
    return fts;
  }

  return {
    /** Rebuilds everything from the database (startup, after a snapshot replaced the catalog). */
    async load(): Promise<void> {
      const rows = await db.all<{ payload: string }>(
        "SELECT payload FROM entities WHERE dataset = 'catalog' AND entity = 'barcodes'",
      );
      // Scans keep working on the old map until the new one is complete, then it is swapped in whole.
      byCode.clear();
      codesOf.clear();
      for (const r of rows) {
        const p = JSON.parse(r.payload) as BarcodePayload;
        setCodes(p.variantId, p.codes);
      }
    },

    /** Applies a committed page. */
    apply(dataset: Dataset, changes: readonly PullChange[]): void {
      if (dataset !== "catalog") return;
      for (const c of changes) {
        if (c.entity !== "barcodes") continue;
        if (c.op === "delete") setCodes(c.entityId, []);
        else {
          const p = c.payload as BarcodePayload;
          setCodes(p.variantId, p.codes);
        }
      }
    },

    /** The variant a scanned code belongs to, or undefined. */
    variantForBarcode: (code: string): string | undefined => byCode.get(code),
    get barcodeCount(): number {
      return byCode.size;
    },

    /** Variants whose name or SKU matches what the cashier typed (prefix on the last word), best first. */
    async search(text: string, limit = 20): Promise<VariantHit[]> {
      const q = ftsQuery(text);
      if (q === undefined) return [];
      if (!(await hasFts())) {
        // Same contract without FTS5: every token starts a word of the name or the SKU (the last one is a prefix too).
        const tokens = tokensOf(text);
        const clause = tokens
          .map(() => "(lower(s.name) LIKE ? OR lower(s.name) LIKE ? OR lower(s.sku) LIKE ?)")
          .join(" AND ");
        // Tokens are letters and digits only, so they carry no LIKE wildcards.
        const params = tokens.flatMap((t) => [`${t}%`, `% ${t}%`, `${t}%`]);
        return db.all<VariantHit>(
          `SELECT i.variant_id AS variantId, s.name AS name, s.sku AS sku
           FROM variant_search s JOIN variant_index i ON i.variant_rowid = s.rowid
           WHERE ${clause} ORDER BY length(s.name), s.name LIMIT ?`,
          [...params, limit],
        );
      }
      return db.all<VariantHit>(
        `SELECT i.variant_id AS variantId, s.name AS name, s.sku AS sku
         FROM variant_search s JOIN variant_index i ON i.variant_rowid = s.rowid
         WHERE variant_search MATCH ? ORDER BY rank LIMIT ?`,
        [q, limit],
      );
    },
  };
}

export type Indexes = ReturnType<typeof createIndexes>;
