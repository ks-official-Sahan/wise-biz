import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TenantCtx } from "@wise-biz/db";
import type { Permission } from "@wise-biz/policy";
import type pg from "pg";
import type { Logger } from "pino";

export type AuthContext =
  | { kind: "anonymous" }
  | {
      kind: "user";
      userId: string;
      tenantId: string;
      roles: readonly string[];
      branchScope: "all" | readonly string[];
    };

export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    auth: AuthContext;
    tenant: TenantCtx | undefined;
  };
}

/**
 * Optional fast-path cache for COMPLETED idempotent responses. Postgres stays the source of truth;
 * implementations must be best effort (a failing cache never fails a request).
 */
export interface IdempotencyCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/** Default retention of idempotency keys and cached responses: 24 h (api-conventions.md). */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModuleDeps {
  pool: pg.Pool;
  clock: { now(): number };
  ids: { uuidv7(): string };
  idempotencyCache?: IdempotencyCache;
  /** Defaults to DEFAULT_IDEMPOTENCY_TTL_MS. */
  idempotencyTtlMs?: number;
}

export interface WbModule {
  /** Folder name, e.g. "_template". */
  readonly name: string;
  /** Absolute path to the module's migrations directory. */
  readonly migrationsDir: string;
  readonly permissions: readonly Permission[];
  /** Event definitions (contracts defineEvent). */
  readonly events: readonly unknown[];
  /** Mount routes on the app; the module chooses its base path `/v1/<name-without-underscore>`. */
  routes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void;
  /** Not mounted when NODE_ENV=production. */
  readonly devOnly?: boolean;
}
