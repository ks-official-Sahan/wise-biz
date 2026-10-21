import { createHash } from "node:crypto";

import {
  appendAudit,
  appendOutbox,
  lockIdempotencyKey,
  saveIdempotencyResponse,
  withTenantTx,
} from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";

import { authorize, requireTenant } from "./authz.ts";
import { DEFAULT_IDEMPOTENCY_TTL_MS } from "./types.ts";

import type { AuthorizeResource } from "./authz.ts";
import type { AppEnv, ModuleDeps } from "./types.ts";
import type { AuditEntry, OutboxEvent, TenantCtx, TxHandle } from "@wise-biz/db";
import type { Permission } from "@wise-biz/policy";
import type { Context } from "hono";
import type { ZodType } from "zod";

const KEY_RE = /^[A-Za-z0-9_-]{8,255}$/;
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotency-Replayed";

/** Handler-side audit entry: actor and requestId are filled in from the auth context. */
export type AuditDraft = Omit<AuditEntry, "actorType" | "actorId" | "requestId"> &
  Partial<Pick<AuditEntry, "actorType" | "actorId" | "requestId">>;

export interface CommandContext {
  readonly tenant: TenantCtx;
  readonly userId: string;
  readonly requestId: string;
  readonly now: Date;
  readonly ids: ModuleDeps["ids"];
}

export interface CommandResult {
  status?: 200 | 201;
  /** JSON-serialisable; stored verbatim and replayed byte-identically. */
  body: unknown;
  /** Required and non-empty: every mutation is audited in its own transaction (AGENTS.md rule 5). */
  audit: readonly AuditDraft[];
  /** Non-empty unless `noEvents: true`: a silent mutation must be a deliberate choice. */
  events?: readonly OutboxEvent[];
  /** Explicitly declare that this mutation emits no domain event (then `events` must be empty/absent). */
  noEvents?: boolean;
}

export interface CommandOptions<I> {
  permission: Permission;
  input: ZodType<I>;
  /** Default "required". "optional": honoured when the header is present. "off": never. */
  idempotency?: "required" | "optional" | "off";
  resource?: (input: I) => AuthorizeResource;
  handler: (tx: TxHandle, input: I, ctx: CommandContext) => Promise<CommandResult>;
}

interface StoredResponse {
  status: number;
  /** Serialized once; the first response and every replay send exactly these bytes. */
  bodyText: string;
  /** Stored for compatibility only; never replayed (a poisoned cache must not set response headers). */
  headers: Record<string, string>;
}

/** Largest response body accepted from / written to the Redis cache. */
const MAX_CACHED_BODY_BYTES = 256 * 1024;
const MAX_KEY_LENGTH = 255;

const JSON_TYPE = "application/json; charset=UTF-8";

/** Only content-type (+ Idempotency-Replayed on replay) are sent; stored headers are ignored by design. */
function send(c: Context<AppEnv>, r: StoredResponse, extra: Record<string, string> = {}): Response {
  return c.body(r.bodyText, r.status as 200, { ...extra, "content-type": JSON_TYPE });
}

/** RFC 8785-style stable form (sorted keys) so key order never changes the request hash. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, stable(o[k])]),
    );
  }
  return v;
}

/** `search` is the raw query string (with "?" or empty); it is part of the request identity. */
export function requestHash(method: string, path: string, body: unknown, search = ""): string {
  return createHash("sha256")
    .update(JSON.stringify(stable({ method, path, search, body })))
    .digest("hex");
}

function replay(c: Context<AppEnv>, r: StoredResponse): Response {
  return send(c, r, { [REPLAYED_HEADER]: "true" });
}

const mismatch = (): DomainError =>
  new DomainError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was used with a different request");

/**
 * Strict shape check of a Redis entry. Headers are dropped; status is 200|201 only; body is a bounded string.
 * Follow-up: HMAC the stored value (key from env) so a Redis writer cannot forge replays.
 */
function parseCached(raw: string): { requestHash: string; response: StoredResponse } | undefined {
  if (raw.length > MAX_CACHED_BODY_BYTES * 2) return undefined;
  try {
    const v = JSON.parse(raw) as {
      requestHash?: unknown;
      response?: Record<string, unknown> | null;
    };
    const r = v.response;
    if (
      typeof v.requestHash === "string" &&
      r !== undefined &&
      r !== null &&
      (r.status === 200 || r.status === 201) &&
      typeof r.bodyText === "string" &&
      r.bodyText.length <= MAX_CACHED_BODY_BYTES
    ) {
      return {
        requestHash: v.requestHash,
        response: { status: r.status, bodyText: r.bodyText, headers: {} },
      };
    }
  } catch {
    // corrupt entry: ignore, Postgres decides
  }
  return undefined;
}

type Outcome =
  | { kind: "done"; response: StoredResponse; cache: boolean }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "mismatch" };

/**
 * The one way to mutate: authorize -> validate -> idempotency -> ONE tenant tx
 * (lock key, handler, audit, outbox, save response) -> commit -> best-effort Redis cache.
 *
 * - Authorization runs before the body is read (unauthorized + invalid body = 404, not 422).
 * - Postgres decides idempotency (advisory xact lock in lockIdempotencyKey: concurrent duplicates wait, then
 *   replay). Redis only short-circuits already-completed keys and may be absent or down.
 * - Any throw rolls back domain rows, audit, outbox and the key together.
 * - The handler must return at least one audit entry and at least one event (or `noEvents: true`); violating either is an INTERNAL error (programming bug).
 */
export async function runCommand<I>(
  c: Context<AppEnv>,
  deps: ModuleDeps,
  opts: CommandOptions<I>,
): Promise<Response> {
  // 1. authorize (needs no body; resource-scoped checks run after validation below)
  authorize(c, opts.permission);
  const tenant = requireTenant(c);

  // 2. validate
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
  const parsed = opts.input.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "invalid request", {
      fieldErrors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const input = parsed.data;
  if (opts.resource) authorize(c, opts.permission, opts.resource(input));

  // 3. idempotency key
  const mode = opts.idempotency ?? "required";
  const header = mode === "off" ? undefined : c.req.header(IDEMPOTENCY_HEADER);
  if (header === undefined && mode === "required") {
    throw new DomainError("VALIDATION_FAILED", `${IDEMPOTENCY_HEADER} header is required`);
  }
  if (header !== undefined && !KEY_RE.test(header)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${IDEMPOTENCY_HEADER} must be 8-255 characters of [A-Za-z0-9_-]`,
    );
  }
  // Scope the key to the actor so another user of the same tenant can never replay (or probe) your response.
  const userId = tenant.userId ?? "";
  const key = header === undefined ? undefined : `${userId}:${header}`;
  if (key !== undefined && key.length > MAX_KEY_LENGTH) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${IDEMPOTENCY_HEADER} is too long (actor-scoped key must be at most ${String(MAX_KEY_LENGTH)} characters)`,
    );
  }
  const hash =
    key === undefined ? "" : requestHash(c.req.method, c.req.path, raw, new URL(c.req.url).search);
  const ttlMs = deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const cacheKey = key === undefined ? "" : `idem:${tenant.tenantId}:${key}`;
  const log = c.get("logger") as AppEnv["Variables"]["logger"] | undefined;

  // 4. Redis fast path (completed responses only)
  if (key !== undefined && deps.idempotencyCache) {
    try {
      const hit = await deps.idempotencyCache.get(cacheKey);
      const cached = hit === null ? undefined : parseCached(hit);
      if (cached) {
        if (cached.requestHash !== hash) throw mismatch();
        return replay(c, cached.response);
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      log?.warn({ err, tenantId: tenant.tenantId }, "idempotency cache read failed");
    }
  }

  // 5. transaction
  const ctx: CommandContext = {
    tenant,
    userId,
    requestId: tenant.requestId,
    now: new Date(deps.clock.now()),
    ids: deps.ids,
  };
  const outcome = await withTenantTx(deps.pool, tenant, async (tx): Promise<Outcome> => {
    if (key !== undefined) {
      const lock = await lockIdempotencyKey(tx, { key, requestHash: hash });
      if (lock.state === "replay") return { kind: "replay", response: lock.response };
      if (lock.state === "mismatch") return { kind: "mismatch" };
    }
    const result = await opts.handler(tx, input, ctx);
    if (result.audit.length === 0) {
      throw new DomainError("INTERNAL", "command returned no audit entry");
    }
    const events = result.events ?? [];
    if (result.noEvents === true ? events.length > 0 : events.length === 0) {
      throw new DomainError(
        "INTERNAL",
        result.noEvents === true
          ? "command set noEvents but returned events"
          : "command returned no events (set noEvents: true to emit none deliberately)",
      );
    }
    await appendAudit(
      tx,
      result.audit.map((a) => ({
        ...a,
        actorType: a.actorType ?? "user",
        actorId: a.actorId ?? userId,
        requestId: a.requestId ?? ctx.requestId,
      })),
    );
    await appendOutbox(tx, events);
    const response: StoredResponse = {
      status: result.status ?? 201,
      bodyText: JSON.stringify(result.body ?? null),
      headers: {},
    };
    if (key !== undefined) {
      await saveIdempotencyResponse(tx, { key, requestHash: hash, response, ttlMs });
    }
    return { kind: "done", response, cache: key !== undefined };
  });

  if (outcome.kind === "mismatch") throw mismatch();
  if (outcome.kind === "replay") return replay(c, outcome.response);

  // 6. best-effort cache after commit
  if (
    outcome.cache &&
    deps.idempotencyCache &&
    outcome.response.bodyText.length <= MAX_CACHED_BODY_BYTES
  ) {
    try {
      await deps.idempotencyCache.set(
        cacheKey,
        JSON.stringify({ requestHash: hash, response: outcome.response }),
        ttlMs,
      );
    } catch (err) {
      log?.warn({ err, tenantId: tenant.tenantId }, "idempotency cache write failed");
    }
  }
  return send(c, outcome.response);
}
