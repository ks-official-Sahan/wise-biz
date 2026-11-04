import { createRoute, z } from "@hono/zod-openapi";
import { defineEvent } from "@wise-biz/contracts";
import { appendAudit, appendOutbox, withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { asRouteResponse, authorize, requireTenant, requireUser } from "@wise-biz/module-kit";

import { csvLine } from "./csv.ts";
import { findAuditEntry, listAuditEntries } from "./read.ts";

import type { AuditCursor, AuditFilter, AuditListRow } from "./read.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { Context, MiddlewareHandler } from "hono";

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
/** Export cap: the response is built in memory. Larger ranges are split by date in the console. */
export const MAX_EXPORT_ROWS = 10_000;

export const AuditExportRequestedV1 = defineEvent(
  "audit.export.requested",
  1,
  z.object({
    tenantId: z.string(),
    rows: z.number().int(),
    filter: z.record(z.string(), z.string()),
  }),
);
export const AUDIT_EVENTS = [AuditExportRequestedV1] as const;

const Token = z.string().max(200);
const FilterQuery = z.object({
  actor: Token.optional(),
  action: Token.optional(),
  entity: Token.optional(),
  entityId: Token.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const ListQuery = FilterQuery.extend({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  cursor: z.string().max(200).optional(),
});

const Actor = z.object({ type: z.string(), id: z.string() });
const EntryRow = z
  .object({
    id: z.string(),
    at: z.string(),
    actor: Actor,
    action: z.string(),
    entity: z.object({ type: z.string(), id: z.string().nullable() }),
    requestId: z.string(),
  })
  .meta({ id: "AuditEntry" });
const EntryList = z
  .object({ entries: z.array(EntryRow), nextCursor: z.string().nullable() })
  .meta({ id: "AuditEntryList" });
const EntryDetail = EntryRow.extend({
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
  chained: z.boolean(),
}).meta({ id: "AuditEntryDetail" });

/** Opaque keyset cursor: base64url of `at|id`. Malformed cursors are a 422, never a server error. */
export function encodeCursor(c: AuditCursor): string {
  return Buffer.from(`${c.at}|${c.id}`).toString("base64url");
}

export function decodeCursor(raw: string): AuditCursor {
  const [at, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (
    at === undefined ||
    id === undefined ||
    extra !== undefined ||
    !/^\d{1,19}$/.test(id) ||
    // Postgres timestamptz text, e.g. "2026-10-24 12:00:00.123456+00" or "+05:30"; Postgres re-parses it.
    !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)?$/.test(at)
  ) {
    throw new DomainError("VALIDATION_FAILED", "cursor: malformed", {
      fieldErrors: [{ path: "cursor", message: "malformed" }],
    });
  }
  return { at, id };
}

function toFilter(q: z.infer<typeof FilterQuery>): AuditFilter {
  return {
    actorId: q.actor,
    action: q.action,
    entity: q.entity,
    entityId: q.entityId,
    from: q.from === undefined ? undefined : new Date(q.from),
    to: q.to === undefined ? undefined : new Date(q.to),
  };
}

const toDto = (r: AuditListRow) => ({
  id: r.publicId,
  at: r.at,
  actor: { type: r.actorType, id: r.actorId },
  action: r.action,
  entity: { type: r.entity, id: r.entityId },
  requestId: r.requestId,
});

/** Permission gate as route middleware: runs before query validation, so an unauthorized caller always gets 404. */
const can =
  (permission: "audit:read" | "audit:export"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };

const json = (c: Context<AppEnv>, body: unknown): never =>
  asRouteResponse(c.json(body as never, 200));

const listRoute = createRoute({
  method: "get",
  path: "/v1/audit/entries",
  tags: ["audit"],
  summary: "Audit log, newest first (keyset paginated; filters by actor, action, entity and time)",
  middleware: [can("audit:read")] as const,
  request: { query: ListQuery },
  responses: {
    200: { description: "Entries", content: { "application/json": { schema: EntryList } } },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/v1/audit/entries/{id}",
  tags: ["audit"],
  summary: "One audit entry with before/after for the diff view",
  middleware: [can("audit:read")] as const,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Entry", content: { "application/json": { schema: EntryDetail } } },
  },
});

const exportRoute = createRoute({
  method: "get",
  path: "/v1/audit/export",
  tags: ["audit"],
  summary: `CSV export of the filtered log (at most ${String(MAX_EXPORT_ROWS)} rows; the export is itself audited)`,
  middleware: [can("audit:export")] as const,
  request: { query: FilterQuery },
  responses: { 200: { description: "CSV", content: { "text/csv": { schema: z.string() } } } },
});

export function mountAuditRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  app.openapi(listRoute, async (c) => {
    const tenant = requireTenant(c);
    const q = c.req.valid("query");
    const limit = q.limit ?? DEFAULT_PAGE;
    const cursor = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    const rows = await withTenantTx(deps.pool, tenant, (tx) =>
      listAuditEntries(tx, toFilter(q), limit + 1, cursor),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return json(c, {
      entries: page.map(toDto),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.cursor) : null,
    });
  });

  app.openapi(detailRoute, async (c) => {
    const tenant = requireTenant(c);
    const { id } = c.req.valid("param");
    const row = await withTenantTx(deps.pool, tenant, (tx) => findAuditEntry(tx, id));
    if (row === null) throw new DomainError("NOT_FOUND", "Not found");
    return json(c, {
      ...toDto(row),
      before: row.before,
      after: row.after,
      reason: row.reason,
      chained: row.chained,
    });
  });

  app.openapi(exportRoute, async (c) => {
    const tenant = requireTenant(c);
    const { userId } = requireUser(c);
    const q = c.req.valid("query");
    const filter = Object.fromEntries(
      Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    // One transaction: the export's own audit row and outbox event commit with the read, so a download that happened
    // is always on record (and a failed read leaves no false record).
    const rows = await withTenantTx(deps.pool, tenant, async (tx) => {
      const found = await listAuditEntries(tx, toFilter(q), MAX_EXPORT_ROWS);
      const requestId = c.get("requestId");
      await appendAudit(tx, [
        {
          actorType: "user",
          actorId: userId,
          action: "audit.export.requested",
          entity: "audit.log",
          after: { rows: found.length, filter },
          requestId,
        },
      ]);
      const id = deps.ids.uuidv7();
      await appendOutbox(tx, [
        {
          id,
          topic: "audit.export",
          key: tenant.tenantId,
          type: AuditExportRequestedV1.type,
          version: AuditExportRequestedV1.version,
          payload: AuditExportRequestedV1.parse({
            id,
            type: AuditExportRequestedV1.type,
            version: AuditExportRequestedV1.version,
            source: "api/audit",
            tenantId: tenant.tenantId,
            subject: "audit/export",
            time: new Date(deps.clock.now()).toISOString(),
            correlationId: requestId,
            actor: { type: "user", id: userId },
            data: { tenantId: tenant.tenantId, rows: found.length, filter },
          }),
        },
      ]);
      return found;
    });
    let body = csvLine([
      "id",
      "at",
      "actor_type",
      "actor_id",
      "action",
      "entity",
      "entity_id",
      "request_id",
    ]);
    for (const r of rows) {
      body += csvLine([
        r.publicId,
        r.at,
        r.actorType,
        r.actorId,
        r.action,
        r.entity,
        r.entityId,
        r.requestId,
      ]);
    }
    const day = new Date(deps.clock.now()).toISOString().slice(0, 10);
    return asRouteResponse(
      c.body(body, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${day}.csv"`,
        "cache-control": "no-store",
      }),
    );
  });
}
