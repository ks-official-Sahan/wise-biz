import { withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzleTenancyRepository } from "../src/adapters/db/tenancy-repository.ts";
import { DEFAULT_ROLE_GRANTS } from "../src/domain/business.ts";

import {
  appFor,
  createBusiness,
  fakeSessions,
  get,
  inTenant,
  inviteAndAccept,
  makeCustomRole,
  memberAuth,
  ownerApp,
  post,
  put,
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

const key = (): string => `k-${uuidv7()}`;

async function business() {
  const owner = uuidv7();
  const tenantId = await createBusiness(pool, owner);
  const branches = (await inTenant(migrator, tenantId, async (q) =>
    q("select id from tenancy.branches"),
  )) as {
    id: string;
  }[];
  return {
    owner,
    tenantId,
    storeId: branches[0]?.id ?? "",
    ownerRoleId: await roleIdOf(migrator, tenantId, "owner"),
    cashierId: await roleIdOf(migrator, tenantId, "cashier"),
  };
}

/** Second branch through the repository (there is no branch-creation endpoint yet). */
async function addWarehouse(tenantId: string): Promise<string> {
  const branchId = uuidv7();
  await withTenantTx(pool, { tenantId, requestId: "seed" }, (tx) =>
    drizzleTenancyRepository.insertBranch(tx, {
      tenantId,
      branchId,
      name: "Warehouse",
      kind: "warehouse",
      timezone: "Asia/Colombo",
      currency: "LKR",
      taxRegion: "LK",
      businessDayCutoff: "00:00",
      createdAt: new Date(0),
    }),
  );
  return branchId;
}

interface RoleDto {
  roleId: string;
  name: string;
  isSystem: boolean;
  implicitAll: boolean;
  grants: { permission: string; conditions?: unknown }[];
}

describe("GET /v1/tenancy/roles", () => {
  it("lists the system roles with their grants in one query; owner is implicit-all", async () => {
    const b = await business();
    const res = await get(await ownerApp(pool, b.owner, b.tenantId), "/v1/tenancy/roles");
    expect(res.status).toBe(200);
    const roles = ((await res.json()) as { roles: RoleDto[] }).roles;
    expect(roles.map((r) => r.name).sort()).toEqual(
      ["accountant", "cashier", "inventory_clerk", "manager", "owner", "supervisor"].sort(),
    );
    expect(roles.find((r) => r.name === "owner")).toMatchObject({
      implicitAll: true,
      isSystem: true,
    });
    expect(roles.find((r) => r.name === "manager")?.grants).toEqual(
      [...DEFAULT_ROLE_GRANTS.manager]
        .sort()
        .map((permission) => ({ permission, conditions: null })),
    );
  });

  it("404 for a caller without tenancy:read; the list is tenant-scoped", async () => {
    const b = await business();
    const other = await business();
    const stranger = appFor(pool, await memberAuth(pool, uuidv7(), b.tenantId), fakeSessions());
    expect((await get(stranger, "/v1/tenancy/roles")).status).toBe(404);
    const roles = (
      (await (
        await get(await ownerApp(pool, b.owner, b.tenantId), "/v1/tenancy/roles")
      ).json()) as {
        roles: RoleDto[];
      }
    ).roles;
    expect(roles.map((r) => r.roleId)).not.toContain(other.cashierId);
  });
});

describe("POST /v1/tenancy/roles", () => {
  it("creates a custom role (201); duplicates and system names are 409; reserved and malformed names 422", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const id = uuidv7();
    const created = await post(app, "/v1/tenancy/roles", { id, name: "shift_lead" }, key());
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      roleId: id,
      name: "shift_lead",
      isSystem: false,
      grants: [],
    });
    expect(
      (await post(app, "/v1/tenancy/roles", { id: uuidv7(), name: "shift_lead" }, key())).status,
    ).toBe(409);
    expect(
      (await post(app, "/v1/tenancy/roles", { id: uuidv7(), name: "manager" }, key())).status,
    ).toBe(409);
    expect(
      (await post(app, "/v1/tenancy/roles", { id: uuidv7(), name: "owner" }, key())).status,
    ).toBe(422);
    expect(
      (await post(app, "/v1/tenancy/roles", { id: uuidv7(), name: "platform_admin" }, key()))
        .status,
    ).toBe(422);
    expect(
      (await post(app, "/v1/tenancy/roles", { id: uuidv7(), name: "Bad Name" }, key())).status,
    ).toBe(422);
  });

  it("404 without tenancy:manage", async () => {
    const b = await business();
    const reader = appFor(pool, await memberAuth(pool, uuidv7(), b.tenantId), fakeSessions());
    expect(
      (await post(reader, "/v1/tenancy/roles", { id: uuidv7(), name: "x_role" }, key())).status,
    ).toBe(404);
  });
});

describe("PUT /v1/tenancy/roles/:id/permissions", () => {
  it("replaces grants (200), bumps the tenant permissions version, and the owner role is immutable (409)", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const roleId = await makeCustomRole(pool, b.owner, b.tenantId, "floor", []);
    const before = await inTenant(migrator, b.tenantId, async (q) =>
      q("select permissions_version from tenancy.tenants"),
    );
    const res = await put(
      app,
      `/v1/tenancy/roles/${roleId}/permissions`,
      { grants: [{ permission: "tenancy:read", conditions: { maxAmountMinor: 500 } }] },
      key(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      roleId,
      grants: [{ permission: "tenancy:read", conditions: { maxAmountMinor: 500 } }],
    });
    const after = await inTenant(migrator, b.tenantId, async (q) =>
      q("select permissions_version from tenancy.tenants"),
    );
    expect(
      Number((after as { permissions_version: number }[])[0]?.permissions_version),
    ).toBeGreaterThan(
      Number((before as { permissions_version: number }[])[0]?.permissions_version),
    );

    const ownerRole = await roleIdOf(migrator, b.tenantId, "owner");
    expect(
      (await put(app, `/v1/tenancy/roles/${ownerRole}/permissions`, { grants: [] }, key())).status,
    ).toBe(409);
  });

  it("422 for unknown, platform, duplicated, or malformed grants; 404 for an unknown role", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const roleId = await makeCustomRole(pool, b.owner, b.tenantId, "floor2", []);
    const url = `/v1/tenancy/roles/${roleId}/permissions`;
    const bad = [
      { grants: [{ permission: "sales:void" }] },
      { grants: [{ permission: "platform:admin" }] },
      { grants: [{ permission: "tenancy:read" }, { permission: "tenancy:read" }] },
      { grants: [{ permission: "tenancy:read", conditions: { notAKey: true } }] },
      { grants: [{ permission: "tenancy:read", conditions: { maxAmountMinor: -1 } }] },
    ];
    for (const body of bad) {
      expect((await put(app, url, body, key())).status).toBe(422);
    }
    expect(
      (await put(app, `/v1/tenancy/roles/${uuidv7()}/permissions`, { grants: [] }, key())).status,
    ).toBe(404);
  });

  it("a grant change takes effect on the next request, in both directions", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const roleId = await makeCustomRole(pool, b.owner, b.tenantId, "reader_role", []);
    const user = await inviteAndAccept(pool, b.owner, b.tenantId, "rr@example.com", [roleId]);
    const member = async () =>
      appFor(pool, await memberAuth(pool, user.userId, b.tenantId), fakeSessions());

    expect((await get(await member(), "/v1/tenancy/branches")).status).toBe(404);
    await put(
      app,
      `/v1/tenancy/roles/${roleId}/permissions`,
      { grants: [{ permission: "tenancy:read" }] },
      key(),
    );
    expect((await get(await member(), "/v1/tenancy/branches")).status).toBe(200);
    await put(app, `/v1/tenancy/roles/${roleId}/permissions`, { grants: [] }, key());
    expect((await get(await member(), "/v1/tenancy/branches")).status).toBe(404);
  });
});

describe("GET /v1/tenancy/branches and /v1/tenancy/branches/:id", () => {
  it("the owner sees every branch; a branch-scoped member sees only their branch", async () => {
    const b = await business();
    const warehouse = await addWarehouse(b.tenantId);
    const all = (await (
      await get(await ownerApp(pool, b.owner, b.tenantId), "/v1/tenancy/branches")
    ).json()) as {
      branches: { branchId: string }[];
    };
    expect(all.branches.map((x) => x.branchId).sort()).toEqual([b.storeId, warehouse].sort());

    // A custom role with tenancy:read (cashier has no grants by default), scoped to the store branch only.
    const storeReader = await makeCustomRole(pool, b.owner, b.tenantId, "store_reader", [
      "tenancy:read",
    ]);
    const reader = await inviteAndAccept(
      pool,
      b.owner,
      b.tenantId,
      "scoped@example.com",
      [storeReader],
      [b.storeId],
    );
    const scoped = appFor(pool, await memberAuth(pool, reader.userId, b.tenantId), fakeSessions());
    const list = (await (await get(scoped, "/v1/tenancy/branches")).json()) as {
      branches: { branchId: string }[];
    };
    expect(list.branches.map((x) => x.branchId)).toEqual([b.storeId]);
    expect((await get(scoped, `/v1/tenancy/branches/${b.storeId}`)).status).toBe(200);
    expect((await get(scoped, `/v1/tenancy/branches/${warehouse}`)).status).toBe(404);
  });

  it("GET one branch: 404 for an unknown id; the row carries the cutoff as HH:MM", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const one = await get(app, `/v1/tenancy/branches/${b.storeId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({
      branchId: b.storeId,
      kind: "store",
      businessDayCutoff: "00:00",
    });
    expect((await get(app, `/v1/tenancy/branches/${uuidv7()}`)).status).toBe(404);
  });

  it("a scoped member with no permitted branch gets 404 on the list", async () => {
    const b = await business();
    const roleNoRead = await makeCustomRole(pool, b.owner, b.tenantId, "nothing", []);
    const user = await inviteAndAccept(
      pool,
      b.owner,
      b.tenantId,
      "nr@example.com",
      [roleNoRead],
      [b.storeId],
    );
    const app = appFor(pool, await memberAuth(pool, user.userId, b.tenantId), fakeSessions());
    expect((await get(app, "/v1/tenancy/branches")).status).toBe(404);
  });
});
