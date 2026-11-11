import { toMessage } from "./rows.ts";

import type { MessageRow, TicketMessage } from "./rows.ts";
import type { TxHandle } from "@wise-biz/db";

/** Who reads the thread: the platform sees internal notes; a tenant never does. */
export type Viewer = "tenant" | "platform";

/** A ticket's thread is returned whole up to this many messages; beyond it the detail sets `messagesTruncated`. */
export const MESSAGE_DETAIL_LIMIT = 200;

/**
 * The thread in order. `tenant` viewers get the internal filter in SQL, so an internal note cannot leak through a
 * forgotten client-side filter. One query, no per-message reads.
 */
export async function messagesOf(
  tx: TxHandle,
  tenantId: string,
  ticketId: string,
  viewer: Viewer,
): Promise<{ messages: TicketMessage[]; truncated: boolean }> {
  const internalFilter = viewer === "tenant" ? " and not internal" : "";
  const r = await tx.query<MessageRow>(
    `select id, author_kind, author_id, body, internal, created_at
       from support.ticket_messages
      where tenant_id = $1 and ticket_id = $2${internalFilter}
      order by created_at, id
      limit $3`,
    [tenantId, ticketId, MESSAGE_DETAIL_LIMIT + 1],
  );
  return {
    messages: r.rows.slice(0, MESSAGE_DETAIL_LIMIT).map(toMessage),
    truncated: r.rows.length > MESSAGE_DETAIL_LIMIT,
  };
}
