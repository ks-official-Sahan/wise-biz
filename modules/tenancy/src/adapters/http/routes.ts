import { createRoute } from "@hono/zod-openapi";
import { withUserTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { toUuid7 } from "@wise-biz/ids";
import { asRouteResponse, requireUser, runCommand } from "@wise-biz/module-kit";
import { createCatalog } from "@wise-biz/policy";

import { signUpBusinessCommand } from "../../application/business.ts";
import { switchTenant } from "../../application/switch.ts";
import { TENANCY_PERMISSIONS } from "../../permissions.ts";
import { MAX_MEMBERSHIPS_PER_USER } from "../../ports/tenancy-repository.ts";
import {
  MyTenantsSchema,
  SignUpBusinessSchema,
  SwitchTenantSchema,
  TenantCreatedSchema,
} from "../../schemas.ts";
import { drizzleTenancyRepository } from "../db/tenancy-repository.ts";

import { mountAdminRoutes } from "./admin-routes.ts";

import type { ActiveTenantSetter, TenancyRepository } from "../../ports/tenancy-repository.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** Authentication only (no tenant exists yet / is needed). Runs as route middleware, i.e. BEFORE zod validation. */
const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireUser(c);
  await next();
};

const signUpRoute = createRoute({
  method: "post",
  path: "/v1/tenancy/tenants",
  tags: ["tenancy"],
  summary:
    "Create a business (tenant, roles, first branch, owner membership) and make it the active tenant",
  middleware: [signedIn] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: SignUpBusinessSchema } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: TenantCreatedSchema } },
    },
  },
});

const myTenantsRoute = createRoute({
  method: "get",
  path: "/v1/tenancy/me/tenants",
  tags: ["tenancy"],
  summary: "Tenants the signed-in user is an active member of",
  middleware: [signedIn] as const,
  responses: {
    200: { description: "Tenants", content: { "application/json": { schema: MyTenantsSchema } } },
  },
});

const switchRoute = createRoute({
  method: "post",
  path: "/v1/tenancy/switch",
  tags: ["tenancy"],
  summary: "Make a tenant the active one for this session (404 unless an active member)",
  middleware: [signedIn] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: SwitchTenantSchema } } },
  },
  responses: { 204: { description: "Switched" } },
});

export interface TenancyRouteOptions {
  /** INVITE_SECRET. Undefined = not configured: no invite token can verify (fail closed). */
  readonly inviteSecret?: string | undefined;
}

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  sessions: ActiveTenantSetter,
  repo: TenancyRepository = drizzleTenancyRepository,
  options: TenancyRouteOptions = {},
): void {
  mountTenantRoutes(app, deps, sessions, repo);
  mountAdminRoutes(app, {
    module: deps,
    repo,
    sessions,
    options,
    catalog: deps.catalog ?? createCatalog(TENANCY_PERMISSIONS),
  });
}

function mountTenantRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  sessions: ActiveTenantSetter,
  repo: TenancyRepository,
): void {
  app.openapi(signUpRoute, async (c) => {
    const { userId, sessionId } = requireUser(c);
    const { tenantId } = c.req.valid("json");
    const requestId = c.get("requestId");
    // Per-user cap. Counted outside the command tx (own_* policies only apply with no active tenant); a replay of the
    // request that created the last allowed tenant still passes because that tenant is already one of the user's.
    const stats = await withUserTx(deps.pool, { userId, requestId }, (tx) =>
      repo.membershipStats(tx, userId, tenantId),
    );
    if (stats.count >= MAX_MEMBERSHIPS_PER_USER && !stats.inTenant) {
      throw new DomainError("CONFLICT", "Business limit reached for this account");
    }
    // runCommand: authenticated -> validate -> Idempotency-Key -> one tx (tenant + roles + branch + ... + audit +
    // outbox + key). The tenant of the tx is the client-generated id from the validated body.
    const res = await runCommand(c, deps, {
      bootstrapTenantId: (i) => i.tenantId,
      input: SignUpBusinessSchema,
      handler: (tx, body, ctx) =>
        signUpBusinessCommand({ repo, clock: deps.clock, ids: deps.ids }, tx, ctx, body),
    });
    // After commit. On an idempotent replay this re-points the session too, which heals a crash between commit and here.
    if (res.status < 300) await sessions.setActiveTenant(sessionId, userId, tenantId);
    return asRouteResponse(res);
  });

  app.openapi(myTenantsRoute, async (c) => {
    const { userId } = requireUser(c);
    const tenants = await withUserTx(deps.pool, { userId, requestId: c.get("requestId") }, (tx) =>
      repo.listMyTenants(tx, userId),
    );
    return c.json(
      {
        tenants: tenants.map((t) => ({
          tenantId: toUuid7(t.tenantId),
          name: t.name,
          membershipId: toUuid7(t.membershipId),
        })),
      },
      200,
    );
  });

  app.openapi(switchRoute, async (c) => {
    const { userId, sessionId } = requireUser(c);
    const { tenantId } = c.req.valid("json");
    await switchTenant(
      { pool: deps.pool, repo, sessions },
      { userId, sessionId, tenantId, requestId: c.get("requestId") },
    );
    return c.body(null, 204);
  });
}
