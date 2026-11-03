import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNotificationsConsumer } from "../src/consumer.ts";
import { notificationsModule } from "../src/index.ts";
import { notify } from "../src/notify.ts";

import type { AppEnv, IdempotencyCache, ModuleDeps } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const base = join(import.meta.dirname, "..", "..");

let db: TestDatabase;
let app: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(base, "infra", "migrations") },
    { module: "notifications", dir: join(base, "notifications", "migrations") },
  ]);
  app = createPool(db.url("app"), { max: 10 });
  worker = createPool(db.url("worker"), { max: 10 });
  admin = createPool(db.url("migrator"));
});
afterAll(async () => {
  await app.end();
  await worker.end();
  await admin.end();
  await db.drop();
});

const ctx = (tenantId: string, userId: string) => ({ tenantId, userId, requestId: "test" });

/** Run the fan-out as the worker (the consumer's role) inside the business, in one transaction. */
const deliver = (
  tenantId: string,
  people: string[],
  type: string,
  payload: unknown,
  id = uuidv7(),
) => {
  const consumer = createNotificationsConsumer({ holders: () => Promise.resolve(people) });
  return withTenantTx(worker, ctx(tenantId, people[0] ?? uuidv7()), (tx) =>
    consumer.handle({ id, tenantId, type, payload: { data: payload } }, { client: tx as never }),
  );
};

const LOW = { locationId: "l", variantId: "v", qty: "2.0000", minQty: "5.0000", maxQty: null };

const matrix = matrixFromRows(createCatalog(notificationsModule.permissions), []);
const idempotencyCache: IdempotencyCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};
function appFor(tenantId: string, userId: string) {
  const deps: ModuleDeps = {
    pool: app,
    clock: { now: () => Date.now() },
    ids: { uuidv7 },
    idempotencyCache,
  };
  const a = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  a.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId,
      roles: ["clerk"],
      branchScope: "all",
      permissionsVersion: 1,
    });
    await next();
  });
  a.use("*", policyMiddleware(matrix));
  notificationsModule.routes(a, deps);
  a.onError((err, c) => {
    const p = toProblem(err, "req-12345678");
    return c.json(p, p.status as 404);
  });
  return a;
}
const put = (path: string, body: unknown, method = "PUT") => ({
  path,
  init: {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  },
});

interface Listed {
  notifications: {
    id: string;
    kind: string;
    title: string;
    link: string | null;
    readAt: string | null;
  }[];
  next: string | null;
}

describe("fan-out", () => {
  it("tells every person who can act, once, and links inside the app", async () => {
    const t = uuidv7();
    const [a, b] = [uuidv7(), uuidv7()];
    await deliver(t, [a, b], "inventory.balance.low", LOW);
    for (const u of [a, b]) {
      const body = (await (await appFor(t, u).request("/v1/notifications")).json()) as Listed;
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]).toMatchObject({
        kind: "low_stock",
        link: "/stock",
        readAt: null,
      });
    }
  });

  it("does not tell twice when the event is delivered again", async () => {
    const t = uuidv7();
    const u = uuidv7();
    const id = uuidv7();
    await deliver(t, [u], "inventory.balance.low", LOW, id);
    await deliver(t, [u], "inventory.balance.low", LOW, id);
    const body = (await (await appFor(t, u).request("/v1/notifications")).json()) as Listed;
    expect(body.notifications).toHaveLength(1);
  });

  it("covers expiring batches and ignores events it does not know", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await deliver(t, [u], "inventory.batch.expiring", {
      batchId: "b",
      variantId: "v",
      lotCode: "L-7",
      expiresOn: "2026-11-20",
      stock: [],
    });
    await deliver(t, [u], "sales.sale.completed", {});
    const body = (await (await appFor(t, u).request("/v1/notifications")).json()) as Listed;
    expect(body.notifications.map((n) => n.kind)).toEqual(["expiring"]);
  });

  it("skips a person who turned the kind off", async () => {
    const t = uuidv7();
    const [quiet, loud] = [uuidv7(), uuidv7()];
    const res = await appFor(t, quiet).request(
      ...argsOf(
        put("/v1/notifications/preferences", {
          preferences: [{ kind: "low_stock", inApp: false, email: false }],
        }),
      ),
    );
    expect(res.status).toBe(200);
    await deliver(t, [quiet, loud], "inventory.balance.low", LOW);
    const q = (await (await appFor(t, quiet).request("/v1/notifications")).json()) as Listed;
    const l = (await (await appFor(t, loud).request("/v1/notifications")).json()) as Listed;
    expect(q.notifications).toHaveLength(0);
    expect(l.notifications).toHaveLength(1);
  });

  it("tells about a silent terminal, scoped to its branch, and links to the terminals page", async () => {
    const t = uuidv7();
    const u = uuidv7();
    const branchId = uuidv7();
    const seen: unknown[] = [];
    const consumer = createNotificationsConsumer({
      holders: (_c, _t, permission, scope) => {
        seen.push([permission, scope]);
        return Promise.resolve([u]);
      },
    });
    await withTenantTx(worker, ctx(t, u), (tx) =>
      consumer.handle(
        {
          id: uuidv7(),
          tenantId: t,
          type: "devices.heartbeat.missed",
          payload: { data: { branchId, name: "Till 2", silentMinutes: 12 } },
        },
        { client: tx as never },
      ),
    );
    expect(seen).toEqual([["devices:read", { branchIds: [branchId] }]]);
    const body = (await (await appFor(t, u).request("/v1/notifications")).json()) as Listed;
    expect(body.notifications[0]).toMatchObject({
      kind: "device_offline",
      title: "Till 2 went offline",
      link: "/devices",
    });
  });

  it("tells only the requester when an export is ready", async () => {
    const t = uuidv7();
    const [asker, other] = [uuidv7(), uuidv7()];
    await deliver(t, [other], "reporting.export.ready", {
      exportId: uuidv7(),
      requestedBy: asker,
      kind: "sales_lines",
      rowCount: 1200,
    });
    const mine = (await (await appFor(t, asker).request("/v1/notifications")).json()) as Listed;
    const theirs = (await (await appFor(t, other).request("/v1/notifications")).json()) as Listed;
    expect(mine.notifications[0]).toMatchObject({ kind: "export_ready", link: "/reports" });
    expect(theirs.notifications).toHaveLength(0);
  });

  it("rejects a malformed payload so the bus retries or dead-letters it", async () => {
    await expect(
      deliver(uuidv7(), [uuidv7()], "inventory.balance.low", { qty: 1 }),
    ).rejects.toThrow();
  });

  it("tells nobody when nobody holds the permission", async () => {
    const t = uuidv7();
    const told = await withTenantTx(worker, ctx(t, uuidv7()), (tx) =>
      notify(tx, t, [], { kind: "low_stock", title: "x", body: "y", dedupeKey: "k" }),
    );
    expect(told).toBe(0);
  });

  it("notify drops a link that leaves the app", async () => {
    const t = uuidv7();
    await expect(
      withTenantTx(worker, ctx(t, uuidv7()), (tx) =>
        notify(tx, t, [uuidv7()], {
          kind: "low_stock",
          title: "x",
          body: "y",
          link: "https://evil.example",
          dedupeKey: uuidv7(),
        }),
      ),
    ).rejects.toThrow();
  });
});

const argsOf = (p: { path: string; init: RequestInit }): [string, RequestInit] => [p.path, p.init];

describe("my notifications", () => {
  it("marks some read, then all, and counts unread", async () => {
    const t = uuidv7();
    const u = uuidv7();
    for (let i = 0; i < 3; i++) await deliver(t, [u], "inventory.balance.low", LOW);
    const a = appFor(t, u);
    const count = async () =>
      ((await (await a.request("/v1/notifications/unread-count")).json()) as { unread: number })
        .unread;
    expect(await count()).toBe(3);
    const listed = (await (await a.request("/v1/notifications")).json()) as Listed;
    const one = listed.notifications[0]?.id ?? "";
    let res = await a.request(...argsOf(put("/v1/notifications/read", { ids: [one] }, "POST")));
    expect(await res.json()).toEqual({ marked: 1 });
    expect(await count()).toBe(2);
    // Marking the same one again changes nothing.
    res = await a.request(...argsOf(put("/v1/notifications/read", { ids: [one] }, "POST")));
    expect(await res.json()).toEqual({ marked: 0 });
    res = await a.request(...argsOf(put("/v1/notifications/read", { all: true }, "POST")));
    expect(await res.json()).toEqual({ marked: 2 });
    expect(await count()).toBe(0);
    const unread = (await (await a.request("/v1/notifications?unread=true")).json()) as Listed;
    expect(unread.notifications).toHaveLength(0);
  });

  it("rejects ids together with all", async () => {
    const res = await appFor(uuidv7(), uuidv7()).request(
      ...argsOf(put("/v1/notifications/read", { ids: [uuidv7()], all: true }, "POST")),
    );
    expect(res.status).toBe(422);
  });

  it("pages newest first with a cursor", async () => {
    const t = uuidv7();
    const u = uuidv7();
    for (let i = 0; i < 5; i++) await deliver(t, [u], "inventory.balance.low", LOW);
    const a = appFor(t, u);
    const p1 = (await (await a.request("/v1/notifications?limit=2")).json()) as Listed;
    expect(p1.notifications).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = (await (
      await a.request(`/v1/notifications?limit=2&after=${p1.next ?? ""}`)
    ).json()) as Listed;
    const p3 = (await (
      await a.request(`/v1/notifications?limit=2&after=${p2.next ?? ""}`)
    ).json()) as Listed;
    const ids = [...p1.notifications, ...p2.notifications, ...p3.notifications].map((n) => n.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort().reverse()).toEqual(ids);
    expect(p3.next).toBeNull();
  });

  it("never shows or changes another person's or another business's notifications", async () => {
    const [t1, t2] = [uuidv7(), uuidv7()];
    const [u1, u2] = [uuidv7(), uuidv7()];
    await deliver(t1, [u1], "inventory.balance.low", LOW);
    const other = (await (await appFor(t1, u2).request("/v1/notifications")).json()) as Listed;
    expect(other.notifications).toHaveLength(0);
    const elsewhere = (await (await appFor(t2, u1).request("/v1/notifications")).json()) as Listed;
    expect(elsewhere.notifications).toHaveLength(0);
    const mine = (await (await appFor(t1, u1).request("/v1/notifications")).json()) as Listed;
    const res = await appFor(t1, u2).request(
      ...argsOf(put("/v1/notifications/read", { ids: [mine.notifications[0]?.id ?? ""] }, "POST")),
    );
    expect(await res.json()).toEqual({ marked: 0 });
    const still = (await (await appFor(t1, u1).request("/v1/notifications")).json()) as Listed;
    expect(still.notifications[0]?.readAt).toBeNull();
  });

  it("anonymous callers cannot reach it", async () => {
    const a = new OpenAPIHono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("requestId", "req-12345678");
      c.set("auth", { kind: "anonymous" } as never);
      await next();
    });
    notificationsModule.routes(a, {
      pool: app,
      clock: { now: () => Date.now() },
      ids: { uuidv7 },
      idempotencyCache,
    });
    a.onError((err, c) => {
      const p = toProblem(err, "req-12345678");
      return c.json(p, p.status as 401);
    });
    expect((await a.request("/v1/notifications")).status).toBe(401);
  });
});

describe("preferences and push tokens", () => {
  it("lists every kind with defaults, then keeps what the person saves", async () => {
    const a = appFor(uuidv7(), uuidv7());
    const before = (await (await a.request("/v1/notifications/preferences")).json()) as {
      preferences: { kind: string; inApp: boolean; email: boolean }[];
    };
    expect(before.preferences.length).toBeGreaterThanOrEqual(5);
    expect(before.preferences.every((p) => p.inApp && !p.email)).toBe(true);
    const res = await a.request(
      ...argsOf(
        put("/v1/notifications/preferences", {
          preferences: [{ kind: "daily_summary", inApp: true, email: true }],
        }),
      ),
    );
    const after = (await res.json()) as typeof before;
    expect(after.preferences.find((p) => p.kind === "daily_summary")?.email).toBe(true);
    expect(after.preferences.find((p) => p.kind === "low_stock")?.email).toBe(false);
  });

  it("takes the last choice when a kind repeats and tells a link-less message", async () => {
    const t = uuidv7();
    const u = uuidv7();
    const a = appFor(t, u);
    const res = await a.request(
      ...argsOf(
        put("/v1/notifications/preferences", {
          preferences: [
            { kind: "expiring", inApp: false, email: false },
            { kind: "expiring", inApp: true, email: true },
          ],
        }),
      ),
    );
    const body = (await res.json()) as { preferences: { kind: string; email: boolean }[] };
    expect(body.preferences.find((p) => p.kind === "expiring")?.email).toBe(true);
    const told = await withTenantTx(worker, ctx(t, u), (tx) =>
      notify(tx, t, [u], { kind: "expiring", title: "x", body: "y", dedupeKey: "k1" }),
    );
    expect(told).toBe(1);
  });

  it("refuses an unknown kind", async () => {
    const res = await appFor(uuidv7(), uuidv7()).request(
      ...argsOf(
        put("/v1/notifications/preferences", {
          preferences: [{ kind: "spam", inApp: true, email: true }],
        }),
      ),
    );
    expect(res.status).toBe(422);
  });

  it("hands a phone to whoever signed in last", async () => {
    const t = uuidv7();
    const [first, second] = [uuidv7(), uuidv7()];
    const token = "ExponentPushToken[handoff0000000]";
    for (const u of [first, second]) {
      await appFor(t, u).request(
        ...argsOf(put("/v1/notifications/push-tokens", { token, platform: "android" })),
      );
    }
    const rows = await withTenantTx(
      admin,
      ctx(t, first),
      async (tx) =>
        (await tx.query<{ user_id: string }>("SELECT user_id FROM notifications.push_tokens")).rows,
    );
    expect(rows).toEqual([{ user_id: second }]);
  });

  it("registers a phone once and removes it", async () => {
    const t = uuidv7();
    const u = uuidv7();
    const a = appFor(t, u);
    const token = "ExponentPushToken[abcdefghijklmnop]";
    for (let i = 0; i < 2; i++) {
      const res = await a.request(
        ...argsOf(put("/v1/notifications/push-tokens", { token, platform: "ios" })),
      );
      expect(res.status).toBe(200);
    }
    const n = await withTenantTx(
      admin,
      ctx(t, u),
      async (tx) =>
        (await tx.query("SELECT count(*)::int AS n FROM notifications.push_tokens")).rows[0],
    );
    expect(n).toEqual({ n: 1 });
    const res = await a.request(
      ...argsOf(put("/v1/notifications/push-tokens", { token }, "DELETE")),
    );
    expect(res.status).toBe(200);
    const gone = await withTenantTx(
      admin,
      ctx(t, u),
      async (tx) =>
        (await tx.query("SELECT count(*)::int AS n FROM notifications.push_tokens")).rows[0],
    );
    expect(gone).toEqual({ n: 0 });
  });
});
