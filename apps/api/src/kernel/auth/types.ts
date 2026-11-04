import type { AppEnv, AuthContext } from "@wise-biz/module-kit";
import type { PolicyRow } from "@wise-biz/policy";
import type { Context } from "hono";

/** Turns a request into the caller identity. Required by createApp; production uses `sessionResolver`. */
export type AuthResolver = (c: Context<AppEnv>) => Promise<AuthContext>;

/** Slice of the identity port the kernel reads. */
export interface SessionReader {
  getSession(headers: Headers): Promise<{
    sessionId: string;
    userId: string;
    /** Lower-cased account email. */
    email: string;
    emailVerified: boolean;
    activeTenantId: string | null;
  } | null>;
}

/** Slice of the tenancy ports the kernel reads. */
export interface MembershipLoader {
  loadMembership(
    userId: string,
    tenantId: string,
    requestId: string,
  ): Promise<{
    membershipId: string;
    roles: readonly string[];
    branchScope: "all" | readonly string[];
    permissionsVersion: number;
  } | null>;
}

export type PolicyRowsLoader = (
  tenantId: string,
  requestId: string,
) => Promise<readonly PolicyRow[]>;

/** What the kernel needs from Redis (policy cache + rate limiter). Every call may reject; callers decide fail-open/closed. */
export interface KernelRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Fixed window: INCR + PEXPIRE NX + PTTL in one MULTI. */
  hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  /** SET key 1 NX EX ttl: true when the key was new (device-signature nonces). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}
