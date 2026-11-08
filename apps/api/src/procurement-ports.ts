import { recordMovements } from "@wise-biz/module-inventory";

import type { RefsPort, StockPort } from "@wise-biz/module-procurement";

/**
 * Procurement receives stock through the inventory port and checks references through the composition root, in the
 * caller's tenant transaction (RLS applies). Modules never read each other's tables (AGENTS.md rule 9); these are the
 * same bridges the other modules get, wired here once.
 */
export const procurementStock: StockPort = { recordMovements };

export const procurementRefs: RefsPort = {
  branchExists: async (tx, tenantId, branchId) => {
    const r = await tx.query(
      "select 1 from tenancy.branches where tenant_id = $1 and id = $2 and archived_at is null",
      [tenantId, branchId],
    );
    return r.rowCount === 1;
  },
  locationExists: async (tx, tenantId, locationId) => {
    const r = await tx.query(
      "select 1 from tenancy.locations where tenant_id = $1 and id = $2 and archived_at is null",
      [tenantId, locationId],
    );
    return r.rowCount === 1;
  },
  variantsExist: async (tx, tenantId, variantIds) => {
    if (variantIds.length === 0) return new Set();
    // The inventory projection of the catalog (what sales checks too): active variants only, one indexed query.
    const r = await tx.query<{ variant_id: string }>(
      `select variant_id from inventory.variant_facts
        where tenant_id = $1 and variant_id = any($2::uuid[]) and archived = false`,
      [tenantId, [...variantIds]],
    );
    return new Set(r.rows.map((x) => x.variant_id));
  },
};
