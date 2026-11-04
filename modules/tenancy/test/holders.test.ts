import { withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { permissionHolders } from "../src/holders.ts";

import {
  createBusiness,
  inTenant,
  inviteAndAccept,
  makeCustomRole,
  roleIdOf,
  setup,
} from "./helpers.ts";

import type pg from "pg";

let pool: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;
beforeAll(async () => {
  ({ pool, migrator, drop } = await setup());
});
afterAll(async () => {
  await drop();
});

const holders = (
  tenantId: string,
  permission: string,
  scope: { locationIds?: string[]; branchIds?: string[]; tenantWide?: boolean } = {},
) =>
  withTenantTx(migrator, { tenantId, userId: uuidv7(), requestId: "test" }, (tx) =>
    permissionHolders(tx as never, tenantId, permission, scope),
  );

describe("permissionHolders", () => {
  it("returns the owner, role holders, and (for a branch-limited member) only their branches", async () => {
    const owner = uuidv7();
    const tenantId = await createBusiness(pool, owner);
    const store = (
      (await inTenant(migrator, tenantId, async (q) => q("select id from tenancy.branches"))) as {
        id: string;
      }[]
    )[0]?.id;
    const location = (
      (await inTenant(migrator, tenantId, async (q) => q("select id from tenancy.locations"))) as {
        id: string;
      }[]
    )[0]?.id;
    if (store === undefined || location === undefined) throw new Error("seed missing");

    const viewer = await makeCustomRole(pool, owner, tenantId, "stock_viewer", ["tenancy:read"]);
    const other = await makeCustomRole(pool, owner, tenantId, "reporter", ["tenancy:manage"]);
    const everywhere = await inviteAndAccept(pool, owner, tenantId, "a@example.com", [viewer]);
    const here = await inviteAndAccept(pool, owner, tenantId, "b@example.com", [viewer], [store]);
    const unrelated = await inviteAndAccept(pool, owner, tenantId, "c@example.com", [other]);
    expect(await roleIdOf(migrator, tenantId, "owner")).toBeTruthy();

    // No location: no branch filter. Owner and both viewers, not the reporter.
    const all = await holders(tenantId, "tenancy:read");
    expect(all.sort()).toEqual([owner, everywhere.userId, here.userId].sort());
    expect(all).not.toContain(unrelated.userId);

    // A location in the member's branch: still included.
    expect((await holders(tenantId, "tenancy:read", { locationIds: [location] })).sort()).toEqual(
      [owner, everywhere.userId, here.userId].sort(),
    );

    // A location of some other branch: the branch-limited member is left out.
    const elsewhere = await holders(tenantId, "tenancy:read", { locationIds: [uuidv7()] });
    expect(elsewhere.sort()).toEqual([owner, everywhere.userId].sort());

    // The same by branch (terminal alerts carry a branch, not a location).
    expect((await holders(tenantId, "tenancy:read", { branchIds: [store] })).sort()).toEqual(
      [owner, everywhere.userId, here.userId].sort(),
    );
    expect((await holders(tenantId, "tenancy:read", { branchIds: [uuidv7()] })).sort()).toEqual(
      [owner, everywhere.userId].sort(),
    );

    // Tenant-wide figures: only members who see every branch, never the branch-limited one.
    expect((await holders(tenantId, "tenancy:read", { tenantWide: true })).sort()).toEqual(
      [owner, everywhere.userId].sort(),
    );
  });

  it("leaves out suspended members and other businesses", async () => {
    const owner = uuidv7();
    const tenantId = await createBusiness(pool, owner);
    const other = await createBusiness(pool, uuidv7());
    expect(await holders(tenantId, "tenancy:read")).toEqual([owner]);
    expect(await holders(other, "tenancy:read")).not.toContain(owner);
    await inTenant(migrator, tenantId, async (q) =>
      q("update tenancy.memberships set status = 'suspended'"),
    );
    expect(await holders(tenantId, "tenancy:read")).toEqual([]);
  });
});
