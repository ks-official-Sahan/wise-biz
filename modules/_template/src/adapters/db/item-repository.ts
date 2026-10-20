import { and, asc, eq, gt, sql } from "drizzle-orm";

import { MAX_CHILDREN_LOOKUP } from "../../ports/item-repository.ts";

import { itemChildren, items } from "./schema.ts";

import type { Child } from "../../domain/item.ts";
import type { ItemRepository } from "../../ports/item-repository.ts";

export const drizzleItemRepository: ItemRepository = {
  async list(tx, { tenantId, limit, after }) {
    // Index: items_pkey (tenant_id, id) -> Index Scan, no sort.
    const rows = await tx.db
      .select()
      .from(items)
      .where(
        after === undefined
          ? eq(items.tenantId, tenantId)
          : and(eq(items.tenantId, tenantId), gt(items.id, after)),
      )
      .orderBy(asc(items.id))
      .limit(limit + 1);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  },

  async childrenFor(tx, tenantId, itemIds) {
    const out = new Map<string, Child[]>();
    if (itemIds.length === 0) return out;
    if (itemIds.length > MAX_CHILDREN_LOOKUP) {
      throw new RangeError(
        `childrenFor: at most ${String(MAX_CHILDREN_LOOKUP)} item ids, got ${String(itemIds.length)}`,
      );
    }
    // Index: item_children_tenant_item_idx (tenant_id, item_id, id).
    const rows = await tx.db
      .select()
      .from(itemChildren)
      .where(
        and(
          eq(itemChildren.tenantId, tenantId),
          sql`${itemChildren.itemId} = any(${sql.param([...itemIds])}::uuid[])`,
        ),
      )
      .orderBy(asc(itemChildren.itemId), asc(itemChildren.id));
    for (const r of rows) {
      const list = out.get(r.itemId);
      if (list) list.push(r);
      else out.set(r.itemId, [r]);
    }
    return out;
  },

  async create(tx, item, children) {
    await tx.db.insert(items).values(item);
    if (children.length > 0) await tx.db.insert(itemChildren).values([...children]);
  },
};
