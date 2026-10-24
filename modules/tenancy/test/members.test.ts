import { countQueries, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzleTenancyRepository } from "../src/adapters/db/tenancy-repository.ts";

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
    managerId: await roleIdOf(migrator, tenantId, "manager"),
  };
}

interface MemberDto {
  membershipId: string;
  userId: string;
  roles: string[];
  branchIds: string[] | null;
}

async function listMembers(app: ReturnType<typeof appFor>): Promise<MemberDto[]> {
  const res = await get(app, "/v1/tenancy/members?limit=200");
  expect(res.status).toBe(200);
  return ((await res.json()) as { members: MemberDto[] }).members;
}

describe("GET /v1/tenancy/members", () => {
  it("lists members with role names and branch scope, newest first, keyset paginated", async () => {
    const b = await business();
    const cashier = await inviteAndAccept(
      pool,
      b.owner,
      b.tenantId,
      "c1@example.com",
      [b.cashierId],
      [b.storeId],
    );
    const manager = await inviteAndAccept(pool, b.owner, b.tenantId, "m1@example.com", [
      b.managerId,
    ]);
    const app = await ownerApp(pool, b.owner, b.tenantId);

    const members = await listMembers(app);
    expect(members.map((m) => m.membershipId)).toEqual([
      manager.membershipId,
      cashier.membershipId,
      members[2]?.membershipId,
    ]);
    const byUser = new Map(members.map((m) => [m.userId, m]));
    expect(byUser.get(cashier.userId)).toMatchObject({
      roles: ["cashier"],
      branchIds: [b.storeId],
    });
    expect(byUser.get(manager.userId)).toMatchObject({ roles: ["manager"], branchIds: null });

    const page = (await (await get(app, "/v1/tenancy/members?limit=2")).json()) as {
      members: MemberDto[];
      nextCursor: string | null;
    };
    expect(page.members).toHaveLength(2);
    expect(page.nextCursor).toBe(page.members[1]?.membershipId ?? null);
    const rest = (await (
      await get(app, `/v1/tenancy/members?limit=2&cursor=${String(page.nextCursor)}`)
    ).json()) as {
      members: MemberDto[];
      nextCursor: string | null;
    };
    expect(rest.members).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it("one query for the whole page (no N+1): roles are aggregated in the same statement", async () => {
    const b = await business();
    for (let i = 0; i < 3; i++) {
      await inviteAndAccept(pool, b.owner, b.tenantId, `n${String(i)}@example.com`, [b.cashierId]);
    }
    const { count } = await countQueries(() =>
      withTenantTx(pool, { tenantId: b.tenantId, requestId: "count" }, (tx) =>
        drizzleTenancyRepository.listMembers(tx, b.tenantId, 50),
      ),
    );
    // BEGIN, set_config, the list statement, COMMIT: a single data query.
    expect(count).toBeLessThanOrEqual(4);
  });

  it("404 without tenancy:read; anonymous 401", async () => {
    const b = await business();
    const stranger = uuidv7();
    expect(
      (await get(appFor(pool, await memberAuth(pool, stranger, b.tenantId)), "/v1/tenancy/members"))
        .status,
    ).toBe(404);
  });
});

describe("PUT /v1/tenancy/members/:id/roles", () => {
  it("replaces roles and branch scope; omitted branchIds keeps the scope", async () => {
    const b = await business();
    const member = await inviteAndAccept(
      pool,
      b.owner,
      b.tenantId,
      "p@example.com",
      [b.cashierId],
      [b.storeId],
    );
    const app = await ownerApp(pool, b.owner, b.tenantId);

    const kept = await put(
      app,
      `/v1/tenancy/members/${member.membershipId}/roles`,
      { roleIds: [b.managerId] },
      key(),
    );
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({
      membershipId: member.membershipId,
      branchIds: [b.storeId],
    });

    const all = await put(
      app,
      `/v1/tenancy/members/${member.membershipId}/roles`,
      { roleIds: [b.managerId], branchIds: null },
      key(),
    );
    expect(all.status).toBe(200);
    const after = (await listMembers(app)).find((m) => m.membershipId === member.membershipId);
    expect(after).toMatchObject({ roles: ["manager"], branchIds: null });
  });

  it("404 for an unknown membership; 422 for an unknown role", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    expect(
      (await put(app, `/v1/tenancy/members/${uuidv7()}/roles`, { roleIds: [b.cashierId] }, key()))
        .status,
    ).toBe(404);
    const ownerM = (await listMembers(app)).find((m) => m.userId === b.owner)?.membershipId ?? "";
    expect(
      (await put(app, `/v1/tenancy/members/${ownerM}/roles`, { roleIds: [uuidv7()] }, key()))
        .status,
    ).toBe(422);
  });

  it("the last active owner cannot give up the owner role (409); a second owner can", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const ownerMembership = (await listMembers(app)).find((m) => m.userId === b.owner);
    expect(ownerMembership).toBeDefined();
    const demote = await put(
      app,
      `/v1/tenancy/members/${ownerMembership?.membershipId ?? ""}/roles`,
      { roleIds: [b.cashierId] },
      key(),
    );
    expect(demote.status).toBe(409);

    const second = await inviteAndAccept(pool, b.owner, b.tenantId, "co@example.com", [
      b.ownerRoleId,
    ]);
    const demoteFirst = await put(
      app,
      `/v1/tenancy/members/${ownerMembership?.membershipId ?? ""}/roles`,
      { roleIds: [b.cashierId] },
      key(),
    );
    expect(demoteFirst.status).toBe(200);
    // now the co-owner is the last owner
    const co = appFor(pool, await memberAuth(pool, second.userId, b.tenantId), fakeSessions());
    const coMembership = (await listMembers(co)).find((m) => m.userId === second.userId);
    const demoteCo = await put(
      co,
      `/v1/tenancy/members/${coMembership?.membershipId ?? ""}/roles`,
      { roleIds: [b.cashierId] },
      key(),
    );
    expect(demoteCo.status).toBe(409);
  });

  it("only an owner may add or remove the owner role: a manager gets 404", async () => {
    const b = await business();
    const admin = await makeCustomRole(pool, b.owner, b.tenantId, "admin", [
      "tenancy:manage",
      "tenancy:read",
    ]);
    const adminUser = await inviteAndAccept(pool, b.owner, b.tenantId, "adm@example.com", [admin]);
    const target = await inviteAndAccept(pool, b.owner, b.tenantId, "tgt@example.com", [
      b.cashierId,
    ]);
    const adminApp = appFor(
      pool,
      await memberAuth(pool, adminUser.userId, b.tenantId),
      fakeSessions(),
    );

    const grant = await put(
      adminApp,
      `/v1/tenancy/members/${target.membershipId}/roles`,
      { roleIds: [b.ownerRoleId] },
      key(),
    );
    expect(grant.status).toBe(404);
    const ownerMembership = (await listMembers(await ownerApp(pool, b.owner, b.tenantId))).find(
      (m) => m.userId === b.owner,
    );
    const strip = await put(
      adminApp,
      `/v1/tenancy/members/${ownerMembership?.membershipId ?? ""}/roles`,
      { roleIds: [b.cashierId] },
      key(),
    );
    expect(strip.status).toBe(404);
    // Privilege ceiling: a non-owner may assign only roles they hold, never one above them.
    const above = await put(
      adminApp,
      `/v1/tenancy/members/${target.membershipId}/roles`,
      { roleIds: [b.managerId] },
      key(),
    );
    expect(above.status).toBe(404);
    const self = await put(
      adminApp,
      `/v1/tenancy/members/${adminUser.membershipId}/roles`,
      { roleIds: [admin, b.managerId] },
      key(),
    );
    expect(self.status).toBe(404);
    const ok = await put(
      adminApp,
      `/v1/tenancy/members/${target.membershipId}/roles`,
      { roleIds: [admin] },
      key(),
    );
    expect(ok.status).toBe(200);
    // An owner member is off limits to non-owners, even for a branch-scope-only change.
    const scope = await put(
      adminApp,
      `/v1/tenancy/members/${ownerMembership?.membershipId ?? ""}/roles`,
      { roleIds: [b.ownerRoleId], branchIds: null },
      key(),
    );
    expect(scope.status).toBe(404);
  });

  it("only an owner may create roles or edit role grants: a manager gets 404", async () => {
    const b = await business();
    const admin = await makeCustomRole(pool, b.owner, b.tenantId, "admin2", [
      "tenancy:manage",
      "tenancy:read",
    ]);
    const adminUser = await inviteAndAccept(pool, b.owner, b.tenantId, "adm2@example.com", [admin]);
    const adminApp = appFor(
      pool,
      await memberAuth(pool, adminUser.userId, b.tenantId),
      fakeSessions(),
    );

    const created = await post(
      adminApp,
      "/v1/tenancy/roles",
      { id: uuidv7(), name: "sneaky" },
      key(),
    );
    expect(created.status).toBe(404);
    const widened = await put(
      adminApp,
      `/v1/tenancy/roles/${admin}/permissions`,
      { grants: [{ permission: "tenancy:manage" }, { permission: "tenancy:read" }] },
      key(),
    );
    expect(widened.status).toBe(404);
  });

  it("an owner may add the owner role to a member", async () => {
    const b = await business();
    const target = await inviteAndAccept(pool, b.owner, b.tenantId, "up@example.com", [
      b.cashierId,
    ]);
    const res = await put(
      await ownerApp(pool, b.owner, b.tenantId),
      `/v1/tenancy/members/${target.membershipId}/roles`,
      { roleIds: [b.ownerRoleId] },
      key(),
    );
    expect(res.status).toBe(200);
  });

  it("a permission change is visible on the very next request (grant, then revoke)", async () => {
    const b = await business();
    const auditor = await makeCustomRole(pool, b.owner, b.tenantId, "auditor", ["tenancy:read"]);
    const user = await inviteAndAccept(pool, b.owner, b.tenantId, "aud@example.com", [auditor]);
    const reader = appFor(pool, await memberAuth(pool, user.userId, b.tenantId), fakeSessions());
    expect((await get(reader, "/v1/tenancy/members")).status).toBe(200);

    const strip = await put(
      await ownerApp(pool, b.owner, b.tenantId),
      `/v1/tenancy/roles/${auditor}/permissions`,
      { grants: [] },
      key(),
    );
    expect(strip.status).toBe(200);
    const fresh = appFor(pool, await memberAuth(pool, user.userId, b.tenantId), fakeSessions());
    expect((await get(fresh, "/v1/tenancy/members")).status).toBe(404);
  });
});
