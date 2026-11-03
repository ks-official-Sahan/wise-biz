import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { authorize, requireTenant, requireUser, runCommand } from "@wise-biz/module-kit";
import { z } from "zod";

import { CreateExportSchema, ExportListSchema, ExportSchema } from "./schemas.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { ObjectStore } from "@wise-biz/storage";
import type { MiddlewareHandler } from "hono";

const COLUMNS = `id, kind, status, params, row_count, error, created_at, finished_at, expires_at`;
const DOWNLOAD_SECONDS = 300;
const LIST_LIMIT = 30;

interface Row {
  id: string;
  kind: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  params: { from: string; to: string };
  row_count: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date;
}

const toExport = (r: Row, now: number) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  from: r.params.from,
  to: r.params.to,
  rowCount: r.row_count === null ? null : Number(r.row_count),
  error: r.error,
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  expiresAt: r.expires_at.toISOString(),
  downloadable: r.status === "ready" && r.expires_at.getTime() > now,
});

const IdParam = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "UUID"),
});

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const tags = ["reporting"];

/**
 * Tenant-wide readers only: an export covers raw sale lines built later, so a branch-limited reader gets a 404 (fail
 * closed) until a per-branch export is wanted. Authorized before the body is read, like every command.
 */
const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  authorize(c, "reporting:read");
  await next();
};

export function mountExportRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  store: ObjectStore,
): void {
  const create = createRoute({
    method: "post",
    path: "/v1/reporting/exports",
    tags,
    summary: "Ask for a large export (sale lines); you are notified when the file is ready",
    middleware: guard,
    request: { body: { required: true, ...json(CreateExportSchema) } },
    responses: { 201: { description: "Queued", ...json(ExportSchema) } },
  });
  const list = createRoute({
    method: "get",
    path: "/v1/reporting/exports",
    tags,
    summary: "My recent exports",
    middleware: guard,
    responses: { 200: { description: "OK", ...json(ExportListSchema) } },
  });
  const download = createRoute({
    method: "get",
    path: "/v1/reporting/exports/{id}/download",
    tags,
    summary: "Download a finished export (redirects to a short-lived link)",
    middleware: guard,
    request: { params: IdParam },
    responses: { 302: { description: "Redirect to the file" } },
  });

  app.openapi(
    create,
    (c) =>
      runCommand(c, deps, {
        permission: "reporting:read",
        input: CreateExportSchema,
        handler: async (tx, b, ctx) => {
          const id = deps.ids.uuidv7();
          const userId = ctx.tenant.userId;
          if (userId === undefined)
            throw new DomainError("UNAUTHENTICATED", "Authentication required");
          const r = await tx.query<Row>(
            `insert into reporting.exports (tenant_id, id, kind, params, requested_by)
             values ($1, $2, $3, $4::jsonb, $5) returning ${COLUMNS}`,
            [
              ctx.tenant.tenantId,
              id,
              b.kind,
              JSON.stringify({
                from: b.from,
                to: b.to,
                branchIds: b.branchId ? [b.branchId] : null,
              }),
              userId,
            ],
          );
          const row = r.rows[0];
          if (row === undefined) throw new DomainError("INTERNAL", "export not saved");
          return {
            status: 201,
            body: toExport(row, deps.clock.now()),
            audit: [
              {
                action: "reporting.export.requested",
                entity: "reporting.export",
                entityId: id,
                after: { kind: b.kind, from: b.from, to: b.to, branchId: b.branchId ?? null },
              },
            ],
            noEvents: true,
          };
        },
      }) as never,
  );

  app.openapi(list, async (c) => {
    const tenant = requireTenant(c);
    const { userId } = requireUser(c);
    const rows = await withTenantTx(
      deps.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<Row>(
            `select ${COLUMNS} from reporting.exports where tenant_id = $1 and requested_by = $2
            order by id desc limit $3`,
            [tenant.tenantId, userId, LIST_LIMIT],
          )
        ).rows,
    );
    const now = deps.clock.now();
    return c.json({ exports: rows.map((r) => toExport(r, now)) }, 200);
  });

  app.openapi(download, async (c) => {
    const tenant = requireTenant(c);
    const { userId } = requireUser(c);
    const { id } = c.req.valid("param");
    const row = await withTenantTx(
      deps.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<{ object_key: string | null }>(
            `select object_key from reporting.exports
            where tenant_id = $1 and id = $2 and requested_by = $3 and status = 'ready' and expires_at > $4`,
            [tenant.tenantId, id, userId, new Date(deps.clock.now())],
          )
        ).rows[0],
    );
    // Not yours, not ready, or expired: all the same 404.
    if (row?.object_key == null) throw new DomainError("NOT_FOUND", "Not found");
    c.header("cache-control", "no-store");
    return c.redirect(store.presignGet(row.object_key, DOWNLOAD_SECONDS), 302);
  });
}
