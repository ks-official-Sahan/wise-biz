import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createNotificationsConsumer } from "../src/consumer.ts";
import { runDeliveries } from "../src/delivery.ts";
import { notificationsModule } from "../src/index.ts";
import { notify } from "../src/notify.ts";
import { createExpoPush } from "../src/push.ts";

import type { MailPort } from "../src/notify.ts";
import type { PushMessage, PushPort, PushResult } from "../src/push.ts";
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
  mail?: MailPort,
  push?: PushPort,
) => {
  const consumer = createNotificationsConsumer({
    holders: () => Promise.resolve(people),
    channels: { email: mail !== undefined, push: push !== undefined },
  });
  return withTenantTx(worker, ctx(tenantId, people[0] ?? uuidv7()), (tx) =>
    consumer.handle({ id, tenantId, type, payload: { data: payload } }, { client: tx as never }),
  );
};

/** Stage 2 as the worker loop runs it: no lease wait, errors collected instead of thrown. */
const sendNow = (mail?: MailPort, push?: PushPort, errors: unknown[] = []) =>
  runDeliveries({
    pool: worker,
    mail,
    push,
    leaseMs: 0,
    onError: (err) => {
      errors.push(err);
    },
  });

const LOW = { locationId: "l", variantId: "v", qty: "2.0000", minQty: "5.0000", maxQty: null };

const matrix = matrixFromRows(createCatalog(notificationsModule.permissions), []);
const idempotencyCache: IdempotencyCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};
function appFor(
  tenantId: string,
  userId: string,
  account: { email?: string; emailVerified?: boolean } = {
    email: "person@example.test",
    emailVerified: true,
  },
) {
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
      ...account,
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

  it("summarises yesterday for people who read reports, formatting money by the currency", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await deliver(t, [u], "reporting.digest.ready", {
      businessDate: "2026-11-03",
      totals: [
        { currency: "USD", salesCount: 12, netMinor: 123_456, voidsCount: 1, returnsCount: 0 },
        { currency: "JPY", salesCount: 3, netMinor: 5000, voidsCount: 0, returnsCount: 0 },
      ],
    });
    const body = (await (await appFor(t, u).request("/v1/notifications")).json()) as Listed & {
      notifications: { body: string }[];
    };
    expect(body.notifications[0]).toMatchObject({
      kind: "daily_summary",
      title: "Sales on 2026-11-03",
      link: "/reports",
    });
    expect(body.notifications[0]?.body).toContain("12 sales, $1,234.56 net of returns");
    expect(body.notifications[0]?.body).toContain("3 sales, ¥5,000 net of returns");
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

describe("email", () => {
  const prefs = (a: ReturnType<typeof appFor>, email: boolean) =>
    a.request(
      ...argsOf(
        put("/v1/notifications/preferences", {
          preferences: [{ kind: "low_stock", inApp: true, email }],
        }),
      ),
    );
  const sent: { to: string; subject: string; text: string }[] = [];
  const mail = (fail = false): MailPort => ({
    consoleUrl: "https://console.example.test",
    send: (m) => {
      if (fail) return Promise.reject(new Error("smtp down"));
      sent.push(m);
      return Promise.resolve();
    },
  });

  it("mails only people who turned it on, to their verified address, with a link into the console", async () => {
    sent.length = 0;
    const t = uuidv7();
    const [on, off] = [uuidv7(), uuidv7()];
    expect(
      (
        await prefs(
          appFor(t, on, { email: "Wants@Example.test".toLowerCase(), emailVerified: true }),
          true,
        )
      ).status,
    ).toBe(200);
    const m = mail();
    await deliver(t, [on, off], "inventory.balance.low", LOW, uuidv7(), m);
    expect(sent).toHaveLength(0); // stage 1 only stores and flags
    await sendNow(m);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "wants@example.test", subject: "Stock is running low" });
    expect(sent[0]?.text).toContain("https://console.example.test/stock");
  });

  it("does not mail twice when the event is delivered again, and finishes the unsent after a failure", async () => {
    sent.length = 0;
    const t = uuidv7();
    const u = uuidv7();
    await prefs(appFor(t, u), true);
    const id = uuidv7();
    const errors: unknown[] = [];
    await deliver(t, [u], "inventory.balance.low", LOW, id, mail());
    await sendNow(mail(true), undefined, errors);
    expect(sent).toHaveLength(0);
    expect(errors).toHaveLength(1);
    // The event arriving again stores and flags nothing new; the failed email is still owed and now goes out, once.
    await deliver(t, [u], "inventory.balance.low", LOW, id, mail());
    await sendNow(mail());
    await sendNow(mail());
    expect(sent).toHaveLength(1);
    const body = (await (await appFor(t, u).request("/v1/notifications")).json()) as Listed;
    expect(body.notifications).toHaveLength(1);
  });

  it("sends nothing when the event's transaction rolls back, and marks only the row it sent", async () => {
    sent.length = 0;
    const t = uuidv7();
    const [a, b] = [uuidv7(), uuidv7()];
    await prefs(appFor(t, a, { email: "a@example.test", emailVerified: true }), true);
    await prefs(appFor(t, b, { email: "b@example.test", emailVerified: true }), true);
    const consumer = createNotificationsConsumer({
      holders: () => Promise.resolve([a, b]),
      channels: { email: true },
    });
    await expect(
      withTenantTx(worker, ctx(t, a), async (tx) => {
        await consumer.handle(
          { id: uuidv7(), tenantId: t, type: "inventory.balance.low", payload: { data: LOW } },
          { client: tx as never },
        );
        throw new Error("a later step failed");
      }),
    ).rejects.toThrow("a later step failed");
    await sendNow(mail());
    expect(sent).toHaveLength(0);

    // Two flagged people; the mailer fails for one address only. The other is delivered and is not sent again.
    await deliver(t, [a, b], "inventory.balance.low", LOW, uuidv7(), mail());
    const flaky: MailPort = {
      consoleUrl: "https://console.example.test",
      send: (m) =>
        m.to === "a@example.test" ? Promise.reject(new Error("bounce")) : mail().send(m),
    };
    await sendNow(flaky);
    await sendNow(flaky);
    expect(sent.map((m) => m.to)).toEqual(["b@example.test"]);
    // a's bounce is still owed; clear it so it does not leak into later tests that share this database.
    await withTenantTx(admin, ctx(t, a), (tx) =>
      tx.query(
        "UPDATE notifications.notifications SET email_pending = false WHERE tenant_id = $1",
        [t],
      ),
    );
  });

  it("claims a row once across concurrent workers and gives up after the attempts", async () => {
    sent.length = 0;
    const t = uuidv7();
    const u = uuidv7();
    await prefs(appFor(t, u), true);
    await deliver(t, [u], "inventory.balance.low", LOW, uuidv7(), mail());
    const slow: MailPort = {
      consoleUrl: "https://console.example.test",
      send: async (m) => {
        await new Promise((r) => setTimeout(r, 100));
        sent.push(m);
      },
    };
    const lease = { pool: worker, mail: slow, leaseMs: 60_000 };
    await Promise.all([runDeliveries(lease), runDeliveries(lease), runDeliveries(lease)]);
    expect(sent).toHaveLength(1);

    const v = uuidv7();
    await prefs(appFor(t, v, { email: "v@example.test", emailVerified: true }), true);
    await deliver(t, [v], "inventory.balance.low", LOW, uuidv7(), mail());
    const dead: MailPort = { consoleUrl: "x", send: () => Promise.reject(new Error("never")) };
    for (let i = 0; i < 4; i++)
      await runDeliveries({ pool: worker, mail: dead, leaseMs: 0, maxAttempts: 2 });
    const left = await withTenantTx(admin, ctx(t, v), (tx) =>
      tx.query(
        "SELECT email_pending, delivery_attempts FROM notifications.notifications WHERE user_id = $1",
        [v],
      ),
    );
    expect(left.rows).toEqual([{ email_pending: false, delivery_attempts: 3 }]);
  });

  it("refuses to turn email on without a verified address, and forgets the address when turned off", async () => {
    const t = uuidv7();
    const u = uuidv7();
    expect(
      (await prefs(appFor(t, u, { email: "a@example.test", emailVerified: false }), true)).status,
    ).toBe(422);
    expect((await prefs(appFor(t, u, {}), true)).status).toBe(422);
    expect((await prefs(appFor(t, u, {}), false)).status).toBe(200);
    await prefs(appFor(t, u), true);
    await prefs(appFor(t, u), false);
    const row = await withTenantTx(admin, ctx(t, u), (tx) =>
      tx.query("SELECT email, email_to FROM notifications.preferences WHERE kind = 'low_stock'"),
    );
    expect(row.rows).toEqual([{ email: false, email_to: null }]);
  });
});

describe("phone push", () => {
  const token = (u: string, t: string, value: string) =>
    appFor(t, u).request(
      ...argsOf(put("/v1/notifications/push-tokens", { token: value, platform: "android" })),
    );
  const fakePush = (answer: (m: PushMessage, i: number) => PushResult = () => ({ ok: true })) => {
    const calls: PushMessage[][] = [];
    const port: PushPort = {
      send: (messages) => {
        calls.push([...messages]);
        return Promise.resolve(messages.map(answer));
      },
    };
    return { port, calls };
  };

  it("pushes to every phone of the people told, once, with the in-app link", async () => {
    const t = uuidv7();
    const [a, b, none] = [uuidv7(), uuidv7(), uuidv7()];
    await token(a, t, "ExponentPushToken[aaaaaaaaaaaaaaa1]");
    await token(a, t, "ExponentPushToken[aaaaaaaaaaaaaaa2]");
    await token(b, t, "ExponentPushToken[bbbbbbbbbbbbbbb1]");
    const { port, calls } = fakePush();
    const id = uuidv7();
    await deliver(t, [a, b, none], "inventory.balance.low", LOW, id, undefined, port);
    await sendNow(undefined, port);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((m) => m.to)).toHaveLength(3);
    expect(calls[0]?.[0]).toMatchObject({ title: "Stock is running low", link: "/stock" });
    // The same event again pushes nothing: every notification is marked.
    await deliver(t, [a, b, none], "inventory.balance.low", LOW, id, undefined, port);
    await sendNow(undefined, port);
    expect(calls).toHaveLength(1);
  });

  it("forgets a phone the push service says is gone, and keeps the others", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await token(u, t, "ExponentPushToken[gone0000000000]");
    await token(u, t, "ExponentPushToken[live0000000000]");
    const { port } = fakePush((m) =>
      m.to.includes("gone") ? { ok: false, unregistered: true } : { ok: true },
    );
    await deliver(t, [u], "inventory.balance.low", LOW, uuidv7(), undefined, port);
    await sendNow(undefined, port);
    const left = await withTenantTx(admin, ctx(t, u), (tx) =>
      tx.query("SELECT token FROM notifications.push_tokens ORDER BY token"),
    );
    expect(left.rows).toEqual([{ token: "ExponentPushToken[live0000000000]" }]);
  });

  it("keeps the push owed when the push service is down, then pushes once", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await token(u, t, "ExponentPushToken[retry000000000]");
    const id = uuidv7();
    const down: PushPort = { send: () => Promise.reject(new Error("push service answered 503")) };
    const errors: unknown[] = [];
    await deliver(t, [u], "inventory.balance.low", LOW, id, undefined, down);
    await sendNow(undefined, down, errors);
    expect(errors).toHaveLength(1);
    const { port, calls } = fakePush();
    await sendNow(undefined, port);
    await sendNow(undefined, port);
    expect(calls).toHaveLength(1);
  });

  it("talks to the Expo service in its documented shape, in batches of 100", async () => {
    const seen: { url: string; body: unknown[] }[] = [];
    const okFetch = ((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as unknown[];
      seen.push({ url, body });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: body.map((_, i) =>
              i === 0
                ? { status: "error", details: { error: "DeviceNotRegistered" } }
                : { status: "ok" },
            ),
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const push = createExpoPush({ fetch: okFetch, accessToken: "t0ken" });
    const msgs = Array.from({ length: 150 }, (_, i) => ({
      to: `ExponentPushToken[${String(i).padStart(16, "0")}]`,
      title: "x",
      body: "y",
      link: i === 0 ? "/stock" : null,
    }));
    const results = await push.send(msgs);
    expect(seen.map((s) => s.body.length)).toEqual([100, 50]);
    expect(seen[0]?.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(seen[0]?.body[0]).toMatchObject({ title: "x", data: { link: "/stock" } });
    expect(results[0]).toEqual({ ok: false, unregistered: true });
    expect(results[1]).toEqual({ ok: true });
    expect(results).toHaveLength(150);

    const failing = createExpoPush({
      fetch: (() => Promise.resolve(new Response("", { status: 500 }))) as unknown as typeof fetch,
    });
    await expect(failing.send(msgs.slice(0, 1))).rejects.toThrow("500");
    const short = createExpoPush({
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        )) as unknown as typeof fetch,
    });
    await expect(short.send(msgs.slice(0, 1))).rejects.toThrow("wrong count");
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

describe("delivery limits", () => {
  // runDeliveries serves every business, so rows other tests left owed would be sent (and counted) in these runs.
  beforeEach(async () => {
    const owed = await worker.query<{ tenant_id: string }>(
      "SELECT DISTINCT tenant_id FROM notifications.notifications WHERE email_pending OR push_pending",
    );
    for (const { tenant_id: t } of owed.rows)
      await withTenantTx(admin, ctx(t, uuidv7()), (tx) =>
        tx.query(
          "UPDATE notifications.notifications SET email_pending = false, push_pending = false WHERE tenant_id = $1",
          [t],
        ),
      );
  });
  const prefs = (a: ReturnType<typeof appFor>) =>
    a.request(
      ...argsOf(
        put("/v1/notifications/preferences", {
          preferences: [{ kind: "low_stock", inApp: true, email: true }],
        }),
      ),
    );
  const addTokens = (t: string, u: string, n: number, tag: string) =>
    withTenantTx(admin, ctx(t, u), (tx) =>
      tx.query(
        `INSERT INTO notifications.push_tokens (tenant_id, user_id, token, platform)
         SELECT $1, $2, 'ExponentPushToken[' || $3 || g || ']', 'android' FROM generate_series(1, $4::int) g`,
        [t, u, tag, n],
      ),
    );
  const mailTo = (sink: string[], ms = 0): MailPort => ({
    consoleUrl: "https://console.example.test",
    send: async (m) => {
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      sink.push(m.to);
    },
  });
  const pending = async (t: string, u: string) =>
    (
      await withTenantTx(admin, ctx(t, u), (tx) =>
        tx.query(
          "SELECT email_pending, push_pending FROM notifications.notifications WHERE user_id = $1",
          [u],
        ),
      )
    ).rows[0];

  it("leaves an email owed, not marked sent, when this worker has no mail port", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await prefs(appFor(t, u));
    await addTokens(t, u, 1, "solo");
    const push: PushPort = { send: (ms) => Promise.resolve(ms.map(() => ({ ok: true }))) };
    await deliver(t, [u], "inventory.balance.low", LOW, uuidv7(), mailTo([]), push);
    await runDeliveries({ pool: worker, push, leaseMs: 0 });
    expect(await pending(t, u)).toEqual({ email_pending: true, push_pending: false });
    const sent: string[] = [];
    await runDeliveries({ pool: worker, mail: mailTo(sent), leaseMs: 0 });
    expect(sent).toEqual(["person@example.test"]);
  });

  it("reports the business with every failure", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await prefs(appFor(t, u));
    await deliver(t, [u], "inventory.balance.low", LOW, uuidv7(), mailTo([]));
    const seen: [string, string][] = [];
    await runDeliveries({
      pool: worker,
      mail: { consoleUrl: "x", send: () => Promise.reject(new Error("down")) },
      leaseMs: 0,
      onError: (_e, tenantId, _id, channel) => seen.push([tenantId, channel]),
    });
    expect(seen).toEqual([[t, "email"]]);
  });

  it("stops sending when a send could outlive the lease, and the rest go out on the next pass", async () => {
    const t = uuidv7();
    const people = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    for (const [i, u] of people.entries())
      await prefs(appFor(t, u, { email: `p${String(i)}@example.test`, emailVerified: true }));
    await deliver(t, people, "inventory.balance.low", LOW, uuidv7(), mailTo([]));
    const sent: string[] = [];
    const opts = { pool: worker, mail: mailTo(sent, 150), leaseMs: 400, sendTimeoutMs: 200 };
    await runDeliveries(opts);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(4);
    await new Promise((r) => setTimeout(r, 450));
    await runDeliveries(opts);
    expect([...sent].sort()).toEqual(people.map((_, i) => `p${String(i)}@example.test`));
  });

  it("gives up on a push that never answers and keeps it owed", async () => {
    const t = uuidv7();
    const u = uuidv7();
    await addTokens(t, u, 1, "hang");
    const hang: PushPort = { send: () => new Promise(() => undefined) };
    await deliver(t, [u], "inventory.balance.low", LOW, uuidv7(), undefined, hang);
    const errors: unknown[] = [];
    await runDeliveries({
      pool: worker,
      push: hang,
      leaseMs: 0,
      sendTimeoutMs: 50,
      onError: (e) => errors.push(e),
    });
    expect(String(errors[0])).toMatch(/timed out/);
    expect((await pending(t, u))?.push_pending).toBe(true);
  });

  it("marks each push group when it is sent, so a later failure leaves only that group owed", async () => {
    const t = uuidv7();
    const [a, b] = [uuidv7(), uuidv7()];
    await addTokens(t, a, 60, "ga");
    await addTokens(t, b, 60, "gb");
    let calls = 0;
    const second: PushPort = {
      send: (ms) =>
        ++calls === 2
          ? Promise.reject(new Error("push service answered 503"))
          : Promise.resolve(ms.map(() => ({ ok: true }))),
    };
    await deliver(t, [a, b], "inventory.balance.low", LOW, uuidv7(), undefined, second);
    await runDeliveries({ pool: worker, push: second, leaseMs: 0 });
    const states = [(await pending(t, a))?.push_pending, (await pending(t, b))?.push_pending];
    expect(states.filter((s) => s === true)).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
