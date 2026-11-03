import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { PLATFORM_THEME } from "@wise-biz/theme";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { themingModule } from "../src/index.ts";

import type { AppEnv, IdempotencyCache, ModuleDeps } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const migrationsDir = join(import.meta.dirname, "..", "migrations");
const infraDir = join(import.meta.dirname, "..", "..", "infra", "migrations");
const auditDir = join(import.meta.dirname, "..", "..", "audit", "migrations");

const catalog = createCatalog(themingModule.permissions);
const matrix = matrixFromRows(catalog, [
  { role: "writer", permission: "theming:write" },
  { role: "writer", permission: "theming:read" },
  { role: "reader", permission: "theming:read" },
]);

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
const cache = new Map<string, string>();
const idempotencyCache: IdempotencyCache = {
  get: (k) => Promise.resolve(cache.get(k) ?? null),
  set: (k, v) => {
    cache.set(k, v);
    return Promise.resolve();
  },
};
const ACTOR = uuidv7();
const T1 = uuidv7();
const T2 = uuidv7();

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "audit", dir: auditDir },
    { module: "theming", dir: migrationsDir },
  ]);
  pool = createPool(db.url("app"), { max: 10 });
  admin = createPool(db.url("migrator"));
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await db.drop();
});

const deps = (): ModuleDeps => ({
  pool,
  clock: { now: () => Date.UTC(2026, 10, 3) },
  ids: { uuidv7 },
  idempotencyCache,
});

function appFor(tenantId: string, role: string) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: ACTOR,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId,
      roles: [role],
      branchScope: "all",
      permissionsVersion: 1,
    });
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  themingModule.routes(app, deps());
  app.onError((err, c) => {
    const problem = toProblem(err, "req-12345678");
    return c.json(problem, problem.status as 404);
  });
  return app;
}

const send = (app: ReturnType<typeof appFor>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const theme = (name: string, over: Record<string, unknown> = {}) => ({
  input: { ...PLATFORM_THEME, name, ...over },
});
/** Rows of one query, read as a member of the business (RLS applies to every role, the owner included). */
const inTenant = (tenantId: string, sql: string) =>
  withTenantTx(
    pool,
    { tenantId, userId: ACTOR, requestId: "test" },
    async (tx) => (await tx.query<Record<string, never>>(sql)).rows,
  );
/** The outbox is not readable by the app role: read it as the owner, inside the business (RLS is forced on owners too). */
const asOwner = async (tenantId: string, sql: string) => {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await client.query<{ v: string }>(sql);
    await client.query("commit");
    return r.rows;
  } finally {
    client.release();
  }
};
const body = async <T>(res: Response) => (await res.json()) as T;

interface Version {
  id: string;
  version: number | null;
  status: string;
  name: string;
}
interface State {
  published: Version | null;
  draft: Version | null;
}

describe("theme draft, publish and history", () => {
  it("keeps one draft that later saves replace", async () => {
    const app = appFor(T1, "writer");
    expect((await send(app, "PUT", "/v1/theming/theme/draft", theme("First"))).status).toBe(200);
    expect((await send(app, "PUT", "/v1/theming/theme/draft", theme("Second"))).status).toBe(200);
    const state = await body<State>(await app.request("/v1/theming/theme"));
    expect(state.published).toBeNull();
    expect(state.draft).toMatchObject({ name: "Second", status: "draft", version: null });
    const rows = await inTenant(T1, "select count(*)::int as n from theming.themes");
    expect(rows[0]?.n).toBe(1);
  });

  it("publishes as version 1, then archives it when version 2 goes out", async () => {
    const app = appFor(T1, "writer");
    const v1 = await send(app, "POST", "/v1/theming/theme/publish", {});
    expect(v1.status).toBe(200);
    expect(await body<Version>(v1)).toMatchObject({
      version: 1,
      status: "published",
      name: "Second",
    });

    await send(app, "PUT", "/v1/theming/theme/draft", theme("Third"));
    const v2 = await send(app, "POST", "/v1/theming/theme/publish", {});
    expect(await body<Version>(v2)).toMatchObject({ version: 2, status: "published" });

    const versions = await body<{ versions: Version[] }>(
      await app.request("/v1/theming/theme/versions"),
    );
    expect(versions.versions.map((v) => [v.version, v.status])).toEqual([
      [2, "published"],
      [1, "archived"],
    ]);
    const state = await body<State>(await app.request("/v1/theming/theme"));
    expect(state.draft).toBeNull();
  });

  it("emits one published event per publish, in the same transaction", async () => {
    const rows = await asOwner(
      T1,
      "select payload->'data'->>'version' as v from infra.outbox where type = 'theming.theme.published' order by created_at",
    );
    expect(rows.map((x) => x.v)).toEqual(["1", "2", "3"].slice(0, rows.length));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("restores an older version into the draft, to publish as a rollback", async () => {
    const app = appFor(T1, "writer");
    const res = await send(app, "POST", "/v1/theming/theme/restore", { version: 1 });
    expect(res.status).toBe(200);
    expect(await body<Version>(res)).toMatchObject({ status: "draft", name: "Second" });
    const pub = await send(app, "POST", "/v1/theming/theme/publish", {});
    expect(await body<Version>(pub)).toMatchObject({ version: 3, name: "Second" });
    expect((await send(app, "POST", "/v1/theming/theme/restore", { version: 99 })).status).toBe(
      404,
    );
  });

  it("blocks a publish while a colour pair fails contrast, and names the pair", async () => {
    const app = appFor(T2, "writer");
    const bad = theme("Pale", { overrides: { light: { accent: "#FFFF99" } } });
    // Saving a draft is fine: the person is still working on it.
    expect((await send(app, "PUT", "/v1/theming/theme/draft", bad)).status).toBe(200);
    const res = await send(app, "POST", "/v1/theming/theme/publish", {});
    expect(res.status).toBe(422);
    const problem = await body<{ errors: { path: string; message: string }[] }>(res);
    expect(problem.errors[0]?.path).toBe("light.textOnAccent");
    expect(problem.errors[0]?.message).toMatch(/needs/);
    const state = await body<State>(await app.request("/v1/theming/theme"));
    expect(state.published).toBeNull();
  });

  it("publishing without a draft is a 404, and a reader cannot change anything", async () => {
    expect(
      (await send(appFor(uuidv7(), "writer"), "POST", "/v1/theming/theme/publish", {})).status,
    ).toBe(404);
    const reader = appFor(T1, "reader");
    expect((await send(reader, "PUT", "/v1/theming/theme/draft", theme("No"))).status).toBe(404);
    expect((await send(reader, "POST", "/v1/theming/theme/publish", {})).status).toBe(404);
    expect((await reader.request("/v1/theming/theme")).status).toBe(200);
  });

  it("rejects a theme the schema does not accept", async () => {
    const app = appFor(T1, "writer");
    const res = await send(app, "PUT", "/v1/theming/theme/draft", {
      input: { ...PLATFORM_THEME, brand: { seed: "not a colour" } },
    });
    expect(res.status).toBe(422);
  });

  it("never shows one business the themes of another", async () => {
    const other = appFor(uuidv7(), "writer");
    const state = await body<State>(await other.request("/v1/theming/theme"));
    expect(state).toEqual({ published: null, draft: null });
    expect(
      (await body<{ versions: unknown[] }>(await other.request("/v1/theming/theme/versions")))
        .versions,
    ).toEqual([]);
  });
});

describe("receipt templates", () => {
  const blocks = [
    { type: "logo", align: "center" },
    { type: "business" },
    { type: "lines" },
    { type: "totals" },
    { type: "payments" },
    { type: "text", text: "Thank you" },
  ];
  const tpl = (over: Record<string, unknown> = {}) => ({
    paper: "80",
    invoicePrefix: "INV-",
    footerText: "Open daily",
    blocks,
    ...over,
  });

  it("creates the business template, then bumps its version on each save", async () => {
    const app = appFor(T1, "writer");
    const a = await send(app, "PUT", "/v1/theming/receipt-templates", tpl());
    expect(await body<{ version: number }>(a)).toMatchObject({ version: 1 });
    const b = await send(
      app,
      "PUT",
      "/v1/theming/receipt-templates",
      tpl({ version: 1, paper: "58" }),
    );
    expect(await body<{ version: number; paper: string }>(b)).toMatchObject({
      version: 2,
      paper: "58",
    });
  });

  it("refuses a save made from an old version", async () => {
    const app = appFor(T1, "writer");
    expect(
      (await send(app, "PUT", "/v1/theming/receipt-templates", tpl({ version: 1 }))).status,
    ).toBe(409);
  });

  it("keeps a separate override per branch and lists both", async () => {
    const app = appFor(T1, "writer");
    const branch = uuidv7();
    await send(
      app,
      "PUT",
      "/v1/theming/receipt-templates",
      tpl({ branchId: branch, invoicePrefix: "B1-" }),
    );
    const list = await body<{ templates: { branchId: string | null; invoicePrefix: string }[] }>(
      await app.request(`/v1/theming/receipt-templates?branchId=${branch}`),
    );
    expect(list.templates.map((t) => [t.branchId, t.invoicePrefix])).toEqual([
      [null, "INV-"],
      [branch, "B1-"],
    ]);
    // Without a branch only the business default comes back (other branches stay out of the answer).
    const base = await body<{ templates: unknown[] }>(
      await app.request("/v1/theming/receipt-templates"),
    );
    expect(base.templates).toHaveLength(1);
  });

  it("insists on the items and totals blocks and a clean invoice prefix", async () => {
    const app = appFor(T1, "writer");
    expect(
      (await send(app, "PUT", "/v1/theming/receipt-templates", tpl({ blocks: [{ type: "logo" }] })))
        .status,
    ).toBe(422);
    expect(
      (await send(app, "PUT", "/v1/theming/receipt-templates", tpl({ invoicePrefix: "inv 1" })))
        .status,
    ).toBe(422);
    expect(
      (
        await send(
          app,
          "PUT",
          "/v1/theming/receipt-templates",
          tpl({ blocks: [...blocks, { type: "script" }] }),
        )
      ).status,
    ).toBe(422);
  });

  it("is invisible to another business", async () => {
    const other = appFor(uuidv7(), "writer");
    expect(
      (await body<{ templates: unknown[] }>(await other.request("/v1/theming/receipt-templates")))
        .templates,
    ).toEqual([]);
  });
});
