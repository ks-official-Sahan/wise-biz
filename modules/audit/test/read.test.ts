import { OpenAPIHono } from "@hono/zod-openapi";
import { appendAudit, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { setPolicy } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { csvCell } from "../src/csv.ts";
import { decodeCursor, encodeCursor, mountAuditRoutes } from "../src/http.ts";
import { AUDIT_PERMISSIONS } from "../src/permissions.ts";
import { uuidV7Time } from "../src/read.ts";

import { setupDb } from "./helpers.ts";

import type { Db } from "./helpers.ts";
import type { AppEnv } from "@wise-biz/module-kit";
import type { Context } from "hono";

let db: Db;
beforeAll(async () => {
  db = await setupDb();
});
afterAll(async () => {
  await db.drop();
});

const catalog = createCatalog(AUDIT_PERMISSIONS);
const NOW = Date.UTC(2026, 9, 24, 12);

/** The audit routes behind the API's error mapping, as a member holding `roles` in `tenantId`. */
function appAs(tenantId: string, roles: string[]) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c: Context<AppEnv>, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: "01900000-0000-7000-8000-000000000001",
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId,
      roles,
      branchScope: "all",
      permissionsVersion: 1,
    });
    setPolicy(c, {
      matrix: matrixFromRows(catalog, [
        { role: "viewer", permission: "audit:read" },
        { role: "exporter", permission: "audit:read" },
        { role: "exporter", permission: "audit:export" },
      ]),
      now: () => NOW,
    });
    await next();
  });
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  mountAuditRoutes(app, { pool: db.app, clock: { now: () => NOW }, ids: { uuidv7 }, catalog });
  return app;
}

/** Writes rows with distinct actors/actions; rows of one call share `at` (transaction time). */
async function seed(
  tenantId: string,
  rows: { actorId: string; action: string; entity?: string; entityId?: string; after?: unknown }[],
) {
  await withTenantTx(db.app, { tenantId, requestId: "seed" }, (tx) =>
    appendAudit(
      tx,
      rows.map((r) => ({
        actorType: "user" as const,
        actorId: r.actorId,
        action: r.action,
        entity: r.entity ?? "tenancy.branch",
        ...(r.entityId === undefined ? {} : { entityId: r.entityId }),
        before: { name: "Old" },
        after: r.after ?? { name: "New" },
        requestId: "req-seed",
      })),
    ),
  );
}

interface ListBody {
  entries: {
    id: string;
    actor: { id: string };
    action: string;
    entity: { type: string; id: string | null };
  }[];
  nextCursor: string | null;
}

describe("GET /v1/audit/entries", () => {
  it("lists newest first, filters, and pages with a stable keyset cursor", async () => {
    const t = uuidv7();
    for (let i = 0; i < 5; i += 1) {
      await seed(t, [
        { actorId: i % 2 === 0 ? "alice" : "bob", action: i < 3 ? "x.created" : "x.updated" },
      ]);
    }
    const app = appAs(t, ["owner"]);
    const all = (await (await app.request("/v1/audit/entries")).json()) as ListBody;
    expect(all.entries).toHaveLength(5);
    expect(all.nextCursor).toBeNull();

    const alice = (await (await app.request("/v1/audit/entries?actor=alice")).json()) as ListBody;
    expect(alice.entries.map((e) => e.actor.id)).toEqual(["alice", "alice", "alice"]);
    const updated = (await (
      await app.request("/v1/audit/entries?action=x.updated")
    ).json()) as ListBody;
    expect(updated.entries).toHaveLength(2);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor === null ? "" : `&cursor=${cursor}`;
      const page = (await (await app.request(`/v1/audit/entries?limit=2${qs}`)).json()) as ListBody;
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.entries.map((e) => e.id));
    expect(new Set(seen).size).toBe(5);
  });

  it("is tenant-scoped (RLS) and 404 without audit:read; 422 for a malformed cursor", async () => {
    const a = uuidv7();
    const b = uuidv7();
    await seed(a, [{ actorId: "alice", action: "x.created" }]);
    const other = (await (
      await appAs(b, ["owner"]).request("/v1/audit/entries")
    ).json()) as ListBody;
    expect(other.entries).toEqual([]);
    expect((await appAs(a, ["cashier"]).request("/v1/audit/entries")).status).toBe(404);
    expect((await appAs(a, ["viewer"]).request("/v1/audit/entries")).status).toBe(200);
    expect((await appAs(a, ["owner"]).request("/v1/audit/entries?cursor=bm9wZQ")).status).toBe(422);
  });

  it("filters by time range (from inclusive, to exclusive)", async () => {
    const t = uuidv7();
    await seed(t, [{ actorId: "alice", action: "x.created" }]);
    const app = appAs(t, ["owner"]);
    const future = (await (
      await app.request(`/v1/audit/entries?from=${encodeURIComponent("2999-01-01T00:00:00Z")}`)
    ).json()) as ListBody;
    expect(future.entries).toEqual([]);
    const past = (await (
      await app.request(`/v1/audit/entries?to=${encodeURIComponent("2999-01-01T00:00:00Z")}`)
    ).json()) as ListBody;
    expect(past.entries).toHaveLength(1);
  });

  it("the filtered list query uses an index (EXPLAIN)", async () => {
    const t = uuidv7();
    await seed(t, [{ actorId: "alice", action: "x.created" }]);
    const plan = await withTenantTx(db.app, { tenantId: t, requestId: "explain" }, async (tx) => {
      await tx.query("set local enable_seqscan = off");
      const res = await tx.query<{ "QUERY PLAN": string }>(
        `explain select id from audit.audit_log
         where tenant_id = $1 and actor_id = $2 order by at desc, id desc limit 51`,
        [t, "alice"],
      );
      return res.rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/audit_log_\w*actor\w*/);
  });
});

describe("GET /v1/audit/entries/:id", () => {
  it("returns before/after for the diff, 404 for unknown or other-tenant ids", async () => {
    const t = uuidv7();
    await seed(t, [
      { actorId: "alice", action: "x.updated", entityId: "b-1", after: { name: "New" } },
    ]);
    const app = appAs(t, ["owner"]);
    const list = (await (await app.request("/v1/audit/entries")).json()) as ListBody;
    const id = list.entries[0]?.id ?? "";
    const one = await app.request(`/v1/audit/entries/${id}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({
      id,
      before: { name: "Old" },
      after: { name: "New" },
      entity: { type: "tenancy.branch", id: "b-1" },
      chained: false,
    });
    expect((await app.request(`/v1/audit/entries/${uuidv7()}`)).status).toBe(404);
    expect((await appAs(uuidv7(), ["owner"]).request(`/v1/audit/entries/${id}`)).status).toBe(404);
  });
});

describe("GET /v1/audit/export", () => {
  it("streams escaped CSV, needs audit:export, and audits the export in the same transaction", async () => {
    const t = uuidv7();
    await seed(t, [{ actorId: "=HYPERLINK(evil)", action: "x.created" }]);
    expect((await appAs(t, ["viewer"]).request("/v1/audit/export")).status).toBe(404);

    const res = await appAs(t, ["exporter"]).request("/v1/audit/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain('filename="audit-2026-10-24.csv"');
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe(
      '"id","at","actor_type","actor_id","action","entity","entity_id","request_id"',
    );
    expect(text).toContain(`"'=HYPERLINK(evil)"`);

    const recorded = await withTenantTx(
      db.admin,
      { tenantId: t, requestId: "check" },
      async (tx) => ({
        audit: (
          await tx.query("select 1 from audit.audit_log where action = 'audit.export.requested'")
        ).rowCount,
        outbox: (await tx.query("select 1 from infra.outbox where type = 'audit.export.requested'"))
          .rowCount,
      }),
    );
    expect(recorded).toEqual({ audit: 1, outbox: 1 });
  });
});

describe("helpers", () => {
  it("csvCell quotes, doubles quotes and neutralises formulas", () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    for (const s of ["=1", "+1", "-1", "@a", "\tx", "\rx"])
      expect(csvCell(s).startsWith(`"'`)).toBe(true);
    expect(csvCell(null)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("cursor round-trips and rejects junk; uuidV7Time reads the embedded time", () => {
    const c = { at: "2026-10-24 12:00:00.123456+00", id: "42" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(() => decodeCursor(Buffer.from("x|y|z").toString("base64url"))).toThrow();
    expect(() => decodeCursor(Buffer.from("2026-01-01|abc").toString("base64url"))).toThrow();
    expect(uuidV7Time("01900000-0000-7000-8000-000000000000").getTime()).toBe(0x019000000000);
  });
});
