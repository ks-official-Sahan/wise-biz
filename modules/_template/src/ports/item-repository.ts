import type { Child, Item } from "../domain/item.ts";
import type { TxHandle } from "@wise-biz/db";

export type Tx = TxHandle;

export interface Clock {
  now(): number;
}
export interface Ids {
  uuidv7(): string;
}

export interface ItemRepository {
  /** Keyset page: fetches `limit + 1` rows (lookahead) ordered by id; `hasMore` is true when the extra row existed. ONE query. */
  list(
    tx: Tx,
    q: { tenantId: string; limit: number; after?: string | undefined },
  ): Promise<{ items: Item[]; hasMore: boolean }>;
  /** Batched: ONE query for all ids, never per item. */
  childrenFor(tx: Tx, tenantId: string, itemIds: readonly string[]): Promise<Map<string, Child[]>>;
  /** Item plus its children (one multi-row insert each). */
  create(tx: Tx, item: Item, children: readonly Child[]): Promise<void>;
}
