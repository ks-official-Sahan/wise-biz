import { DomainError } from "@wise-biz/errors";
import { OWNER_ROLE } from "@wise-biz/policy";

import { assertCustomRoleName, MAX_CUSTOM_ROLES, validateGrants } from "../domain/roles.ts";
import { TenantRoleCreatedV1, TenantRolePermissionsChangedV1 } from "../events.ts";

import { tenancyEvent } from "./envelope.ts";

import type { TenancyRepository, Tx } from "../ports/tenancy-repository.ts";
import type { RolePermissionsInput, RoleCreateInput } from "../schemas.ts";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { PermissionCatalog } from "@wise-biz/policy";

/** Role definitions decide what every member can do, so only owners edit them (NOT_FOUND for others). */
export interface RoleAdminActor {
  readonly isOwner: boolean;
}

function assertOwner(actor: RoleAdminActor): void {
  if (!actor.isOwner) throw new DomainError("NOT_FOUND", "Not found");
}

/** Creates a custom role (no grants yet). System role names collide with the unique key: CONFLICT. */
export async function createRoleCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  input: RoleCreateInput,
  actor: RoleAdminActor,
): Promise<CommandResult> {
  assertOwner(actor);
  const tenantId = ctx.tenant.tenantId;
  const name = assertCustomRoleName(input.name);
  if ((await repo.countCustomRoles(tx, tenantId)) >= MAX_CUSTOM_ROLES) {
    throw new DomainError("CONFLICT", "custom role limit reached for this business");
  }
  await repo.insertRole(tx, { tenantId, id: input.id, name, createdAt: ctx.now });
  return {
    status: 201,
    body: { roleId: input.id, name, isSystem: false, implicitAll: false, grants: [] },
    audit: [
      {
        action: "tenancy.role.created",
        entity: "tenancy.role",
        entityId: input.id,
        after: { name },
      },
    ],
    events: [
      tenancyEvent(TenantRoleCreatedV1, ctx, `role/${input.id}`, {
        tenantId,
        roleId: input.id,
        name,
      }),
    ],
  };
}

/**
 * Replace a role's grants. Validation first (catalog, no platform permissions, policy conditions), then the rows are
 * replaced; the statement-level trigger bumps tenants.permissions_version, so the next request sees the change.
 * The owner role is immutable (CONFLICT): it holds every tenant permission implicitly.
 */
export async function setRolePermissionsCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  roleId: string,
  input: RolePermissionsInput,
  catalog: PermissionCatalog,
  actor: RoleAdminActor,
): Promise<CommandResult> {
  assertOwner(actor);
  const tenantId = ctx.tenant.tenantId;
  const role = await repo.findRole(tx, tenantId, roleId);
  if (role === null) throw new DomainError("NOT_FOUND", "Not found");
  if (role.name === OWNER_ROLE) throw new DomainError("CONFLICT", "the owner role is immutable");

  const rows = validateGrants(input.grants, catalog);
  const withIds = rows.map((g) => ({
    id: ctx.ids.uuidv7(),
    permission: g.permission,
    conditions: g.conditions,
  }));
  await repo.replaceRoleGrants(tx, tenantId, roleId, withIds, ctx.now);

  const permissions = rows.map((g) => g.permission).sort();
  return {
    status: 200,
    body: {
      roleId,
      name: role.name,
      isSystem: role.isSystem,
      implicitAll: false,
      grants: rows.map((g) => ({ permission: g.permission, conditions: g.conditions })),
    },
    audit: [
      {
        action: "tenancy.role.permissions_changed",
        entity: "tenancy.role",
        entityId: roleId,
        after: { permissions },
      },
    ],
    events: [
      tenancyEvent(TenantRolePermissionsChangedV1, ctx, `role/${roleId}`, {
        tenantId,
        roleId,
        permissions,
      }),
    ],
  };
}
