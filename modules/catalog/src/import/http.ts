import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { authorize, requireTenant, runCommand } from "@wise-biz/module-kit";
import { tenantKey } from "@wise-biz/storage";

import { catalogEvent, notFound } from "../application/shared.ts";
import { ImportRequestedV1 } from "../events.ts";
import { uuid7 } from "../schemas.ts";

import { runImport } from "./job.ts";

import type { ImportJobDeps } from "./job.ts";
import type { RowError } from "./rows.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv, CommandContext, ModuleDeps } from "@wise-biz/module-kit";
import type { ObjectStore } from "@wise-biz/storage";
import type { MiddlewareHandler } from "hono";

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const REPORT_TTL_SECONDS = 10 * 60;
const CONTENT_TYPE = "text/csv";

const CreateImportSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().min(1).max(MAX_IMPORT_BYTES),
    /** Hex SHA-256 of the file: the same file again returns the same import (no second run). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .openapi("CreateImport");

const ImportSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    status: z.enum(["awaiting_upload", "queued", "running", "done", "failed"]),
    totalRows: z.number(),
    okRows: z.number(),
    errorRows: z.number(),
    /** First errors (the report has them all, up to 10,000). */
    errors: z.array(z.object({ row: z.number(), column: z.string(), error: z.string() })),
    failure: z.string().nullable(),
    reportUrl: z.string().nullable(),
    upload: z
      .object({
        method: z.literal("PUT"),
        url: z.string(),
        headers: z.record(z.string(), z.string()),
      })
      .nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("Import");
type ImportDto = z.infer<typeof ImportSchema>;

interface ImportRow {
  id: string;
  file_name: string;
  status: ImportDto["status"];
  total_rows: number;
  ok_rows: number;
  error_rows: number;
  errors: RowError[];
  failure: string | null;
  size_bytes: number;
  source_key: string;
  report_key: string | null;
  created_at: Date;
  finished_at: Date | null;
}
const COLUMNS = `id, file_name, status, total_rows, ok_rows, error_rows, errors, failure, size_bytes, source_key,
  report_key, created_at, finished_at`;

const dto = (r: ImportRow, store: ObjectStore): ImportDto => ({
  id: r.id,
  fileName: r.file_name,
  status: r.status,
  totalRows: r.total_rows,
  okRows: r.ok_rows,
  errorRows: r.error_rows,
  errors: r.errors.slice(0, 50),
  failure: r.failure,
  reportUrl: r.report_key === null ? null : store.presignGet(r.report_key, REPORT_TTL_SECONDS),
  upload:
    r.status === "awaiting_upload"
      ? {
          method: "PUT",
          url: store.presignPut(r.source_key, {
            contentType: CONTENT_TYPE,
            contentLength: r.size_bytes,
            expiresSeconds: UPLOAD_TTL_SECONDS,
          }),
          headers: { "content-type": CONTENT_TYPE, "content-length": String(r.size_bytes) },
        }
      : null,
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
});

const load = async (tx: TxHandle, tenantId: string, where: string, value: string) =>
  (
    await tx.query<ImportRow>(
      `select ${COLUMNS} from catalog.imports where tenant_id = $1 and ${where} = $2`,
      [tenantId, value],
    )
  ).rows[0];

const canWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  authorize(c, "catalog:write");
  await next();
};
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const Id = z.object({ id: uuid7 });

const createRoute_ = createRoute({
  method: "post",
  path: "/v1/catalog/imports",
  tags: ["catalog"],
  summary:
    "Start a CSV import: returns a presigned PUT for the file (the same file hash returns the same import)",
  middleware: canWrite,
  request: { body: { required: true, ...json(CreateImportSchema) } },
  responses: {
    200: { description: "This file was imported before", ...json(ImportSchema) },
    201: { description: "Created; upload the file, then POST /start", ...json(ImportSchema) },
  },
});
const startRoute = createRoute({
  method: "post",
  path: "/v1/catalog/imports/{id}/start",
  tags: ["catalog"],
  summary:
    "Queue (or resume) the import after the upload; the workers process it in batches of 500",
  middleware: canWrite,
  request: { params: Id },
  responses: { 200: { description: "Queued", ...json(ImportSchema) } },
});
const getRoute = createRoute({
  method: "get",
  path: "/v1/catalog/imports/{id}",
  tags: ["catalog"],
  summary: "Import progress, first errors and the downloadable report",
  middleware: canWrite,
  request: { params: Id },
  responses: { 200: { description: "Import", ...json(ImportSchema) } },
});

export function mountImportRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  store: ObjectStore,
): void {
  app.openapi(createRoute_, async (c) => {
    const res = await runCommand(c, deps, {
      permission: "catalog:write",
      input: CreateImportSchema,
      handler: async (tx, b, ctx) => {
        const tenantId = ctx.tenant.tenantId;
        const before = await load(tx, tenantId, "sha256", b.sha256);
        if (before !== undefined) {
          return {
            status: 200,
            body: dto(before, store),
            audit: [
              { action: "catalog.import.reused", entity: "catalog.import", entityId: before.id },
            ],
            noEvents: true,
          };
        }
        const id = ctx.ids.uuidv7();
        await tx.query(
          `insert into catalog.imports (id, tenant_id, file_name, content_type, size_bytes, sha256, source_key,
             created_by, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            tenantId,
            b.fileName,
            CONTENT_TYPE,
            b.sizeBytes,
            b.sha256,
            tenantKey(tenantId, "imports", id, "source.csv"),
            ctx.userId,
            ctx.now,
          ],
        );
        const row = (await load(tx, tenantId, "id", id)) ?? notFound();
        return {
          status: 201,
          body: dto(row, store),
          audit: [
            {
              action: "catalog.import.created",
              entity: "catalog.import",
              entityId: id,
              after: { fileName: b.fileName, sizeBytes: b.sizeBytes, sha256: b.sha256 },
            },
          ],
          noEvents: true,
        };
      },
    });
    return res as never;
  });

  app.openapi(startRoute, async (c) => {
    const { id } = c.req.valid("param");
    const res = await runCommand(c, deps, {
      permission: "catalog:write",
      input: z.object({}).strict(),
      idempotency: "optional",
      handler: async (tx, _b, ctx: CommandContext) => {
        const tenantId = ctx.tenant.tenantId;
        const row = (await load(tx, tenantId, "id", id)) ?? notFound();
        if (row.status === "done" || row.status === "failed") {
          throw new DomainError(
            "CONFLICT",
            `This import is ${row.status}. Upload a corrected file to import again.`,
          );
        }
        // queued/running again = resume after a worker crash (the job lock makes a duplicate run a no-op).
        await tx.query(
          "update catalog.imports set status = case when status = 'awaiting_upload' then 'queued' else status end where tenant_id = $1 and id = $2",
          [tenantId, id],
        );
        const after = (await load(tx, tenantId, "id", id)) ?? notFound();
        return {
          status: 200,
          body: dto(after, store),
          audit: [{ action: "catalog.import.started", entity: "catalog.import", entityId: id }],
          events: [catalogEvent(ImportRequestedV1, ctx, `import/${id}`, { importId: id })],
        };
      },
    });
    return res as never;
  });

  app.openapi(getRoute, async (c) => {
    const tenant = requireTenant(c);
    const { id } = c.req.valid("param");
    const row = await withTenantTx(deps.pool, tenant, (tx) => load(tx, tenant.tenantId, "id", id));
    return c.json(dto(row ?? notFound(), store), 200);
  });
}

export const IMPORT_CONSUMER = "catalog.import-runner";

export interface ImportConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (event: { readonly payload: unknown }) => Promise<void>;
  /** Resolves when every job this consumer started has finished (worker shutdown, tests). */
  readonly drain: () => Promise<void>;
}

/**
 * Structural twin of @wise-biz/events ConsumerDefinition. The event only TRIGGERS the job: the job runs outside the
 * consumer transaction (its 30 s timeout would kill a long import and rerun it), batch by batch on the worker pool.
 * A crash leaves the import `running` with its progress; POST /start resumes it.
 */
export function createImportConsumer(
  deps: ImportJobDeps,
  onError: (err: unknown, importId: string) => void,
): ImportConsumer {
  const running = new Set<Promise<void>>();
  return {
    name: IMPORT_CONSUMER,
    events: [`${ImportRequestedV1.type}@v1`],
    maxAttempts: 3,
    handle: (event) => {
      const e = ImportRequestedV1.parse(event.payload);
      const job = runImport(deps, e.tenantId, e.data.importId)
        .catch((err: unknown) => {
          // Progress is committed per batch; the import stays `running` and POST /start resumes it.
          onError(err, e.data.importId);
        })
        .finally(() => running.delete(job));
      running.add(job);
      return Promise.resolve();
    },
    drain: async () => {
      await Promise.all([...running]);
    },
  };
}
