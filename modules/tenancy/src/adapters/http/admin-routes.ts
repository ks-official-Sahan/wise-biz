import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import {
  asRouteResponse,
  authorize,
  permits,
  requireTenant,
  requireUser,
  runCommand,
} from "@wise-biz/module-kit";

import {
  acceptInviteCommand,
  createInviteCommand,
  revokeInviteCommand,
} from "../../application/invites.ts";
import { updateMemberRolesCommand } from "../../application/members.ts";
import { createRoleCommand, setRolePermissionsCommand } from "../../application/roles.ts";
import { inviteStatus } from "../../domain/invites.ts";
import { pageSize } from "../../domain/pagination.ts";
import { inviteTokenMatches } from "../../invite-token.ts";
import {
  BranchListSchema,
  BranchSchema,
  EmptyBodySchema,
  IdParamSchema,
  InviteAcceptSchema,
  InviteAcceptedSchema,
  InviteCreateSchema,
  InviteCreatedSchema,
  InviteListSchema,
  InviteRevokedSchema,
  MemberListSchema,
  MemberRolesUpdateSchema,
  MemberRolesUpdatedSchema,
  PageQuerySchema,
  RoleCreateSchema,
  RoleListSchema,
  RolePermissionsSchema,
  RoleSchema,
} from "../../schemas.ts";

import type {
  ActiveTenantSetter,
  RoleRow,
  TenancyRepository,
} from "../../ports/tenancy-repository.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, AuthContext, ModuleDeps } from "@wise-biz/module-kit";
import type { Permission, PermissionCatalog } from "@wise-biz/policy";
import type { Context, MiddlewareHandler } from "hono";

type UserAuth = Extract<AuthContext, { kind: "user" }>;

export interface AdminDeps {
  readonly module: ModuleDeps;
  readonly repo: TenancyRepository;
  readonly sessions: ActiveTenantSetter;
  readonly options: { readonly inviteSecret?: string | undefined };
  readonly catalog: PermissionCatalog;
}

/** The route-level permission gate. Runs before body validation, so an unauthorized caller always gets 404. */
const can =
  (permission: Permission): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };

const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireUser(c);
  await next();
};

function userOf(c: Context<AppEnv>): UserAuth {
  const auth = c.get("auth");
  if (auth.kind !== "user") throw new DomainError("UNAUTHENTICATED", "Authentication required");
  return auth;
}

const isOwner = (c: Context<AppEnv>): boolean => userOf(c).roles.includes("owner");

/** Typed through the module-kit bridge: the body was built to match the route's response schema above. */
const json = (c: Context<AppEnv>, body: unknown, status: 200): never =>
  asRouteResponse(c.json(body as never, status));

const inviteCreateRoute = createRoute({
  method: "post",
  path: "/v1/tenancy/invites",
  tags: ["tenancy"],
  summary: "Invite a person by email to this business (72 h, emailed link)",
  middleware: [can("tenancy:manage")] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: InviteCreateSchema } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: InviteCreatedSchema } },
    },
  },
});

const inviteListRoute = createRoute({
  method: "get",
  path: "/v1/tenancy/invites",
  tags: ["tenancy"],
  summary: "Pending invites (newest first, keyset paginated)",
  middleware: [can("tenancy:manage")] as const,
  request: { query: PageQuerySchema },
  responses: {
    200: { description: "Invites", content: { "application/json": { schema: InviteListSchema } } },
  },
});

const inviteRevokeRoute = createRoute({
  method: "post",
  path: "/v1/tenancy/invites/{id}/revoke",
  tags: ["tenancy"],
  summary: "Revoke a pending invite (its link stops working)",
  middleware: [can("tenancy:manage")] as const,
  request: {
    params: IdParamSchema,
    body: { required: true, content: { "application/json": { schema: EmptyBodySchema } } },
  },
  responses: {
    200: {
      description: "Revoked",
      content: { "application/json": { schema: InviteRevokedSchema } },
    },
  },
});

const inviteAcceptRoute = createRoute({
  method: "post",
  path: "/v1/tenancy/invites/accept",
  tags: ["tenancy"],
  summary: "Accept an invite as the signed-in, verified user whose email it was sent to",
  middleware: [signedIn] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: InviteAcceptSchema } } },
  },
  responses: {
    200: {
      description: "Joined",
      content: { "application/json": { schema: InviteAcceptedSchema } },
    },
  },
});

const membersListRoute = createRoute({
  method: "get",
  path: "/v1/tenancy/members",
  tags: ["tenancy"],
  summary: "Members with their role names and branch scope (one query, keyset paginated)",
  middleware: [can("tenancy:read")] as const,
  request: { query: PageQuerySchema },
  responses: {
    200: { description: "Members", content: { "application/json": { schema: MemberListSchema } } },
  },
});

const memberRolesRoute = createRoute({
  method: "put",
  path: "/v1/tenancy/members/{id}/roles",
  tags: ["tenancy"],
  summary: "Replace a member's roles and, optionally, branch scope",
  middleware: [can("tenancy:manage")] as const,
  request: {
    params: IdParamSchema,
    body: { required: true, content: { "application/json": { schema: MemberRolesUpdateSchema } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: MemberRolesUpdatedSchema } },
    },
  },
});

const rolesListRoute = createRoute({
  method: "get",
  path: "/v1/tenancy/roles",
  tags: ["tenancy"],
  summary: "Roles of this business with their grants (one query)",
  middleware: [can("tenancy:read")] as const,
  responses: {
    200: { description: "Roles", content: { "application/json": { schema: RoleListSchema } } },
  },
});

const roleCreateRoute = createRoute({
  method: "post",
  path: "/v1/tenancy/roles",
  tags: ["tenancy"],
  summary: "Create a custom role (no grants yet)",
  middleware: [can("tenancy:manage")] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: RoleCreateSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RoleSchema } } },
  },
});

const rolePermissionsRoute = createRoute({
  method: "put",
  path: "/v1/tenancy/roles/{id}/permissions",
  tags: ["tenancy"],
  summary: "Replace a role's grants (takes effect on the next request)",
  middleware: [can("tenancy:manage")] as const,
  request: {
    params: IdParamSchema,
    body: { required: true, content: { "application/json": { schema: RolePermissionsSchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: RoleSchema } } },
  },
});

const branchesListRoute = createRoute({
  method: "get",
  path: "/v1/tenancy/branches",
  tags: ["tenancy"],
  summary: "Branches this caller may see (a branch-scoped member sees only their branches)",
  responses: {
    200: { description: "Branches", content: { "application/json": { schema: BranchListSchema } } },
  },
});

const branchRoute = createRoute({
  method: "get",
  path: "/v1/tenancy/branches/{id}",
  tags: ["tenancy"],
  summary: "One branch (404 outside the caller's branch scope)",
  request: { params: IdParamSchema },
  responses: {
    200: { description: "Branch", content: { "application/json": { schema: BranchSchema } } },
  },
});

function toRoleDto(r: RoleRow) {
  return {
    roleId: r.roleId,
    name: r.name,
    isSystem: r.isSystem,
    implicitAll: r.name === "owner",
    grants: r.grants.map((g) => ({
      permission: g.permission,
      conditions: g.conditions as Record<string, unknown> | null,
    })),
  };
}

/** Admin surface: invites, members, roles, branches. Every mutation goes through runCommand. */
export function mountAdminRoutes(app: OpenAPIHono<AppEnv>, deps: AdminDeps): void {
  const { repo, options, catalog } = deps;
  const pool = deps.module.pool;

  app.openapi(inviteCreateRoute, async (c) => {
    const owner = isOwner(c);
    const res = await runCommand(c, deps.module, {
      permission: "tenancy:manage",
      input: InviteCreateSchema,
      handler: (tx, input, ctx) =>
        createInviteCommand(repo, tx, ctx, input, { isOwner: owner, roles: userOf(c).roles }),
    });
    return asRouteResponse(res);
  });

  app.openapi(inviteListRoute, async (c) => {
    const tenant = requireTenant(c);
    const q = c.req.valid("query");
    const limit = pageSize(q.limit);
    const rows = await withTenantTx(pool, tenant, (tx) =>
      repo.listPendingInvites(tx, tenant.tenantId, limit + 1, q.cursor),
    );
    const page = rows.slice(0, limit);
    const now = new Date(deps.module.clock.now());
    return json(
      c,
      {
        invites: page.map((i) => ({
          inviteId: i.inviteId,
          email: i.email,
          roleIds: i.roleIds,
          branchIds: i.branchIds,
          expiresAt: i.expiresAt.toISOString(),
          createdAt: i.createdAt.toISOString(),
          expired: inviteStatus(i, now) === "expired",
        })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.inviteId ?? null) : null,
      },
      200,
    );
  });

  app.openapi(inviteRevokeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const res = await runCommand(c, deps.module, {
      permission: "tenancy:manage",
      input: EmptyBodySchema,
      handler: (tx, _input, ctx) => revokeInviteCommand(repo, tx, ctx, id),
    });
    return asRouteResponse(res);
  });

  app.openapi(inviteAcceptRoute, async (c) => {
    const { userId, sessionId } = requireUser(c);
    const auth = userOf(c);
    const { tenantId, inviteId, token } = c.req.valid("json");
    // Token first, in constant time: a wrong token is a plain 404 before any database work.
    if (!inviteTokenMatches(options.inviteSecret, tenantId, inviteId, token)) {
      throw new DomainError("NOT_FOUND", "Not found");
    }
    const res = await runCommand(c, deps.module, {
      bootstrapTenantId: (i) => i.tenantId,
      input: InviteAcceptSchema,
      handler: (tx, input, ctx) =>
        acceptInviteCommand(repo, tx, ctx, input.inviteId, {
          email: auth.email,
          emailVerified: auth.emailVerified,
        }),
    });
    // After commit. Same as sign-up: point the session at the business it just joined (also on a replay).
    if (res.status < 300) await deps.sessions.setActiveTenant(sessionId, userId, tenantId);
    return asRouteResponse(res);
  });

  app.openapi(membersListRoute, async (c) => {
    const tenant = requireTenant(c);
    const q = c.req.valid("query");
    const limit = pageSize(q.limit);
    const rows = await withTenantTx(pool, tenant, (tx) =>
      repo.listMembers(tx, tenant.tenantId, limit + 1, q.cursor),
    );
    const page = rows.slice(0, limit);
    return json(
      c,
      {
        members: page.map((m) => ({
          membershipId: m.membershipId,
          userId: m.userId,
          status: m.status,
          roles: m.roles,
          branchIds: m.branchIds,
          createdAt: m.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.membershipId ?? null) : null,
      },
      200,
    );
  });

  app.openapi(memberRolesRoute, async (c) => {
    const { id } = c.req.valid("param");
    const owner = isOwner(c);
    const res = await runCommand(c, deps.module, {
      permission: "tenancy:manage",
      input: MemberRolesUpdateSchema,
      handler: (tx, input, ctx) =>
        updateMemberRolesCommand(repo, tx, ctx, id, input, {
          isOwner: owner,
          roles: userOf(c).roles,
        }),
    });
    return asRouteResponse(res);
  });

  app.openapi(rolesListRoute, async (c) => {
    const tenant = requireTenant(c);
    const rows = await withTenantTx(pool, tenant, (tx) => repo.listRoles(tx, tenant.tenantId));
    return json(c, { roles: rows.map(toRoleDto) }, 200);
  });

  app.openapi(roleCreateRoute, async (c) => {
    const owner = isOwner(c);
    const res = await runCommand(c, deps.module, {
      permission: "tenancy:manage",
      input: RoleCreateSchema,
      handler: (tx, input, ctx) => createRoleCommand(repo, tx, ctx, input, { isOwner: owner }),
    });
    return asRouteResponse(res);
  });

  app.openapi(rolePermissionsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const owner = isOwner(c);
    const res = await runCommand(c, deps.module, {
      permission: "tenancy:manage",
      input: RolePermissionsSchema,
      handler: (tx, input, ctx) =>
        setRolePermissionsCommand(repo, tx, ctx, id, input, catalog, { isOwner: owner }),
    });
    return asRouteResponse(res);
  });

  app.openapi(branchesListRoute, async (c) => {
    const tenant = requireTenant(c);
    const auth = userOf(c);
    // Scoped members list only the branches their scope allows; unscoped members use the plain permission check.
    const scope =
      auth.branchScope === "all"
        ? "all"
        : auth.branchScope.filter((branchId) => permits(c, "tenancy:read", { branchId }));
    if (scope !== "all" && scope.length === 0) throw new DomainError("NOT_FOUND", "Not found");
    if (scope === "all") authorize(c, "tenancy:read");
    const rows = await withTenantTx(pool, tenant, (tx) =>
      repo.listBranches(tx, tenant.tenantId, scope, 200),
    );
    return json(c, { branches: rows }, 200);
  });

  app.openapi(branchRoute, async (c) => {
    const tenant = requireTenant(c);
    const { id } = c.req.valid("param");
    authorize(c, "tenancy:read", { branchId: id });
    const row = await withTenantTx(pool, tenant, (tx) => repo.findBranch(tx, tenant.tenantId, id));
    if (row === null) throw new DomainError("NOT_FOUND", "Not found");
    return json(c, row, 200);
  });
}
