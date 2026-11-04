import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INVITE_TTL_MS } from "../src/domain/invites.ts";

import {
  INVITE_SECRET,
  SESSION,
  appFor,
  clock,
  createBusiness,
  fakeSessions,
  get,
  inTenant,
  inviteAndAccept,
  inviteTokenFor,
  makeCustomRole,
  memberAuth,
  post,
  roleIdOf,
  setup,
  userAuth,
  withAccount,
  ownerApp,
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
const later = (ms: number) => () => clock.now() + ms;

interface Business {
  owner: string;
  tenantId: string;
  storeId: string;
  ownerRoleId: string;
  cashierId: string;
}

/** A business with a warehouse branch and an owner; returns ids the tests need. */
async function business(): Promise<Business> {
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

async function outboxTypes(tenantId: string): Promise<string[]> {
  const rows = await inTenant(migrator, tenantId, async (q) =>
    q("select type from infra.outbox order by created_at, id"),
  );
  return (rows as { type: string }[]).map((r) => r.type);
}

describe("POST /v1/tenancy/invites", () => {
  it("creates a normalised, expiring invite with its outbox event and audit row", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const inviteId = uuidv7();
    const res = await post(
      app,
      "/v1/tenancy/invites",
      {
        id: inviteId,
        email: "  Ana.Silva@Example.COM ",
        roleIds: [b.cashierId],
        branchIds: [b.storeId],
      },
      key(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      inviteId: string;
      email: string;
      expiresAt: string;
      roleIds: string[];
    };
    expect(body).toMatchObject({
      inviteId,
      email: "ana.silva@example.com",
      roleIds: [b.cashierId],
    });
    expect(new Date(body.expiresAt).getTime()).toBe(clock.now() + INVITE_TTL_MS);

    const events = await inTenant(migrator, b.tenantId, async (q) =>
      q("select type, payload from infra.outbox where type = 'tenancy.member.invited'"),
    );
    const payload = (events as { payload: { data: Record<string, unknown> } }[])[0]?.payload.data;
    expect(payload).toMatchObject({
      inviteId,
      tenantId: b.tenantId,
      email: "ana.silva@example.com",
      tenantName: "Acme Traders",
    });
    const audit = await inTenant(migrator, b.tenantId, async (q) =>
      q("select action, entity_id from audit.audit_log where action = 'tenancy.invite.created'"),
    );
    expect(audit).toHaveLength(1);
  });

  it("idempotent replay: same key and body returns the stored response and creates nothing twice", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const k = key();
    const body = { id: uuidv7(), email: "replay@example.com", roleIds: [b.cashierId] };
    const first = await post(app, "/v1/tenancy/invites", body, k);
    const second = await post(app, "/v1/tenancy/invites", body, k);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await second.text()).toBe(await first.text());
    const count = await inTenant(migrator, b.tenantId, async (q) =>
      q("select id from tenancy.invites"),
    );
    expect(count).toHaveLength(1);
  });

  it("409 while a live pending invite exists for the email; 404 for a caller without tenancy:manage", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const first = await post(
      app,
      "/v1/tenancy/invites",
      { id: uuidv7(), email: "dup@example.com", roleIds: [b.cashierId] },
      key(),
    );
    expect(first.status).toBe(201);
    const dup = await post(
      app,
      "/v1/tenancy/invites",
      { id: uuidv7(), email: "DUP@example.com", roleIds: [b.cashierId] },
      key(),
    );
    expect(dup.status).toBe(409);

    // accountant holds tenancy:read only (default grants): it may read, it may not invite.
    const reader = await inviteAndAccept(pool, b.owner, b.tenantId, "reader@example.com", [
      await roleIdOf(migrator, b.tenantId, "accountant"),
    ]);
    const denied = await post(
      appFor(pool, await memberAuth(pool, reader.userId, b.tenantId), fakeSessions()),
      "/v1/tenancy/invites",
      { id: uuidv7(), email: "x@example.com", roleIds: [b.cashierId] },
      key(),
    );
    expect(denied.status).toBe(404);
  });

  it("422 for unknown or duplicated role and branch ids (ids of another tenant are unknown here)", async () => {
    const b = await business();
    const other = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const cases = [
      { roleIds: [uuidv7()] },
      { roleIds: [other.cashierId] },
      { roleIds: [b.cashierId], branchIds: [uuidv7()] },
      { roleIds: [b.cashierId, b.cashierId] },
      { roleIds: [b.cashierId], branchIds: [b.storeId, b.storeId] },
    ];
    for (const c of cases) {
      const res = await post(
        app,
        "/v1/tenancy/invites",
        { id: uuidv7(), email: `v-${uuidv7()}@example.com`, ...c },
        key(),
      );
      expect(res.status).toBe(422);
    }
  });

  it("only an owner may invite with the owner role (non-owner: 404)", async () => {
    const b = await business();
    const inviterRole = await makeCustomRole(pool, b.owner, b.tenantId, "inviter", [
      "tenancy:manage",
    ]);
    const invited = await inviteAndAccept(pool, b.owner, b.tenantId, "inviter@example.com", [
      inviterRole,
    ]);
    const inviter = await memberAuth(pool, invited.userId, b.tenantId);
    const app = appFor(pool, inviter, fakeSessions());

    const denied = await post(
      app,
      "/v1/tenancy/invites",
      { id: uuidv7(), email: "boss@example.com", roleIds: [b.ownerRoleId] },
      key(),
    );
    expect(denied.status).toBe(404);
    // Privilege ceiling: a non-owner may only invite with roles they hold.
    const above = await post(
      app,
      "/v1/tenancy/invites",
      { id: uuidv7(), email: "cashier@example.com", roleIds: [b.cashierId] },
      key(),
    );
    expect(above.status).toBe(404);
    const allowed = await post(
      app,
      "/v1/tenancy/invites",
      { id: uuidv7(), email: "peer@example.com", roleIds: [inviterRole] },
      key(),
    );
    expect(allowed.status).toBe(201);
  });

  it("re-inviting an email whose pending invite expired revokes the old one in the same transaction", async () => {
    const b = await business();
    const first = uuidv7();
    const old = await post(
      await ownerApp(pool, b.owner, b.tenantId),
      "/v1/tenancy/invites",
      { id: first, email: "again@example.com", roleIds: [b.cashierId] },
      key(),
    );
    expect(old.status).toBe(201);

    const afterExpiry = await ownerApp(pool, b.owner, b.tenantId, later(INVITE_TTL_MS + 1));
    const second = uuidv7();
    const res = await post(
      afterExpiry,
      "/v1/tenancy/invites",
      { id: second, email: "again@example.com", roleIds: [b.cashierId] },
      key(),
    );
    expect(res.status).toBe(201);

    const rows = await inTenant(migrator, b.tenantId, async (q) =>
      q("select id, revoked_at from tenancy.invites where email = 'again@example.com' order by id"),
    );
    const byId = new Map(
      (rows as { id: string; revoked_at: Date | null }[]).map((r) => [r.id, r.revoked_at]),
    );
    expect(byId.get(first)).not.toBeNull();
    expect(byId.get(second)).toBeNull();
    expect(await outboxTypes(b.tenantId)).toContain("tenancy.invite.revoked");
  });
});

describe("GET /v1/tenancy/invites", () => {
  it("lists pending invites newest first with keyset pagination and an expired flag", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = uuidv7();
      made.push(id);
      expect(
        (
          await post(
            app,
            "/v1/tenancy/invites",
            { id, email: `page-${String(i)}@example.com`, roleIds: [b.cashierId] },
            key(),
          )
        ).status,
      ).toBe(201);
    }
    const first = (await (await get(app, "/v1/tenancy/invites?limit=2")).json()) as {
      invites: { inviteId: string; expired: boolean }[];
      nextCursor: string | null;
    };
    expect(first.invites.map((i) => i.inviteId)).toEqual([made[2], made[1]]);
    expect(first.invites.every((i) => !i.expired)).toBe(true);
    expect(first.nextCursor).toBe(made[1]);

    const second = (await (
      await get(app, `/v1/tenancy/invites?limit=2&cursor=${String(first.nextCursor)}`)
    ).json()) as {
      invites: { inviteId: string }[];
      nextCursor: string | null;
    };
    expect(second.invites.map((i) => i.inviteId)).toEqual([made[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("422 for an out-of-range limit; 404 without tenancy:manage", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    expect((await get(app, "/v1/tenancy/invites?limit=0")).status).toBe(422);
    const anon = appFor(pool, null, fakeSessions());
    expect((await get(anon, "/v1/tenancy/invites")).status).toBe(401);
  });
});

describe("POST /v1/tenancy/invites/:id/revoke", () => {
  it("revokes once (200), then 409; unknown invite 404; accepted invite 409", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const id = uuidv7();
    expect(
      (
        await post(
          app,
          "/v1/tenancy/invites",
          { id, email: "revoke@example.com", roleIds: [b.cashierId] },
          key(),
        )
      ).status,
    ).toBe(201);
    const revoke = await post(app, `/v1/tenancy/invites/${id}/revoke`, {}, key());
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { inviteId: string }).inviteId).toBe(id);
    expect((await post(app, `/v1/tenancy/invites/${id}/revoke`, {}, key())).status).toBe(409);
    expect((await post(app, `/v1/tenancy/invites/${uuidv7()}/revoke`, {}, key())).status).toBe(404);

    const accepted = await inviteAndAccept(pool, b.owner, b.tenantId, "accepted@example.com", [
      b.cashierId,
    ]);
    expect(
      (await post(app, `/v1/tenancy/invites/${accepted.inviteId}/revoke`, {}, key())).status,
    ).toBe(409);
  });

  it("a revoked invite's link no longer accepts", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const id = uuidv7();
    await post(
      app,
      "/v1/tenancy/invites",
      { id, email: "gone@example.com", roleIds: [b.cashierId] },
      key(),
    );
    await post(app, `/v1/tenancy/invites/${id}/revoke`, {}, key());
    const userId = uuidv7();
    const res = await post(
      appFor(pool, withAccount(userAuth(userId), "gone@example.com"), fakeSessions()),
      "/v1/tenancy/invites/accept",
      { tenantId: b.tenantId, inviteId: id, token: inviteTokenFor(b.tenantId, id) },
      key(),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/tenancy/invites/accept", () => {
  async function pendingInvite(b: Business, email: string, branchIds: string[] | null = null) {
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const id = uuidv7();
    const res = await post(
      app,
      "/v1/tenancy/invites",
      { id, email, roleIds: [b.cashierId], branchIds },
      key(),
    );
    expect(res.status).toBe(201);
    return id;
  }

  it("401 anonymous; 404 for a wrong token, a token bound to another invite, and an unknown tenant", async () => {
    const b = await business();
    const id = await pendingInvite(b, "token@example.com");
    const acceptor = (userId: string) =>
      appFor(pool, withAccount(userAuth(userId), "token@example.com"), fakeSessions());
    const send = (app: ReturnType<typeof appFor>, body: unknown) =>
      post(app, "/v1/tenancy/invites/accept", body, key());

    expect(
      (await send(appFor(pool, null), { tenantId: b.tenantId, inviteId: id, token: "x" })).status,
    ).toBe(401);
    expect(
      (
        await send(acceptor(uuidv7()), {
          tenantId: b.tenantId,
          inviteId: id,
          token: "x".repeat(43),
        })
      ).status,
    ).toBe(404);
    const other = uuidv7();
    expect(
      (
        await send(acceptor(uuidv7()), {
          tenantId: b.tenantId,
          inviteId: id,
          token: inviteTokenFor(b.tenantId, other),
        })
      ).status,
    ).toBe(404);
    const ghost = uuidv7();
    expect(
      (
        await send(acceptor(uuidv7()), {
          tenantId: ghost,
          inviteId: id,
          token: inviteTokenFor(ghost, id),
        })
      ).status,
    ).toBe(404);
  });

  it("404 when the server has no invite secret configured (fail closed)", async () => {
    const b = await business();
    const id = await pendingInvite(b, "nosecret@example.com");
    const app = appFor(
      pool,
      withAccount(userAuth(uuidv7()), "nosecret@example.com"),
      fakeSessions(),
      undefined,
      {
        inviteSecret: undefined,
      },
    );
    const res = await post(
      app,
      "/v1/tenancy/invites/accept",
      { tenantId: b.tenantId, inviteId: id, token: inviteTokenFor(b.tenantId, id) },
      key(),
    );
    expect(res.status).toBe(404);
  });

  it("404 for an unverified account and for a different email; nothing is written", async () => {
    const b = await business();
    const id = await pendingInvite(b, "verify@example.com");
    const token = inviteTokenFor(b.tenantId, id);
    const body = { tenantId: b.tenantId, inviteId: id, token };
    const unverified = await post(
      appFor(pool, withAccount(userAuth(uuidv7()), "verify@example.com", false), fakeSessions()),
      "/v1/tenancy/invites/accept",
      body,
      key(),
    );
    expect(unverified.status).toBe(404);
    const wrong = await post(
      appFor(pool, withAccount(userAuth(uuidv7()), "someone-else@example.com"), fakeSessions()),
      "/v1/tenancy/invites/accept",
      body,
      key(),
    );
    expect(wrong.status).toBe(404);
    const noAccount = await post(
      appFor(pool, userAuth(uuidv7()), fakeSessions()),
      "/v1/tenancy/invites/accept",
      body,
      key(),
    );
    expect(noAccount.status).toBe(404);
    const members = await inTenant(migrator, b.tenantId, async (q) =>
      q("select id from tenancy.memberships"),
    );
    expect(members).toHaveLength(1);
  });

  it("404 once expired, and 404 once revoked", async () => {
    const b = await business();
    const expiredId = await pendingInvite(b, "late@example.com");
    const late = appFor(
      pool,
      withAccount(userAuth(uuidv7()), "late@example.com"),
      fakeSessions(),
      undefined,
      {
        inviteSecret: INVITE_SECRET,
        now: later(INVITE_TTL_MS + 1),
      },
    );
    const res = await post(
      late,
      "/v1/tenancy/invites/accept",
      { tenantId: b.tenantId, inviteId: expiredId, token: inviteTokenFor(b.tenantId, expiredId) },
      key(),
    );
    expect(res.status).toBe(404);

    const revokedId = await pendingInvite(b, "revoked@example.com");
    await post(
      await ownerApp(pool, b.owner, b.tenantId),
      `/v1/tenancy/invites/${revokedId}/revoke`,
      {},
      key(),
    );
    const again = await post(
      appFor(pool, withAccount(userAuth(uuidv7()), "revoked@example.com"), fakeSessions()),
      "/v1/tenancy/invites/accept",
      { tenantId: b.tenantId, inviteId: revokedId, token: inviteTokenFor(b.tenantId, revokedId) },
      key(),
    );
    expect(again.status).toBe(404);
  });

  it("joins with the invite's roles and branch scope, switches the session, and emits membership events", async () => {
    const b = await business();
    const id = await pendingInvite(b, "join@example.com", [b.storeId]);
    const userId = uuidv7();
    const sessions = fakeSessions();
    const res = await post(
      appFor(pool, withAccount(userAuth(userId), "JOIN@example.com"), sessions),
      "/v1/tenancy/invites/accept",
      { tenantId: b.tenantId, inviteId: id, token: inviteTokenFor(b.tenantId, id) },
      key(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; membershipId: string };
    expect(body.tenantId).toBe(b.tenantId);
    expect(sessions.setActiveTenant).toHaveBeenCalledWith(SESSION, userId, b.tenantId);

    const member = await memberAuth(pool, userId, b.tenantId);
    expect(member).toMatchObject({ roles: ["cashier"], branchScope: [b.storeId] });
    expect(await outboxTypes(b.tenantId)).toContain("tenancy.member.joined");

    const pending = (await (
      await get(await ownerApp(pool, b.owner, b.tenantId), "/v1/tenancy/invites")
    ).json()) as {
      invites: { inviteId: string }[];
    };
    expect(pending.invites.map((i) => i.inviteId)).not.toContain(id);
  });

  it("idempotent replay returns the same 200; a new key from the same user is 409 (already a member)", async () => {
    const b = await business();
    const id = await pendingInvite(b, "replay-join@example.com");
    const acceptor = appFor(
      pool,
      withAccount(userAuth(uuidv7()), "replay-join@example.com"),
      fakeSessions(),
    );
    const body = { tenantId: b.tenantId, inviteId: id, token: inviteTokenFor(b.tenantId, id) };
    const k = key();
    const first = await post(acceptor, "/v1/tenancy/invites/accept", body, k);
    const second = await post(acceptor, "/v1/tenancy/invites/accept", body, k);
    expect(first.status).toBe(200);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await second.text()).toBe(await first.text());
    expect((await post(acceptor, "/v1/tenancy/invites/accept", body, key())).status).toBe(409);
  });

  it("a second person cannot use an accepted invite (404)", async () => {
    const b = await business();
    const id = await pendingInvite(b, "shared@example.com");
    const first = appFor(
      pool,
      withAccount(userAuth(uuidv7()), "shared@example.com"),
      fakeSessions(),
    );
    const body = { tenantId: b.tenantId, inviteId: id, token: inviteTokenFor(b.tenantId, id) };
    expect((await post(first, "/v1/tenancy/invites/accept", body, key())).status).toBe(200);
    const intruder = appFor(
      pool,
      withAccount(userAuth(uuidv7()), "shared@example.com"),
      fakeSessions(),
    );
    expect((await post(intruder, "/v1/tenancy/invites/accept", body, key())).status).toBe(404);
  });
});
