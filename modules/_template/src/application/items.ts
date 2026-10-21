import { toUuid7 } from "@wise-biz/ids";

import { newItem } from "../domain/item.ts";
import { TEMPLATE_ITEM_TOPIC, TemplateItemCreatedV1 } from "../events.ts";

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
  return toDto(item, children);
}

export interface CreateItemCommandCtx {
  tenant: { tenantId: string };
  userId: string;
  requestId: string;
  now: Date;
}

/**
 * Create + audit entry + outbox event, for runCommand (which appends audit/outbox and the idempotency
 * key in the SAME transaction). Statements: 1 item insert, 1 children insert (only when children exist).
 */
export async function createItemCommand(
  deps: { repo: ItemRepository; clock: Clock; ids: Ids },
  tx: Tx,
  ctx: CreateItemCommandCtx,
  input: { name: string; children?: readonly string[] | undefined },
) {
  const tenantId = ctx.tenant.tenantId;
  const dto = await createItem(deps, tx, tenantId, input);
  const childCount = dto.children?.length ?? 0;
  const event = TemplateItemCreatedV1.parse({
    id: deps.ids.uuidv7(),
    type: TemplateItemCreatedV1.type,
    version: TemplateItemCreatedV1.version,
    source: "api/template",
    tenantId,
    subject: `item/${dto.id}`,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data: { itemId: dto.id, name: dto.name, childCount },
  });
  return {
    status: 201 as const,
    body: dto,
    audit: [
      {
        action: "template.item.created",
        entity: "template.item",
        entityId: dto.id,
        after: dto,
      },
    ],
    events: [
      {
        id: event.id,
        topic: TEMPLATE_ITEM_TOPIC,
        key: dto.id,
        type: event.type,
        version: event.version,
        payload: event,
      },
    ],
  };
}
