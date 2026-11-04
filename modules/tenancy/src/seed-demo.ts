import { appendAudit, withTenantTx } from "@wise-biz/db";

import { drizzleTenancyRepository } from "./adapters/db/tenancy-repository.ts";
import { newBusiness } from "./domain/business.ts";

import type { TenancyRepository } from "./ports/tenancy-repository.ts";
import type pg from "pg";

export interface DemoMember {
  readonly userId: string;
  /** System role names, e.g. ["manager"]. */
  readonly roles: readonly string[];
  /** "store" = scoped to the store branch only; "all" = every branch. */
  readonly scope: "store" | "all";
}

export interface SeedDemoInput {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly members: readonly DemoMember[];
  readonly now: Date;
  readonly ids: { uuidv7(): string };
  readonly requestId: string;
}

/**
 * Dev-only demo business: "Demo Store" with a store and a warehouse branch, the owner, and one member per other system
 * role. Idempotent: an existing tenant with this id is left untouched ("exists"). One transaction: all or nothing.
 * Writes go through the tenancy repository and carry an audit row (actor = system, on behalf of the owner).
 */
export async function seedDemoTenant(
  pool: pg.Pool,
  input: SeedDemoInput,
  repo: TenancyRepository = drizzleTenancyRepository,
): Promise<"created" | "exists"> {
  const { tenantId, now } = input;
  return withTenantTx(pool, { tenantId, requestId: input.requestId }, async (tx) => {
    if ((await repo.tenantName(tx, tenantId)) !== null) return "exists";

    const rows = newBusiness(
      {
        tenantId,
        name: "Demo Store",
        branch: {
          name: "Store",
          kind: "store",
          timezone: "Asia/Colombo",
          currency: "LKR",
          taxRegion: "LK",
        },
      },
      { ownerUserId: input.ownerUserId, nextId: () => input.ids.uuidv7(), now },
    );
    await repo.insertBusiness(tx, rows);
    const warehouseId = input.ids.uuidv7();
    await repo.insertBranch(tx, {
      tenantId,
      branchId: warehouseId,
      name: "Warehouse",
      kind: "warehouse",
      timezone: "Asia/Colombo",
      currency: "LKR",
      taxRegion: "LK",
      businessDayCutoff: "00:00",
      createdAt: now,
    });

    const roleIdByName = new Map(
      (await repo.listRoles(tx, tenantId)).map((r) => [r.name, r.roleId]),
    );
    for (const m of input.members) {
      const membershipId = input.ids.uuidv7();
      await repo.insertMembership(tx, {
        tenantId,
        id: membershipId,
        userId: m.userId,
        branchIds: m.scope === "store" ? [rows.branch.id] : null,
        createdAt: now,
      });
      const roleIds = m.roles.map((name) => {
        const id = roleIdByName.get(name);
        if (id === undefined) throw new Error(`seed: unknown system role ${name}`);
        return id;
      });
      await repo.insertMembershipRoles(tx, tenantId, membershipId, roleIds);
    }

    await appendAudit(tx, [
      {
        actorType: "system",
        actorId: input.ownerUserId,
        action: "tenancy.demo.seeded",
        entity: "tenancy.tenant",
        entityId: tenantId,
        requestId: input.requestId,
      },
    ]);
    return "created";
  });
}
