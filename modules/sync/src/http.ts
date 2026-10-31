import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { requireTerminal } from "@wise-biz/module-kit";

import { DATASETS } from "./changes.ts";
import { bootstrap, decodeCursor, pullChanges } from "./pull.ts";
import { applyBatch } from "./push.ts";

import type { PullOptions, PullPorts } from "./pull.ts";
import type { PushPorts } from "./push.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";

const b64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .max(512);
const MAX_COMMANDS = 100;
const MAX_BYTES = 256 * 1024;

const CommandSchema = z.object({
  type: z.string().min(1).max(40),
  /** The command as the device hashed and signed it: validated against its schema per type when applied. */
  body: z
    .looseObject({
      meta: z.object({
        deviceSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        prevHash: b64,
        hash: b64,
        signature: b64,
      }),
    })
    .openapi({ type: "object", additionalProperties: true }),
});

export const PushRequestSchema = z
  .object({ commands: z.array(CommandSchema).min(1).max(MAX_COMMANDS) })
  .openapi("SyncPushRequest");

const Ack = z.object({
  seq: z.number().int(),
  id: z.string().nullable(),
  type: z.string(),
  status: z.enum(["applied", "replayed", "rejected"]),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .optional(),
});
export const PushResponseSchema = z
  .object({
    acks: z.array(Ack),
    /** Set when the batch stopped before its end: everything in `acks` is committed, the rest was not touched. */
    stopped: z
      .object({
        seq: z.number().int(),
        code: z.enum(["SEQUENCE_GAP", "CHAIN_BROKEN", "BAD_SIGNATURE", "UNKNOWN_DEVICE"]),
        expectedSeq: z.number().int().optional(),
        quarantined: z.boolean(),
      })
      .nullable(),
    lastSeq: z.number().int(),
  })
  .openapi("SyncPushResponse");

const route = createRoute({
  method: "post",
  path: "/v1/sync/commands",
  tags: ["sync"],
  summary:
    "Terminal: push signed, hash-chained commands (<= 100 / 256 KB). Applied in device_seq order, one transaction each",
  request: {
    body: { required: true, content: { "application/json": { schema: PushRequestSchema } } },
  },
  responses: {
    200: {
      description:
        "Acks for every applied, replayed or rejected command, and where the batch stopped",
      content: { "application/json": { schema: PushResponseSchema } },
    },
  },
});

const DatasetSchema = z.enum(DATASETS);
const ChangesQuery = z.object({
  dataset: DatasetSchema,
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
const ChangesResponse = z
  .object({
    dataset: DatasetSchema,
    changes: z.array(
      z.object({
        entity: z.string(),
        entityId: z.string(),
        op: z.enum(["upsert", "delete"]),
        version: z.number().int(),
        payload: z.unknown(),
        changedAt: z.string(),
      }),
    ),
    /** Pass it back as `cursor`. With no `hasMore`, the device is up to date. */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .openapi("SyncChanges");
const BootstrapQuery = z.object({ dataset: DatasetSchema });
const BootstrapResponse = z
  .object({
    dataset: DatasetSchema,
    /** Continue with GET /v1/sync/changes from here after loading the snapshot. */
    cursor: z.string().nullable(),
    url: z.string().nullable(),
    expiresInSeconds: z.number().int(),
    entityCount: z.number().int(),
    bytes: z.number().int(),
    builtAt: z.string(),
  })
  .openapi("SyncBootstrap");

const changesRoute = createRoute({
  method: "get",
  path: "/v1/sync/changes",
  tags: ["sync"],
  summary:
    "Terminal: changes of one dataset after a cursor (keyset, no gaps or repeats). ETag; 304 when nothing changed",
  request: { query: ChangesQuery },
  responses: {
    200: {
      description: "A page of changes",
      content: { "application/json": { schema: ChangesResponse } },
    },
    304: { description: "Nothing changed since the ETag" },
  },
});
const bootstrapRoute = createRoute({
  method: "get",
  path: "/v1/sync/bootstrap",
  tags: ["sync"],
  summary:
    "Terminal: a signed URL of the gzip NDJSON snapshot of a dataset, and the cursor to continue from",
  request: { query: BootstrapQuery },
  responses: {
    200: {
      description: "Snapshot",
      content: { "application/json": { schema: BootstrapResponse } },
    },
  },
});

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  ports: PushPorts & PullPorts,
  pull: PullOptions = {},
): void {
  app.openapi(changesRoute, async (c) => {
    const device = requireTerminal(c);
    const q = c.req.valid("query");
    if (q.cursor !== undefined && decodeCursor(q.cursor) === undefined) {
      throw new DomainError("VALIDATION_FAILED", "Unknown cursor.", {
        fieldErrors: [
          { path: "cursor", message: "Start again without a cursor (bootstrap first)." },
        ],
      });
    }
    const page = await withTenantTx(
      deps.pool,
      { tenantId: device.tenantId, requestId: c.get("requestId") },
      (tx) => pullChanges(tx, device.tenantId, device.branchId, ports, q),
    );
    // Nothing new for this cursor: the same ETag, so a polling terminal costs one small query and no body.
    const etag = `W/"${q.dataset}:${page.nextCursor ?? "start"}"`;
    if (page.changes.length === 0 && c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    c.header("etag", etag);
    return c.json({ dataset: q.dataset, ...page }, 200);
  });
  app.openapi(bootstrapRoute, async (c) => {
    const device = requireTerminal(c);
    const { dataset } = c.req.valid("query");
    const result = await withTenantTx(
      deps.pool,
      { tenantId: device.tenantId, requestId: c.get("requestId") },
      (tx) =>
        bootstrap(
          tx,
          device.tenantId,
          device.branchId,
          ports,
          dataset,
          new Date(deps.clock.now()),
          pull,
        ),
    );
    return c.json(result, 200);
  });
  mountPush(app, deps, ports);
}

function mountPush(app: OpenAPIHono<AppEnv>, deps: ModuleDeps, ports: PushPorts): void {
  app.openapi(route, async (c) => {
    const device = requireTerminal(c);
    const { commands } = c.req.valid("json");
    // Whole-request size, by what was parsed (the global body limit already bounds the raw bytes).
    if (JSON.stringify(commands).length > MAX_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "A sync batch is at most 256 KB.");
    }
    const seen = new Set<number>();
    for (const [i, cmd] of commands.entries()) {
      const seq = cmd.body.meta.deviceSeq;
      if (seen.has(seq)) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "A sequence number appears twice in the batch.",
          {
            fieldErrors: [
              { path: `commands.${String(i)}.body.meta.deviceSeq`, message: "duplicate" },
            ],
          },
        );
      }
      seen.add(seq);
    }
    const result = await applyBatch(
      { ...ports, pool: deps.pool, clock: deps.clock, ids: deps.ids },
      { tenantId: device.tenantId, deviceId: device.deviceId, branchId: device.branchId },
      c.get("requestId"),
      commands,
    );
    // A batch that processed nothing and stopped is a refusal, not a partial success.
    if (result.acks.length === 0 && result.stopped !== null) {
      const s = result.stopped;
      if (s.code === "SEQUENCE_GAP") {
        throw new DomainError("SEQUENCE_GAP", "Resend from the expected sequence number.", {
          details: { expectedSeq: s.expectedSeq },
        });
      }
      if (s.code === "UNKNOWN_DEVICE") throw new DomainError("DEVICE_REVOKED", "Unknown device.");
      throw new DomainError(
        "CHAIN_BROKEN",
        "The command chain does not verify. The device was suspended.",
      );
    }
    return c.json(result, 200);
  });
}
