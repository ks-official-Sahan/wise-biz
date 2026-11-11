/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-type-assertion -- HTTP bodies are read as loose JSON; the expect() calls are the typed part. */
import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSupportModule } from "../src/index.ts";

import type { AppEnv } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const supportDir = join(import.meta.dirname, "..", "migrations");

const T1 = uuidv7();
const T2 = uuidv7();
const USER = uuidv7();
const DEVICE = uuidv7();
const BRANCH = uuidv7();

/** Plan the test tenants are on. The real port reads billing (P2); here it is a stub the test can change. */
let planForTenant = "free";

const support = createSupportModule({
  refs: { branchExists: (_tx, _t, id) => Promise.resolve(id === BRANCH) },
  plans: () => Promise.resolve(planForTenant),
});
const matrix = matrixFromRows(createCatalog(support.permissions), [
  { role: "clerk", permission: "support:create" },
  { role: "clerk", permission: "support:read" },
  { role: "reader", permission: "support:read" },
]);

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "support", dir: supportDir },
  ]);
  pool = createPool(db.url("app"), { max: 10 });
  admin = createPool(db.url("admin"));
});

afterAll(async () => {
  await pool.end();
  await admin.end();
  await db.drop();
});

/** Mounts the module with a fixed actor, like the kernel does after auth. */
function appFor(tenantId: string, role: string) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (res) => {
      if (!res.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-support-test");
    c.set("auth", {
      kind: "user",
      userId: USER,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId,
      roles: [role],
      branchScope: "all",
      permissionsVersion: 1,
    });
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  support.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
  app.onError((err, c) => {
    const problem = toProblem(err, "req-support-test");
    return c.json(problem, problem.status as 404);
  });
  return app;
}

type App = ReturnType<typeof appFor>;

async function call(app: App, method: string, path: string, body?: unknown, key?: string) {
  const res = await app.request(`/v1/support${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as any,
    headers: res.headers,
  };
}

const newKey = () => `k-${uuidv7()}`;
const clerk = () => appFor(T1, "clerk");

/** Everything a POS would send: real-looking PII in the message, the bundle and an unknown key. */
const POS_DIAGNOSTICS = {
  appVersion: "2.4.1",
  platform: "android",
  deviceId: DEVICE,
  branchId: BRANCH,
  userEmail: "jo.shopper@shop.test",
  cookie: "session=abcdef",
  lastErrors: [
    { message: "Payment failed for card 4111 1111 1111 1111 (jo.shopper@shop.test)" },
    { message: "Sync rejected, Bearer eyJhbGciOiJIUzI1NiJ9.abc123DEF456ghi789JKL" },
    { message: "Call +1 (555) 123-4567 failed, token ABCdef123456789012345678" },
  ],
};

const PII_MARKERS = [
  "jo.shopper",
  "4111 1111",
  "eyJhbGci",
  "abc123DEF456",
  "ABCdef12345",
  "555) 123",
  "session=abcdef",
];

async function openTicket(app: App, extra: Record<string, unknown> = {}) {
  const r = await call(
    app,
    "POST",
    "/tickets",
    {
      subject: "Printer offline at till 2",
      priority: "high",
      branchId: BRANCH,
      body: "Printer offline since this morning",
      diagnostics: POS_DIAGNOSTICS,
      ...extra,
    },
    newKey(),
  );
  expect(r.status).toBe(201);
  return r.body as any;
}

describe("create and reply flow", () => {
  it("creates a ticket from a POS bundle with PII scrubbed, SLA stamped, and no PII in the response", async () => {
    const app = clerk();
    const before = Date.now();
    const t = await openTicket(app);
    const after = Date.now();

    expect(t.status).toBe("open");
    expect(t.priority).toBe("high");
    expect(t.planCode).toBe("free");
    expect(t.firstRespondedAt).toBeNull();
    expect(t.solvedAt).toBeNull();

    // SLA: free plan, 48h first response, 120h resolution, from the server clock.
    const createdMs = Date.parse(t.createdAt);
    expect(createdMs).toBeGreaterThanOrEqual(before);
    expect(createdMs).toBeLessThanOrEqual(after);
    expect(Date.parse(t.slaFirstResponseDueAt) - createdMs).toBe(48 * 3_600_000);
    expect(Date.parse(t.slaResolutionDueAt) - createdMs).toBe(120 * 3_600_000);

    // Diagnostics: whitelisted keys only, messages scrubbed.
    expect(Object.keys(t.diagnostics).sort()).toEqual(
      ["appVersion", "branchId", "deviceId", "lastErrors", "platform"].sort(),
    );
    const messages = (t.diagnostics.lastErrors as { message: string }[]).map((e) => e.message);
    expect(messages[0]).toContain("[card]");
    expect(messages[0]).toContain("[email]");
    expect(messages[1]).toContain("Bearer [token]");
    expect(messages[2]).toContain("[phone]");
    expect(messages[2]).toContain("[secret]");

    const wire = JSON.stringify(t);
    for (const marker of PII_MARKERS) expect(wire).not.toContain(marker);
  });

  it("keeps PII out of the database row and the outbox event, and the event has no body", async () => {
    const app = clerk();
    const t = await openTicket(app, { body: "Printer offline at till 9" });

    const row = await admin.query<{ diagnostics: string }>(
      "select diagnostics::text as diagnostics from support.tickets where id = $1",
      [t.id],
    );
    const ev = await admin.query<{ payload: unknown; type: string }>(
      `select type, payload from infra.outbox
        where tenant_id = $1 and type = 'support.ticket.created' and payload->'subject' = $2::jsonb`,
      [T1, JSON.stringify(`ticket/${t.id}`)],
    );
    expect(ev.rows).toHaveLength(1);
    const stored = JSON.stringify([row.rows[0]?.diagnostics, ev.rows[0]?.payload]);
    for (const marker of PII_MARKERS) expect(stored).not.toContain(marker);
    expect(stored).not.toContain("till 9");
    expect(JSON.stringify(ev.rows[0]?.payload)).not.toContain("lastErrors");
  });

  it("a tenant reply on an open ticket keeps it open; the thread shows both messages in order", async () => {
    const app = clerk();
    const t = await openTicket(app);
    const r = await call(
      app,
      "POST",
      `/tickets/${t.id}/messages`,
      { body: "Still down" },
      newKey(),
    );
    expect(r.status).toBe(201);
    expect(r.body.internal).toBe(false);
    expect(r.body.authorKind).toBe("tenant");

    const d = await call(app, "GET", `/tickets/${t.id}`);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("open");
    expect(d.body.messages.map((m: any) => m.body)).toEqual([
      "Printer offline since this morning",
      "Still down",
    ]);
    expect(d.body.messagesTruncated).toBe(false);
  });

  it("a tenant reply moves a pending ticket to open, and a solved one reopens inside 14 days", async () => {
    const app = clerk();
    const t = await openTicket(app);
    // The platform's reply (open to pending) is not reachable over HTTP yet; the test puts the row there directly.
    await admin.query("update support.tickets set status = 'pending' where id = $1", [t.id]);
    const r1 = await call(
      app,
      "POST",
      `/tickets/${t.id}/messages`,
      { body: "Any update?" },
      newKey(),
    );
    expect(r1.status).toBe(201);
    expect((await call(app, "GET", `/tickets/${t.id}`)).body.status).toBe("open");

    const solved = await call(
      app,
      "POST",
      `/tickets/${t.id}/status`,
      { status: "solved" },
      newKey(),
    );
    expect(solved.status).toBe(200);
    expect(solved.body.status).toBe("solved");
    expect(solved.body.solvedAt).not.toBeNull();

    const r2 = await call(
      app,
      "POST",
      `/tickets/${t.id}/messages`,
      { body: "Reopening" },
      newKey(),
    );
    expect(r2.status).toBe(201);
    expect((await call(app, "GET", `/tickets/${t.id}`)).body.status).toBe("open");
  });

  it("internal notes never reach the tenant, even when a tenant asks for one", async () => {
    const app = clerk();
    const t = await openTicket(app);
    await admin.query(
      `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body, internal)
       values ($1, $2, $3, 'platform', $4, 'internal: refund suspected', true)`,
      [T1, uuidv7(), t.id, USER],
    );
    const forged = await call(
      app,
      "POST",
      `/tickets/${t.id}/messages`,
      { body: "hi", internal: true },
      newKey(),
    );
    expect(forged.status).toBe(201);
    expect(forged.body.internal).toBe(false);

    const d = await call(app, "GET", `/tickets/${t.id}`);
    const bodies = d.body.messages.map((m: any) => m.body);
    expect(bodies).not.toContain("internal: refund suspected");
    expect(bodies).toContain("hi");
  });

  it("closed is terminal: replies and further status changes are a 409", async () => {
    const app = clerk();
    const t = await openTicket(app);
    const closed = await call(
      app,
      "POST",
      `/tickets/${t.id}/status`,
      { status: "closed" },
      newKey(),
    );
    expect(closed.status).toBe(200);
    const reply = await call(
      app,
      "POST",
      `/tickets/${t.id}/messages`,
      { body: "one more" },
      newKey(),
    );
    expect(reply.status).toBe(409);
    const reopen = await call(app, "POST", `/tickets/${t.id}/status`, { status: "open" }, newKey());
    expect(reopen.status).toBe(409);
  });

  it("a tenant cannot set pending (platform only): 409, and the ticket does not move", async () => {
    const app = clerk();
    const t = await openTicket(app);
    const r = await call(app, "POST", `/tickets/${t.id}/status`, { status: "pending" }, newKey());
    expect(r.status).toBe(409);
    expect((await call(app, "GET", `/tickets/${t.id}`)).body.status).toBe("open");
  });

  it("the plan comes from the server, never the request: a client cannot ask for a faster SLA", async () => {
    planForTenant = "business";
    try {
      const app = clerk();
      const t = await openTicket(app, {
        planCode: "free",
        slaFirstResponseDueAt: "2000-01-01T00:00:00Z",
      });
      expect(t.planCode).toBe("business");
      const createdMs = Date.parse(t.createdAt);
      expect(Date.parse(t.slaFirstResponseDueAt) - createdMs).toBe(2 * 3_600_000);
    } finally {
      planForTenant = "free";
    }
  });

  it("an unknown branch is refused with 422 before anything is written", async () => {
    const app = clerk();
    const r = await call(
      app,
      "POST",
      "/tickets",
      { subject: "x", body: "y", branchId: uuidv7() },
      newKey(),
    );
    expect(r.status).toBe(422);
  });

  it("a mutation without an Idempotency-Key is refused, and a replay returns the same bytes", async () => {
    const app = clerk();
    const none = await call(app, "POST", "/tickets", { subject: "x", body: "y" });
    expect(none.status).toBe(422);

    const key = newKey();
    const first = await call(app, "POST", "/tickets", { subject: "Replay", body: "same" }, key);
    const again = await call(app, "POST", "/tickets", { subject: "Replay", body: "same" }, key);
    expect(first.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
  });
});

describe("authorization and tenant scope", () => {
  it("a role without support permissions gets 404 on every route, not 403", async () => {
    const nobody = appFor(T1, "guest");
    expect((await call(nobody, "GET", "/tickets")).status).toBe(404);
    expect(
      (await call(nobody, "POST", "/tickets", { subject: "x", body: "y" }, newKey())).status,
    ).toBe(404);
  });

  it("a read-only role can read but not open or reply: 404 on the writes", async () => {
    const t = await openTicket(clerk());
    const reader = appFor(T1, "reader");
    expect((await call(reader, "GET", `/tickets/${t.id}`)).status).toBe(200);
    expect(
      (await call(reader, "POST", `/tickets/${t.id}/messages`, { body: "x" }, newKey())).status,
    ).toBe(404);
    expect(
      (await call(reader, "POST", `/tickets/${t.id}/status`, { status: "closed" }, newKey()))
        .status,
    ).toBe(404);
  });

  it("another tenant's ticket is a 404, indistinguishable from a missing one", async () => {
    const t = await openTicket(clerk());
    const other = appFor(T2, "clerk");
    expect((await call(other, "GET", `/tickets/${t.id}`)).status).toBe(404);
    expect((await call(other, "GET", `/tickets/${uuidv7()}`)).status).toBe(404);
    expect(
      (await call(other, "POST", `/tickets/${t.id}/messages`, { body: "x" }, newKey())).status,
    ).toBe(404);
  });
});

describe("keyset list", () => {
  it("pages newest first with an opaque cursor, and filters by status", async () => {
    const tenant = uuidv7();
    const app = appFor(tenant, "clerk");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (await openTicket(app, { subject: `Ticket ${String(i)}`, diagnostics: undefined })).id,
      );
    }
    const p1 = await call(app, "GET", "/tickets?limit=2");
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).not.toBeNull();

    const p2 = await call(
      app,
      "GET",
      `/tickets?limit=2&after=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    const p3 = await call(
      app,
      "GET",
      `/tickets?limit=2&after=${encodeURIComponent(p2.body.nextCursor)}`,
    );
    const seen = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((x: any) => x.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...ids].reverse());
    expect(p3.body.nextCursor).toBeNull();

    const forged = await call(app, "GET", "/tickets?after=bm90LWEtY3Vyc29y");
    expect(forged.status).toBe(422);

    const solvedOnly = await call(app, "GET", "/tickets?status=solved");
    expect(solvedOnly.body.items).toEqual([]);
  });
});
