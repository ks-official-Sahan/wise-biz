import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { vi } from "vitest";

import { drizzleTenancyRepository } from "../src/adapters/db/tenancy-repository.ts";
import { mountRoutes } from "../src/adapters/http/routes.ts";

import type { ActiveTenantSetter, TenancyRepository } from "../src/ports/tenancy-repository.ts";
import type { AppEnv, AuthContext, ModuleDeps } from "@wise-biz/module-kit";
import type pg from "pg";

export const migrationsDir = join(import.meta.dirname, "..", "migrations");
const modulesDir = join(import.meta.dirname, "..", "..");

export const clock = { now: () => Date.UTC(2026, 0, 1) };
export const ids = { uuidv7 };

export async function setup(): Promise<{
  pool: pg.Pool;
  migrator: pg.Pool;
  drop: () => Promise<void>;
}> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(modulesDir, "infra", "migrations") },
    { module: "audit", dir: join(modulesDir, "audit", "migrations") },
    { module: "tenancy", dir: migrationsDir },
  ]);
  const pool = createPool(db.url("app"), { max: 10 });
  instrumentPool(pool);
  const migrator = createPool(db.url("migrator"));
  return {
    pool,
    migrator,
    drop: async () => {
      await pool.end();
      await migrator.end();
      await db.drop();
    },
  };
}

export const SESSION = "01900000-0000-7000-8000-0000000000aa";

export const userAuth = (userId: string, tenantId: string | null = null): AuthContext => ({
  kind: "user",
  userId,
  sessionId: SESSION,
  tenantId,
  roles: [],
  branchScope: [],
  permissionsVersion: 0,
});

/** Fake identity session port: records calls, can be told to fail. */
export function fakeSessions() {
  return { setActiveTenant: vi.fn<ActiveTenantSetter["setActiveTenant"]>(() => Promise.resolve()) };
}

/** The tenancy routes behind the same 422/404 mapping apps/api installs. `auth` null = anonymous. */
export function appFor(
  pool: pg.Pool,
  auth: AuthContext | null,
  sessions = fakeSessions(),
  repo: TenancyRepository = drizzleTenancyRepository,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", auth ?? { kind: "anonymous" });
    await next();
  });
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  const deps: ModuleDeps = { pool, clock, ids };
  mountRoutes(app, deps, sessions, repo);
  return app;
}

export const validBody = (tenantId: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  name: "  Acme Traders  ",
  branch: {
    name: "Main Street",
    kind: "store",
    timezone: "Asia/Colombo",
    currency: "LKR",
    taxRegion: "LK",
  },
  ...over,
});

export const post = (
  app: OpenAPIHono<AppEnv>,
  path: string,
  body: unknown,
  key?: string,
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    }),
  );

/** Row counts of every tenancy table + audit/outbox/idempotency for one tenant (FORCE RLS applies). */
export async function counts(pool: pg.Pool, tenantId: string): Promise<Record<string, number>> {
  return withTenantTx(pool, { tenantId, requestId: "test" }, async (tx) => {
    const out: Record<string, number> = {};
    for (const t of [
      "tenancy.tenants",
      "tenancy.roles",
      "tenancy.role_permissions",
      "tenancy.branches",
      "tenancy.locations",
      "tenancy.memberships",
      "tenancy.membership_roles",
      "audit.audit_log",
      "infra.outbox",
      "infra.idempotency_keys",
    ]) {
      out[t] = Number((await tx.query<{ n: string }>(`select count(*) n from ${t}`)).rows[0]?.n);
    }
    return out;
  });
}
