import type { Child, Item } from "../domain/item.ts";
import type { TxHandle } from "@wise-biz/db";

export type Tx = TxHandle;

export interface Clock {
  now(): number;
}
export interface Ids {
  uuidv7(): string;
}

/** Max page size (PageQuery limit), hence max item ids per `childrenFor` call. */
export const MAX_CHILDREN_LOOKUP = 200;

export interface ItemRepository {
  /** Keyset page: fetches `limit + 1` rows (lookahead) ordered by id; `hasMore` is true when the extra row existed. ONE query. */
  list(
    tx: Tx,
    q: { tenantId: string; limit: number; after?: string | undefined },
  ): Promise<{ items: Item[]; hasMore: boolean }>;
  /** Batched: ONE query for all ids, never per item. Throws RangeError above MAX_CHILDREN_LOOKUP (200) ids. */
  childrenFor(tx: Tx, tenantId: string, itemIds: readonly string[]): Promise<Map<string, Child[]>>;
  /**
   * Item plus its children (one multi-row insert each). Children are capped at 20 by CreateItemSchema.
   * Future bulk inserts: Postgres allows at most 65535 bind parameters per statement, so chunk rows
   * (rows x columns <= 65535) and insert the chunks inside the same tx.
   */
  create(tx: Tx, item: Item, children: readonly Child[]): Promise<void>;
}
