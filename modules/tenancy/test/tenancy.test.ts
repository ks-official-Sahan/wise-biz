import { countQueries, withTenantTx, withUserTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzleTenancyRepository } from "../src/adapters/db/tenancy-repository.ts";
import { createTenancyPorts } from "../src/index.ts";

import {
  SESSION,
  appFor,
  counts,
  fakeSessions,
  post,
  setup,
  userAuth,
  validBody,
} from "./helpers.ts";

import type { TenancyRepository } from "../src/ports/tenancy-repository.ts";
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

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key = (): string => `k-${uuidv7()}`;

/** Create a business through the real HTTP use case and return its ids. */
async function signUp(userId: string, name = "Acme") {
  const tenantId = uuidv7();
  const sessions = fakeSessions();
  const res = await post(
    appFor(pool, userAuth(userId), sessions),
    "/v1/tenancy/tenants",
    validBody(tenantId, { name }),
    key(),
  );
  expect(res.status).toBe(201);
  return { tenantId, body: (await res.json()) as Record<string, string>, sessions };
}

describe("POST /v1/tenancy/tenants (signUpBusiness)", () => {
  it("creates every row, audit and outbox in one transaction and activates the tenant", async () => {
    const user = uuidv7();
    const { tenantId, body, sessions } = await signUp(user);
    expect(body).toMatchObject({ tenantId, name: "Acme" });
    for (const id of [body.tenantId, body.branchId, body.locationId]) expect(id).toMatch(UUID7);
    expect(sessions.setActiveTenant).toHaveBeenCalledWith(SESSION, user, tenantId);

    const c = await counts(migrator, tenantId);
    expect(c).toMatchObject({
      "tenancy.tenants": 1,
      "tenancy.roles": 6,
      "tenancy.role_permissions": 12,
      "tenancy.branches": 1,
      "tenancy.locations": 1,
      "tenancy.memberships": 1,
      "tenancy.membership_roles": 1,
      "audit.audit_log": 1,
      "infra.outbox": 1,
      "infra.idempotency_keys": 1,
    });

    await withTenantTx(migrator, { tenantId, userId: user, requestId: "t" }, async (tx) => {
      const roles = await tx.query<{ name: string; is_system: boolean; id: string }>(
        "select name, is_system, id from tenancy.roles",
      );
      expect(roles.rows.every((r) => r.is_system && UUID7.test(r.id))).toBe(true);
      const loc = await tx.query<{ name: string }>("select name from tenancy.locations");
      expect(loc.rows[0]?.name).toBe("Main");
      const b = await tx.query<{ currency: string; timezone: string }>(
        "select currency, timezone from tenancy.branches",
      );
      expect(b.rows[0]).toEqual({ currency: "LKR", timezone: "Asia/Colombo" });
      const audit = await tx.query<{ action: string; actor_id: string }>(
        "select action, actor_id from audit.audit_log",
      );
      expect(audit.rows[0]).toEqual({ action: "tenancy.tenant.created", actor_id: user });
      const out = await tx.query<{ type: string; topic: string; version: number }>(
        "select type, topic, version from infra.outbox",
      );
      expect(out.rows[0]).toEqual({
        type: "tenancy.tenant.created",
        topic: "tenancy.tenant",
        version: 1,
      });
      const tenant = await tx.query<{ permissions_version: number }>(
        "select permissions_version from tenancy.tenants",
      );
      expect(tenant.rows[0]?.permissions_version).toBeGreaterThan(1); // grants + owner role bumped it
    });
  });

  it("rolls everything back when the transaction fails after the inserts", async () => {
    const failing: TenancyRepository = {
      ...drizzleTenancyRepository,
      insertBusiness: async (tx, rows) => {
        await drizzleTenancyRepository.insertBusiness(tx, rows);
        throw new Error("boom after inserts");
      },
    };
    const tenantId = uuidv7();
    const sessions = fakeSessions();
    const app = appFor(pool, userAuth(uuidv7()), sessions, failing);
    const res = await post(app, "/v1/tenancy/tenants", validBody(tenantId), key());
    expect(res.status).toBe(500);
    const c = await counts(migrator, tenantId);
    expect(Object.values(c).every((n) => n === 0)).toBe(true);
    expect(sessions.setActiveTenant).not.toHaveBeenCalled();
  });

  it("409 CONFLICT on a duplicate tenantId, even for another user; the first tenant is untouched", async () => {
    const owner = uuidv7();
    const { tenantId } = await signUp(owner);
    const before = await counts(migrator, tenantId);

    const sessions = fakeSessions();
    for (const user of [owner, uuidv7()]) {
      const res = await post(
        appFor(pool, userAuth(user), sessions),
        "/v1/tenancy/tenants",
        validBody(tenantId, { name: "Hijack" }),
        key(),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("CONFLICT");
    }
    expect(await counts(migrator, tenantId)).toEqual(before);
    expect(sessions.setActiveTenant).not.toHaveBeenCalled();
    await withTenantTx(pool, { tenantId, requestId: "t" }, async (tx) => {
      const t = await tx.query<{ name: string }>("select name from tenancy.tenants");
      expect(t.rows[0]?.name).toBe("Acme");
    });
  });

  it("idempotent replay: same key and body returns the stored response and creates nothing twice", async () => {
    const user = uuidv7();
    const tenantId = uuidv7();
    const sessions = fakeSessions();
    const app = appFor(pool, userAuth(user), sessions);
    const k = key();
    const a = await post(app, "/v1/tenancy/tenants", validBody(tenantId), k);
    const b = await post(app, "/v1/tenancy/tenants", validBody(tenantId), k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(await b.text()).toBe(await a.text());
    expect((await counts(migrator, tenantId))["tenancy.tenants"]).toBe(1);
    expect((await counts(migrator, tenantId))["audit.audit_log"]).toBe(1);
    // the replay re-points the session too (heals a crash between commit and activation)
    expect(sessions.setActiveTenant).toHaveBeenCalledTimes(2);
  });

  it("same key with a different body is 422 IDEMPOTENCY_MISMATCH", async () => {
    const tenantId = uuidv7();
    const app = appFor(pool, userAuth(uuidv7()));
    const k = key();
    expect((await post(app, "/v1/tenancy/tenants", validBody(tenantId), k)).status).toBe(201);
    const res = await post(app, "/v1/tenancy/tenants", validBody(tenantId, { name: "Other" }), k);
    expect(res.status).toBe(422);
  });

  it("anonymous is 401; a missing Idempotency-Key and invalid input are 422", async () => {
    const tenantId = uuidv7();
    expect(
      (await post(appFor(pool, null), "/v1/tenancy/tenants", validBody(tenantId), key())).status,
    ).toBe(401);
    const app = appFor(pool, userAuth(uuidv7()));
    expect((await post(app, "/v1/tenancy/tenants", validBody(tenantId))).status).toBe(422);
    const bad = [
      validBody("not-a-uuid"),
      validBody(tenantId, { name: "" }),
      validBody(tenantId, { branch: { ...validBody(tenantId).branch, timezone: "Mars/Base" } }),
      validBody(tenantId, { branch: { ...validBody(tenantId).branch, currency: "ZZZ" } }),
      validBody(tenantId, { branch: { ...validBody(tenantId).branch, kind: "mall" } }),
    ];
    for (const b of bad) {
      expect((await post(app, "/v1/tenancy/tenants", b, key())).status).toBe(422);
    }
    expect((await counts(migrator, tenantId))["tenancy.tenants"]).toBe(0);
  });
});

describe("GET /v1/tenancy/me/tenants", () => {
  it("lists only the caller's active tenants, in one query", async () => {
    const alice = uuidv7();
    const bob = uuidv7();
    const a1 = await signUp(alice, "Alice One");
    const a2 = await signUp(alice, "Alice Two");
    const b1 = await signUp(bob, "Bob One");

    const app = appFor(pool, userAuth(alice));
    const { result: res, count } = await countQueries(() =>
      Promise.resolve(app.request("/v1/tenancy/me/tenants")),
    );
    expect(res.status).toBe(200);
    expect(count).toBe(1);
    const body = (await res.json()) as { tenants: { tenantId: string; name: string }[] };
    expect(body.tenants.map((t) => t.tenantId).sort()).toEqual([a1.tenantId, a2.tenantId].sort());
    expect(body.tenants.map((t) => t.tenantId)).not.toContain(b1.tenantId);

    const bobs = (await (
      await appFor(pool, userAuth(bob)).request("/v1/tenancy/me/tenants")
    ).json()) as {
      tenants: { name: string }[];
    };
    expect(bobs.tenants).toHaveLength(1);
    expect(bobs.tenants[0]?.name).toBe("Bob One");
  });

  it("a suspended membership or tenant disappears; a stranger sees nothing; anonymous is 401", async () => {
    const user = uuidv7();
    const a = await signUp(user, "Gone");
    const b = await signUp(user, "Kept");
    await withTenantTx(pool, { tenantId: a.tenantId, requestId: "t" }, (tx) =>
      tx.query("update tenancy.memberships set status = 'suspended'"),
    );
    // wb_app may only rename a tenant; suspension is an operator (migrator) action
    await withTenantTx(migrator, { tenantId: b.tenantId, requestId: "t" }, (tx) =>
      tx.query("update tenancy.tenants set status = $1", ["suspended"]),
    );
    const mine = (await (
      await appFor(pool, userAuth(user)).request("/v1/tenancy/me/tenants")
    ).json()) as {
      tenants: unknown[];
    };
    expect(mine.tenants).toEqual([]);
    const stranger = (await (
      await appFor(pool, userAuth(uuidv7())).request("/v1/tenancy/me/tenants")
    ).json()) as {
      tenants: unknown[];
    };
    expect(stranger.tenants).toEqual([]);
    expect((await appFor(pool, null).request("/v1/tenancy/me/tenants")).status).toBe(401);
  });
});

describe("POST /v1/tenancy/switch", () => {
  it("members switch (204); the session store is updated", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    const sessions = fakeSessions();
    const res = await post(appFor(pool, userAuth(user), sessions), "/v1/tenancy/switch", {
      tenantId: t.tenantId,
    });
    expect(res.status).toBe(204);
    expect(sessions.setActiveTenant).toHaveBeenCalledWith(SESSION, user, t.tenantId);
  });

  it("non-members get 404, as does an unknown tenant; nothing is written", async () => {
    const owner = await signUp(uuidv7());
    const sessions = fakeSessions();
    const app = appFor(pool, userAuth(uuidv7()), sessions);
    expect((await post(app, "/v1/tenancy/switch", { tenantId: owner.tenantId })).status).toBe(404);
    expect((await post(app, "/v1/tenancy/switch", { tenantId: uuidv7() })).status).toBe(404);
    expect((await post(app, "/v1/tenancy/switch", { tenantId: "nope" })).status).toBe(422);
    expect(sessions.setActiveTenant).not.toHaveBeenCalled();
  });

  it("a suspended membership cannot switch; anonymous is 401", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    await withTenantTx(pool, { tenantId: t.tenantId, requestId: "t" }, (tx) =>
      tx.query("update tenancy.memberships set status = 'suspended'"),
    );
    const sessions = fakeSessions();
    const res = await post(appFor(pool, userAuth(user), sessions), "/v1/tenancy/switch", {
      tenantId: t.tenantId,
    });
    expect(res.status).toBe(404);
    expect(sessions.setActiveTenant).not.toHaveBeenCalled();
    expect(
      (await post(appFor(pool, null), "/v1/tenancy/switch", { tenantId: t.tenantId })).status,
    ).toBe(401);
  });
});

describe("kernel ports", () => {
  const ports = () => createTenancyPorts(pool);

  it("loadMembership: owner role, all branches, current version, in ONE query", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    const { result: m, count } = await countQueries(() =>
      ports().loadMembership(user, t.tenantId, "r"),
    );
    expect(count).toBe(1);
    expect(m).toMatchObject({ roles: ["owner"], branchScope: "all" });
    expect(m?.permissionsVersion).toBeGreaterThan(1);
  });

  it("loadMembership is null for a stranger, a suspended member and a suspended tenant", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    expect(await ports().loadMembership(uuidv7(), t.tenantId, "r")).toBeNull();
    await withTenantTx(migrator, { tenantId: t.tenantId, requestId: "t" }, (tx) =>
      tx.query("update tenancy.tenants set status = $1", ["suspended"]),
    );
    expect(await ports().loadMembership(user, t.tenantId, "r")).toBeNull();
    await withTenantTx(migrator, { tenantId: t.tenantId, requestId: "t" }, async (tx) => {
      await tx.query("update tenancy.tenants set status = $1", ["active"]);
      await tx.query("update tenancy.memberships set status = $1", ["suspended"]);
    });
    expect(await ports().loadMembership(user, t.tenantId, "r")).toBeNull();
  });

  it("loadMembership never crosses tenants: the user's membership elsewhere is invisible", async () => {
    const user = uuidv7();
    const mine = await signUp(user);
    const other = await signUp(uuidv7());
    expect(await ports().loadMembership(user, other.tenantId, "r")).toBeNull();
    expect(await ports().loadMembership(user, mine.tenantId, "r")).not.toBeNull();
  });

  it("branch scope and extra roles come back; a grant removal bumps the version", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    const branch = uuidv7();
    const v1 = (await ports().loadMembership(user, t.tenantId, "r"))?.permissionsVersion ?? 0;
    await withTenantTx(pool, { tenantId: t.tenantId, requestId: "t" }, async (tx) => {
      await tx.query("update tenancy.memberships set branch_ids = $1::uuid[]", [[branch]]);
      await tx.query(
        `insert into tenancy.membership_roles (tenant_id, membership_id, role_id)
         select m.tenant_id, m.id, r.id from tenancy.memberships m, tenancy.roles r where r.name = 'manager'`,
      );
    });
    const m = await ports().loadMembership(user, t.tenantId, "r");
    expect(m?.branchScope).toEqual([branch]);
    expect(m?.roles).toEqual(["manager", "owner"]);
    const v2 = m?.permissionsVersion ?? 0;
    expect(v2).toBe(v1); // membership/branch/role-assignment changes are read fresh per request; only grants bump
    await withTenantTx(pool, { tenantId: t.tenantId, requestId: "t" }, (tx) =>
      tx.query("delete from tenancy.role_permissions"),
    );
    expect(
      (await ports().loadMembership(user, t.tenantId, "r"))?.permissionsVersion,
    ).toBeGreaterThan(v2);
  });

  it("loadPolicyRows: this tenant's grants only, in one query", async () => {
    const t = await signUp(uuidv7());
    await signUp(uuidv7());
    const { result: rows, count } = await countQueries(() =>
      ports().loadPolicyRows(t.tenantId, "r"),
    );
    expect(count).toBe(1);
    expect(rows.map((r) => `${r.role}:${r.permission}`).sort()).toEqual([
      "accountant:tenancy:read",
      "cashier:devices:pin",
      "inventory_clerk:devices:pin",
      "manager:devices:manage",
      "manager:devices:pin",
      "manager:devices:read",
      "manager:devices:unlock",
      "manager:tenancy:read",
      "supervisor:devices:pin",
      "supervisor:devices:read",
      "supervisor:devices:unlock",
      "supervisor:tenancy:read",
    ]);
  });
});

describe("withUserTx scope", () => {
  it("shows only the user's own membership rows and no other tenant data", async () => {
    const user = uuidv7();
    await signUp(user);
    await signUp(uuidv7());
    await withUserTx(pool, { userId: user, requestId: "t" }, async (tx) => {
      const m = await tx.query<{ user_id: string }>("select user_id from tenancy.memberships");
      expect(m.rows.map((r) => r.user_id)).toEqual([user]);
      expect((await tx.query("select 1 from tenancy.roles")).rowCount).toBe(0);
      expect((await tx.query("select 1 from tenancy.branches")).rowCount).toBe(0);
    });
  });
});

describe("review hardening", () => {
  it("switch writes a tenancy.session.switched audit row in the TARGET tenant, actor = user", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    const res = await post(appFor(pool, userAuth(user)), "/v1/tenancy/switch", {
      tenantId: t.tenantId,
    });
    expect(res.status).toBe(204);
    await withTenantTx(migrator, { tenantId: t.tenantId, requestId: "t" }, async (tx) => {
      const r = await tx.query<{ actor_id: string; entity: string; entity_id: string }>(
        "select actor_id, entity, entity_id from audit.audit_log where action = 'tenancy.session.switched'",
      );
      expect(r.rows).toEqual([{ actor_id: user, entity: "tenancy.session", entity_id: SESSION }]);
    });
  });

  it("a non-member switch writes no audit row anywhere", async () => {
    const owner = await signUp(uuidv7());
    await post(appFor(pool, userAuth(uuidv7())), "/v1/tenancy/switch", {
      tenantId: owner.tenantId,
    });
    await withTenantTx(migrator, { tenantId: owner.tenantId, requestId: "t" }, async (tx) => {
      const r = await tx.query(
        "select 1 from audit.audit_log where action = 'tenancy.session.switched'",
      );
      expect(r.rowCount).toBe(0);
    });
  });

  it("per-user cap: the 21st business is 409, a replay of the 20th still succeeds", async () => {
    const user = uuidv7();
    const app = appFor(pool, userAuth(user));
    let lastBody: unknown;
    let lastKey = "";
    for (let i = 0; i < 20; i++) {
      lastKey = key();
      lastBody = validBody(uuidv7(), { name: `T${String(i)}` });
      expect((await post(app, "/v1/tenancy/tenants", lastBody, lastKey)).status).toBe(201);
    }
    const over = await post(app, "/v1/tenancy/tenants", validBody(uuidv7()), key());
    expect(over.status).toBe(409);
    expect(((await over.json()) as { code: string }).code).toBe("CONFLICT");
    const replay = await post(app, "/v1/tenancy/tenants", lastBody, lastKey);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
  });

  it("setActiveTenant failing after commit: 500, then the same key replays 201 and the session points at the tenant", async () => {
    const user = uuidv7();
    const tenantId = uuidv7();
    const sessions = fakeSessions();
    sessions.setActiveTenant.mockRejectedValueOnce(new Error("identity db down"));
    const app = appFor(pool, userAuth(user), sessions);
    const k = key();
    const first = await post(app, "/v1/tenancy/tenants", validBody(tenantId), k);
    expect(first.status).toBe(500);
    expect((await counts(migrator, tenantId))["tenancy.tenants"]).toBe(1); // committed
    const second = await post(app, "/v1/tenancy/tenants", validBody(tenantId), k);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(sessions.setActiveTenant).toHaveBeenLastCalledWith(SESSION, user, tenantId);
    expect(sessions.setActiveTenant).toHaveBeenCalledTimes(2);
  });

  it("loadMembership / loadPolicyRows take the request id from the caller", async () => {
    const user = uuidv7();
    const t = await signUp(user);
    const seen: string[] = [];
    const spyRepo: TenancyRepository = {
      ...drizzleTenancyRepository,
      loadMembership: async (tx, u, tid) => {
        const r = await tx.query<{ rid: string }>(
          "select current_setting('app.request_id') as rid",
        );
        seen.push(r.rows[0]?.rid ?? "");
        return drizzleTenancyRepository.loadMembership(tx, u, tid);
      },
    };
    await createTenancyPorts(pool, spyRepo).loadMembership(user, t.tenantId, "req-abc-123");
    expect(seen).toEqual(["req-abc-123"]);
  });
});
