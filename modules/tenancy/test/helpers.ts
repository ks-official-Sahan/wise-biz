import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { setPolicy } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { vi } from "vitest";

import { drizzleTenancyRepository } from "../src/adapters/db/tenancy-repository.ts";
import { mountRoutes } from "../src/adapters/http/routes.ts";
import { createTenancyPorts } from "../src/index.ts";
import { inviteToken } from "../src/invite-token.ts";
import { TENANCY_PERMISSIONS } from "../src/permissions.ts";

import type { ActiveTenantSetter, TenancyRepository } from "../src/ports/tenancy-repository.ts";
import type { AppEnv, AuthContext, ModuleDeps } from "@wise-biz/module-kit";
import type { PolicyMatrix } from "@wise-biz/policy";
import type { Context } from "hono";
import type pg from "pg";

export const migrationsDir = join(import.meta.dirname, "..", "migrations");
const modulesDir = join(import.meta.dirname, "..", "..");

export const clock = { now: () => Date.UTC(2026, 0, 1) };
export const ids = { uuidv7 };
/** Test-only server secret (>= 32 chars). Never a real key. */
export const INVITE_SECRET = "test-invite-secret-".padEnd(40, "x");
export const catalog = createCatalog(TENANCY_PERMISSIONS);

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

/** Adds the account fields the session resolver copies from the identity session. */
export const withAccount = (auth: AuthContext, email: string, emailVerified = true): AuthContext =>
  auth.kind === "user" ? { ...auth, email, emailVerified } : auth;

/**
 * The caller's REAL auth context in a tenant: roles, branch scope and version come from the membership, exactly as the
 * kernel session resolver builds them. Use this instead of hand-written roles in permission tests.
 */
export async function memberAuth(
  pool: pg.Pool,
  userId: string,
  tenantId: string,
): Promise<AuthContext> {
  const m = await createTenancyPorts(pool).loadMembership(userId, tenantId, "test");
  if (m === null) return userAuth(userId, null);
  return {
    kind: "user",
    userId,
    sessionId: SESSION,
    tenantId,
    roles: m.roles,
    branchScope: m.branchScope,
    permissionsVersion: m.permissionsVersion,
  };
}

/** Fake identity session port: records calls, can be told to fail. */
export function fakeSessions() {
  return { setActiveTenant: vi.fn<ActiveTenantSetter["setActiveTenant"]>(() => Promise.resolve()) };
}

const EMPTY: PolicyMatrix = matrixFromRows(catalog, []);

/**
 * The tenancy routes behind the same 422/404 mapping apps/api installs. `auth` null = anonymous. The policy matrix is
 * loaded per request from the tenant's grants (the kernel caches it by version; tests always read fresh, so a grant
 * change is visible on the very next request).
 */
export function appFor(
  pool: pg.Pool,
  auth: AuthContext | null,
  sessions = fakeSessions(),
  repo: TenancyRepository = drizzleTenancyRepository,
  options: { inviteSecret?: string | undefined; now?: (() => number) | undefined } = {
    inviteSecret: INVITE_SECRET,
  },
): OpenAPIHono<AppEnv> {
  const now = options.now ?? clock.now;
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
  app.use("*", async (c: Context<AppEnv>, next) => {
    const a = c.get("auth");
    const tid = a.kind === "user" ? a.tenantId : null;
    const matrix =
      tid !== null
        ? matrixFromRows(
            catalog,
            await withTenantTx(pool, { tenantId: tid, requestId: "policy" }, (tx) =>
              repo.loadPolicyRows(tx, tid),
            ),
          )
        : EMPTY;
    setPolicy(c, { matrix, now });
    await next();
  });
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  const deps: ModuleDeps = { pool, clock: { now }, ids, catalog };
  mountRoutes(app, deps, sessions, repo, { inviteSecret: options.inviteSecret });
  return app;
}

/** Creates a business through the real endpoint and returns its tenant id (the caller becomes its owner). */
export async function createBusiness(
  pool: pg.Pool,
  userId: string,
  name = "Acme Traders",
): Promise<string> {
  const tenantId = uuidv7();
  const res = await post(
    appFor(pool, userAuth(userId), fakeSessions()),
    "/v1/tenancy/tenants",
    validBody(tenantId, { name }),
    `biz-${uuidv7()}`,
  );
  if (res.status !== 201) throw new Error(`createBusiness failed: ${String(res.status)}`);
  return tenantId;
}

/** Runs `fn` inside the tenant's RLS scope; `query` resolves to the rows (tests only). */
export async function inTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (query: (sql: string, params?: unknown[]) => Promise<unknown[]>) => Promise<T>,
): Promise<T> {
  return withTenantTx(pool, { tenantId, requestId: "test" }, (tx) =>
    fn(async (s, p) => (await tx.query(s, p)).rows),
  );
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

export const put = (
  app: OpenAPIHono<AppEnv>,
  path: string,
  body: unknown,
  key?: string,
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    }),
  );

export const get = (app: OpenAPIHono<AppEnv>, path: string): Promise<Response> =>
  Promise.resolve(app.request(path, { method: "GET" }));

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
      "tenancy.invites",
      "audit.audit_log",
      "infra.outbox",
      "infra.idempotency_keys",
    ]) {
      out[t] = Number((await tx.query<{ n: string }>(`select count(*) n from ${t}`)).rows[0]?.n);
    }
    return out;
  });
}

/** The owner's app in a tenant, with the owner's real membership context. */
export async function ownerApp(
  pool: pg.Pool,
  ownerId: string,
  tenantId: string,
  now?: () => number,
): Promise<OpenAPIHono<AppEnv>> {
  return appFor(pool, await memberAuth(pool, ownerId, tenantId), fakeSessions(), undefined, {
    inviteSecret: INVITE_SECRET,
    now,
  });
}

/** Id of a system role by name, read inside the tenant scope. */
export async function roleIdOf(pool: pg.Pool, tenantId: string, name: string): Promise<string> {
  const rows = await inTenant(pool, tenantId, async (q) =>
    q("select id from tenancy.roles where name = $1", [name]),
  );
  const id = (rows as { id: string }[])[0]?.id;
  if (id === undefined) throw new Error(`no role ${name}`);
  return id;
}

/** Creates a custom role with the given grants through the endpoints (owner session). */
export async function makeCustomRole(
  pool: pg.Pool,
  ownerId: string,
  tenantId: string,
  name: string,
  permissions: readonly string[],
): Promise<string> {
  const app = await ownerApp(pool, ownerId, tenantId);
  const roleId = uuidv7();
  const created = await post(app, "/v1/tenancy/roles", { id: roleId, name }, `role-${uuidv7()}`);
  if (created.status !== 201) throw new Error(`makeCustomRole: create ${String(created.status)}`);
  const set = await put(
    app,
    `/v1/tenancy/roles/${roleId}/permissions`,
    { grants: permissions.map((permission) => ({ permission })) },
    `grants-${uuidv7()}`,
  );
  if (set.status !== 200) throw new Error(`makeCustomRole: grants ${String(set.status)}`);
  return roleId;
}

/**
 * Owner invites `email`, the invitee verifies and accepts. Returns the invitee's user id and membership id.
 * `now` moves the clock for expiry tests (both calls use it).
 */
export async function inviteAndAccept(
  pool: pg.Pool,
  ownerId: string,
  tenantId: string,
  email: string,
  roleIds: readonly string[],
  branchIds: readonly string[] | null = null,
): Promise<{ userId: string; membershipId: string; inviteId: string }> {
  const app = await ownerApp(pool, ownerId, tenantId);
  const inviteId = uuidv7();
  const created = await post(
    app,
    "/v1/tenancy/invites",
    { id: inviteId, email, roleIds, branchIds },
    `inv-${uuidv7()}`,
  );
  if (created.status !== 201)
    throw new Error(`invite failed: ${String(created.status)} ${await created.text()}`);
  const token = inviteTokenFor(tenantId, inviteId);
  const userId = uuidv7();
  const accepted = await post(
    appFor(pool, withAccount(userAuth(userId), email), fakeSessions()),
    "/v1/tenancy/invites/accept",
    { tenantId, inviteId, token },
    `acc-${uuidv7()}`,
  );
  if (accepted.status !== 200)
    throw new Error(`accept failed: ${String(accepted.status)} ${await accepted.text()}`);
  const body = (await accepted.json()) as { membershipId: string };
  return { userId, membershipId: body.membershipId, inviteId };
}

/** The token the server would derive (tests use the same secret the test apps are built with). */
export const inviteTokenFor = (tenantId: string, inviteId: string): string =>
  inviteToken(INVITE_SECRET, tenantId, inviteId);
