import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TenantCtx } from "@wise-biz/db";
import type { Permission, PermissionCatalog } from "@wise-biz/policy";
import type pg from "pg";
import type { Logger } from "pino";

export type AuthContext =
  | { kind: "anonymous" }
  | {
      kind: "user";
      userId: string;
      sessionId: string;
      /** Active tenant after a fresh membership check; null = signed in, no (valid) tenant: fail closed. */
      tenantId: string | null;
      roles: readonly string[];
      branchScope: "all" | readonly string[];
      /** tenancy.tenants.permissions_version at resolve time; keys the policy-matrix cache. */
      permissionsVersion: number;
      /** Lower-cased account email from the session. Absent (test contexts) = unknown = treated as unverified. */
      email?: string;
      /** Email verified on the account. Absent = false: invite acceptance fails closed. */
      emailVerified?: boolean;
    };

export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    auth: AuthContext;
    tenant: TenantCtx | undefined;
    /** Set by the kernel when the request carries a valid device signature (RFC 9421); else undefined. */
    device: DeviceContext | undefined;
  };
}

/** A terminal that signed this request. Status is read fresh on every request, so a revoke applies at once. */
export interface DeviceContext {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly status: "pending" | "active" | "suspended" | "revoked" | "blacklisted";
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
  /**
   * Every permission of the mounted modules (the kernel builds it). Modules that validate permission names (grants)
   * fall back to their own list when absent, so a missing catalog narrows what can be granted, never widens it.
   */
  catalog?: PermissionCatalog;
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
