import { toUuid7 } from "@wise-biz/ids";

import { newItem } from "../domain/item.ts";

import { afterWrite } from "./after-write.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";

import type { Child, Item } from "../domain/item.ts";
import type { Clock, Ids, ItemRepository, Tx } from "../ports/item-repository.ts";
import type { ItemDto } from "../schemas.ts";

const toDto = (item: Item, children?: readonly Child[]): ItemDto => ({
  id: toUuid7(item.id),
  name: item.name,
  createdAt: item.createdAt.toISOString(),
  ...(children && {
    children: children.map((c) => ({
      id: toUuid7(c.id),
      label: c.label,
      createdAt: c.createdAt.toISOString(),
    })),
  }),
});

export interface ListItemsInput {
  limit: number;
  after?: string | undefined;
  include?: readonly "children"[] | undefined;
}

/** 1 query, or 2 with include=children (never per row). Caller supplies the tenant tx and has authorized. */
export async function listItems(
  deps: { repo: ItemRepository },
  tx: Tx,
  tenantId: string,
  input: ListItemsInput,
): Promise<{ items: ItemDto[]; nextCursor: string | null }> {
  const after = input.after === undefined ? undefined : decodeCursor(input.after);
  const page = await deps.repo.list(tx, { tenantId, limit: input.limit, after });
  const byItem = input.include?.includes("children")
    ? await deps.repo.childrenFor(
        tx,
        tenantId,
        page.items.map((i) => i.id),
      )
    : undefined;
  const last = page.items.at(-1);
  return {
    items: page.items.map((i) => toDto(i, byItem && (byItem.get(i.id) ?? []))),
    nextCursor: page.hasMore && last ? encodeCursor(last.id) : null,
  };
}

export async function createItem(
  deps: { repo: ItemRepository; clock: Clock; ids: Ids },
  tx: Tx,
  tenantId: string,
  input: { name: string; children?: readonly string[] | undefined },
): Promise<ItemDto> {
  const { item, children } = newItem(input, {
    tenantId,
    nextId: () => deps.ids.uuidv7(),
    now: new Date(deps.clock.now()),
  });
  await deps.repo.create(tx, item, children);
  await afterWrite(tx, tenantId, item);
  return toDto(item, children);
}
