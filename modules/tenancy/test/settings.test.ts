import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appFor,
  createBusiness,
  fakeSessions,
  get,
  inTenant,
  inviteAndAccept,
  memberAuth,
  ownerApp,
  patch,
  post,
  put,
  roleIdOf,
  setup,
  userAuth,
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
  )) as { id: string }[];
  return { owner, tenantId, storeId: branches[0]?.id ?? "" };
}

/** A manager (tenancy:read only by default) in the same tenant. */
async function managerApp(b: Awaited<ReturnType<typeof business>>) {
  const managerRole = await roleIdOf(migrator, b.tenantId, "manager");
  const m = await inviteAndAccept(pool, b.owner, b.tenantId, `m-${uuidv7()}@example.com`, [
    managerRole,
  ]);
  return appFor(pool, await memberAuth(pool, m.userId, b.tenantId), fakeSessions());
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = (await inTenant(migrator, tenantId, async (q) =>
    q("select action from audit.audit_log order by at, id"),
  )) as { action: string }[];
  return rows.map((r) => r.action);
}

async function outboxTypes(tenantId: string): Promise<string[]> {
  const rows = (await inTenant(migrator, tenantId, async (q) =>
    q("select type from infra.outbox order by id"),
  )) as { type: string }[];
  return rows.map((r) => r.type);
}

describe("business profile", () => {
  it("GET returns name and empty defaults after sign-up; PATCH normalises, audits and emits", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const before = await get(app, "/v1/tenancy/business");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      tenantId: b.tenantId,
      name: "Acme Traders",
      country: null,
      currency: null,
      timezone: null,
      taxRegion: null,
      onboardedAt: null,
    });

    const res = await patch(
      app,
      "/v1/tenancy/business",
      { country: "lk", currency: "lkr", timezone: "Asia/Colombo", taxRegion: " LK-1 " },
      key(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      country: "LK",
      currency: "LKR",
      timezone: "Asia/Colombo",
      taxRegion: "LK-1",
    });
    expect(await auditActions(b.tenantId)).toContain("tenancy.business.updated");
    expect(await outboxTypes(b.tenantId)).toContain("tenancy.business.updated");
  });

  it("422 for bad codes, an unknown zone or an empty patch", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    for (const body of [{ country: "LKA" }, { currency: "XXQ" }, { timezone: "Mars/Base" }, {}]) {
      expect((await patch(app, "/v1/tenancy/business", body, key())).status).toBe(422);
    }
  });

  it("a manager can read but not change it (404, not 403); another tenant cannot see it", async () => {
    const b = await business();
    const app = await managerApp(b);
    expect((await get(app, "/v1/tenancy/business")).status).toBe(200);
    expect((await patch(app, "/v1/tenancy/business", { name: "X" }, key())).status).toBe(404);

    const other = await business();
    const otherApp = await ownerApp(pool, other.owner, other.tenantId);
    const body = (await (await get(otherApp, "/v1/tenancy/business")).json()) as {
      tenantId: string;
    };
    expect(body.tenantId).toBe(other.tenantId);
  });

  it("an idempotent replay returns the stored response and writes one audit row", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const k = key();
    const first = await patch(app, "/v1/tenancy/business", { name: "Lanka Hardware" }, k);
    const again = await patch(app, "/v1/tenancy/business", { name: "Lanka Hardware" }, k);
    expect(again.status).toBe(first.status);
    expect(await again.text()).toBe(await first.text());
    const updates = (await auditActions(b.tenantId)).filter(
      (a) => a === "tenancy.business.updated",
    );
    expect(updates).toHaveLength(1);
  });
});

describe("onboarding", () => {
  it("draft round-trips; complete refuses an incomplete profile, then succeeds once and is idempotent", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    expect(await (await get(app, "/v1/tenancy/onboarding")).json()).toEqual({
      onboardedAt: null,
      draft: null,
    });

    const draft = { step: 2, values: { country: "LK", invites: ["a@example.com"] } };
    expect((await put(app, "/v1/tenancy/onboarding", draft, key())).status).toBe(200);
    expect(await (await get(app, "/v1/tenancy/onboarding")).json()).toEqual({
      onboardedAt: null,
      draft,
    });

    expect((await post(app, "/v1/tenancy/onboarding/complete", {}, key())).status).toBe(422);
    await patch(
      app,
      "/v1/tenancy/business",
      { country: "LK", currency: "LKR", timezone: "Asia/Colombo", taxRegion: "LK" },
      key(),
    );
    const done = await post(app, "/v1/tenancy/onboarding/complete", {}, key());
    expect(done.status).toBe(200);
    const { onboardedAt } = (await done.json()) as { onboardedAt: string };
    const again = await post(app, "/v1/tenancy/onboarding/complete", {}, key());
    expect(await again.json()).toEqual({ onboardedAt });
    expect(
      (await outboxTypes(b.tenantId)).filter((t) => t === "tenancy.business.onboarded"),
    ).toHaveLength(1);

    const mine = await get(appFor(pool, userAuth(b.owner)), "/v1/tenancy/me/tenants");
    const tenants = (
      (await mine.json()) as { tenants: { tenantId: string; onboardedAt: string | null }[] }
    ).tenants;
    expect(tenants.find((t) => t.tenantId === b.tenantId)?.onboardedAt).toBe(onboardedAt);
  });

  it("is owner-only: a manager gets 404 on read, draft and complete", async () => {
    const b = await business();
    const app = await managerApp(b);
    expect((await get(app, "/v1/tenancy/onboarding")).status).toBe(404);
    expect((await put(app, "/v1/tenancy/onboarding", { step: 0, values: {} }, key())).status).toBe(
      404,
    );
    expect((await post(app, "/v1/tenancy/onboarding/complete", {}, key())).status).toBe(404);
  });

  it("422 for an oversized draft", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const big = { step: 1, values: { notes: "x".repeat(20_000) } };
    expect((await put(app, "/v1/tenancy/onboarding", big, key())).status).toBe(422);
  });
});

describe("branches and locations", () => {
  it("creates a branch (201), lists it, edits and archives it; never deletes", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const id = uuidv7();
    const created = await post(
      app,
      "/v1/tenancy/branches",
      {
        id,
        name: " Kandy ",
        kind: "store",
        timezone: "Asia/Colombo",
        currency: "lkr",
        taxRegion: "LK",
      },
      key(),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      branchId: id,
      name: "Kandy",
      currency: "LKR",
      archived: false,
    });
    expect(
      (
        await post(
          app,
          "/v1/tenancy/branches",
          {
            id,
            name: "Dup",
            kind: "store",
            timezone: "Asia/Colombo",
            currency: "LKR",
            taxRegion: "LK",
          },
          key(),
        )
      ).status,
    ).toBe(409);

    const renamed = await patch(
      app,
      `/v1/tenancy/branches/${id}`,
      { name: "Kandy Road", businessDayCutoff: "04:00" },
      key(),
    );
    expect(await renamed.json()).toMatchObject({ name: "Kandy Road", businessDayCutoff: "04:00" });
    const archived = await patch(app, `/v1/tenancy/branches/${id}`, { archived: true }, key());
    expect(await archived.json()).toMatchObject({ archived: true });

    const list = (await (await get(app, "/v1/tenancy/branches")).json()) as {
      branches: { branchId: string }[];
    };
    expect(list.branches.map((x) => x.branchId)).toContain(id);
    expect(
      (await patch(app, `/v1/tenancy/branches/${uuidv7()}`, { name: "x" }, key())).status,
    ).toBe(404);
    expect((await patch(app, `/v1/tenancy/branches/${id}`, {}, key())).status).toBe(422);
  });

  it("locations: list, create, edit, archive; archived branch refuses new locations (409)", async () => {
    const b = await business();
    const app = await ownerApp(pool, b.owner, b.tenantId);
    const listed = (await (
      await get(app, `/v1/tenancy/branches/${b.storeId}/locations`)
    ).json()) as {
      locations: { name: string; kind: string }[];
    };
    expect(listed.locations).toEqual([
      expect.objectContaining({ name: "Main", kind: "sales_floor" }),
    ]);

    const locId = uuidv7();
    const created = await post(
      app,
      `/v1/tenancy/branches/${b.storeId}/locations`,
      { id: locId, name: "Back room", kind: "backroom" },
      key(),
    );
    expect(created.status).toBe(201);
    const edited = await patch(
      app,
      `/v1/tenancy/locations/${locId}`,
      { kind: "warehouse", archived: true },
      key(),
    );
    expect(await edited.json()).toMatchObject({ kind: "warehouse", archived: true });
    expect(
      (await patch(app, `/v1/tenancy/locations/${uuidv7()}`, { name: "x" }, key())).status,
    ).toBe(404);

    await patch(app, `/v1/tenancy/branches/${b.storeId}`, { archived: true }, key());
    const refused = await post(
      app,
      `/v1/tenancy/branches/${b.storeId}/locations`,
      { id: uuidv7(), name: "Late" },
      key(),
    );
    expect(refused.status).toBe(409);
    expect((await get(app, `/v1/tenancy/branches/${uuidv7()}/locations`)).status).toBe(404);
  });

  it("a manager cannot create or edit (404); another tenant's branch is invisible (404)", async () => {
    const b = await business();
    const app = await managerApp(b);
    expect(
      (
        await post(
          app,
          "/v1/tenancy/branches",
          {
            id: uuidv7(),
            name: "X",
            kind: "store",
            timezone: "Asia/Colombo",
            currency: "LKR",
            taxRegion: "LK",
          },
          key(),
        )
      ).status,
    ).toBe(404);
    expect(
      (await patch(app, `/v1/tenancy/branches/${b.storeId}`, { name: "X" }, key())).status,
    ).toBe(404);

    const other = await business();
    const otherApp = await ownerApp(pool, other.owner, other.tenantId);
    expect((await get(otherApp, `/v1/tenancy/branches/${b.storeId}/locations`)).status).toBe(404);
    expect(
      (await patch(otherApp, `/v1/tenancy/branches/${b.storeId}`, { name: "X" }, key())).status,
    ).toBe(404);
  });
});
