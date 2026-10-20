import { createPool, instrumentPool, migrate, countQueries } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { templateModule } from "@wise-biz/module-template";
import { startPostgres, testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";

import { baseEnv, okRedis } from "./helpers.ts";

import type { ApiEnv } from "../src/app.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const ITEMS = "/v1/template/items";
const env: ApiEnv = { ...baseEnv, API_DEV_AUTH: true };

let db: TestDatabase;
let pool: pg.Pool;
let app: OpenAPIHono<AppEnv>;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [{ module: "_template", dir: templateModule.migrationsDir }]);
  pool = createPool(db.url("app"), { max: 5 });
  instrumentPool(pool);
  app = createApp({
    modules: [templateModule],
    pool,
    redis: okRedis,
    env,
    logger: createLogger("silent"),
  });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

/** Each test gets its own tenant so shared-database state never leaks between cases. */
const freshTenant = (): string => uuidv7();

const devHeaders = (tenant: string, roles?: string): Record<string, string> => ({
  "x-wb-dev-tenant": tenant,
  "x-wb-dev-user": uuidv7(),
  ...(roles === undefined ? {} : { "x-wb-dev-roles": roles }),
});

const jsonHeaders = (tenant: string): Record<string, string> => ({
  ...devHeaders(tenant),
  "content-type": "application/json",
});

interface ItemDto {
  id: string;
  name: string;
  createdAt: string;
  children?: { id: string; label: string; createdAt: string }[];
}
interface PageDto {
  items: ItemDto[];
  nextCursor: string | null;
}
interface ProblemDto {
  code: string;
  status: number;
  requestId: string;
  errors?: { path: string; message: string }[];
}

async function createItem(tenant: string, name: string, children: string[] = []): Promise<ItemDto> {
  const res = await app.request(ITEMS, {
    method: "POST",
    headers: jsonHeaders(tenant),
    body: JSON.stringify({ name, children }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ItemDto;
}

async function listPage(tenant: string, query: string): Promise<PageDto> {
  const res = await app.request(`${ITEMS}?${query}`, { headers: devHeaders(tenant) });
  expect(res.status).toBe(200);
  return (await res.json()) as PageDto;
}

async function listAll(tenant: string, limit: number): Promise<ItemDto[]> {
  const out: ItemDto[] = [];
  let after: string | null = null;
  do {
    const q = `limit=${String(limit)}${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
    const page = await listPage(tenant, q);
    out.push(...page.items);
    after = page.nextCursor;
  } while (after !== null);
  return out;
}

describe("template items over HTTP", () => {
  it("tenant isolation: each tenant lists only its own items, and writes never cross", async () => {
    const a = freshTenant();
    const b = freshTenant();
    const aIds = new Set<string>();
    const bIds = new Set<string>();
    for (const name of ["a1", "a2", "a3"]) aIds.add((await createItem(a, name)).id);
    for (const name of ["b1", "b2"]) bIds.add((await createItem(b, name)).id);

    const aPage = await listPage(a, "limit=50");
    expect(new Set(aPage.items.map((i) => i.id))).toEqual(aIds);
    const bPage = await listPage(b, "limit=50");
    expect(new Set(bPage.items.map((i) => i.id))).toEqual(bIds);

    const bWalk = await listAll(b, 1);
    expect(bWalk).toHaveLength(2);
    for (const item of bWalk) expect(aIds.has(item.id)).toBe(false);

    await createItem(b, "b3");
    const aAfter = await listPage(a, "limit=50");
    expect(aAfter.items).toHaveLength(3);
    expect(new Set(aAfter.items.map((i) => i.id))).toEqual(aIds);
  });

  it("anonymous GET is 401 problem+json with code UNAUTHENTICATED", async () => {
    const res = await app.request(ITEMS);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(((await res.json()) as ProblemDto).code).toBe("UNAUTHENTICATED");
  });

  it("a role without template:read gets 404 (not 403)", async () => {
    const tenant = freshTenant();
    const res = await app.request(ITEMS, { headers: devHeaders(tenant, "cashier") });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(((await res.json()) as ProblemDto).code).toBe("NOT_FOUND");
  });

  it("include=children on 50 items costs 2 queries, plain list costs 1 (no N+1)", async () => {
    const tenant = freshTenant();
    for (let i = 0; i < 50; i++) {
      await createItem(tenant, `n${String(i)}`, ["c1", "c2"]);
    }

    const withChildren = await countQueries(async () => {
      const res = await app.request(`${ITEMS}?limit=50&include=children`, {
        headers: devHeaders(tenant),
      });
      return { status: res.status, body: (await res.json()) as PageDto };
    });
    expect(withChildren.result.status).toBe(200);
    expect(withChildren.result.body.items).toHaveLength(50);
    for (const item of withChildren.result.body.items) {
      expect(item.children).toHaveLength(2);
    }
    expect(withChildren.count).toBe(2);

    const plain = await countQueries(async () => {
      const res = await app.request(`${ITEMS}?limit=50`, { headers: devHeaders(tenant) });
      return { status: res.status, body: (await res.json()) as PageDto };
    });
    expect(plain.result.status).toBe(200);
    expect(plain.result.body.items).toHaveLength(50);
    expect(plain.count).toBe(1);
  });

  it("keyset pagination: 55 items, limit 50 then after=cursor yields 5 and no nextCursor", async () => {
    const tenant = freshTenant();
    const created = new Set<string>();
    for (let i = 0; i < 55; i++) created.add((await createItem(tenant, `p${String(i)}`)).id);

    const first = await listPage(tenant, "limit=50");
    expect(first.items).toHaveLength(50);
    expect(typeof first.nextCursor).toBe("string");

    const second = await listPage(
      tenant,
      `limit=50&after=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(seen)).toEqual(created);
  });

  it("POST with a blank name is 422 VALIDATION_FAILED with errors[].path 'name'", async () => {
    const res = await app.request(ITEMS, {
      method: "POST",
      headers: jsonHeaders(freshTenant()),
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as ProblemDto;
    expect(problem.code).toBe("VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("name");
  });

  it("GET with an unknown include value is 422", async () => {
    const res = await app.request(`${ITEMS}?include=unknown`, {
      headers: devHeaders(freshTenant()),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ProblemDto).code).toBe("VALIDATION_FAILED");
  });
});

describe("/ready against a real Postgres that is stopped", () => {
  it("200 while postgres is up, 503 with no error text once it is stopped", async () => {
    const pg = await startPostgres();
    try {
      await pg.createDatabase("ready_probe");
      const readyPool = createPool(pg.url("ready_probe", "app"), {
        max: 1,
        connectionTimeoutMs: 2000,
      });
      const probeApp = createApp({
        modules: [],
        pool: readyPool,
        redis: okRedis,
        env,
        logger: createLogger("silent"),
      });
      try {
        const up = await probeApp.request("/ready");
        expect(up.status).toBe(200);
        expect(await up.json()).toEqual({
          status: "ready",
          checks: { db: "ok", redis: "ok" },
        });

        await pg.stop();

        // /ready caches its result for 1 s (single-flight), so poll until the outage is visible.
        let down = await probeApp.request("/ready");
        for (const deadline = Date.now() + 5_000; down.status !== 503 && Date.now() < deadline;) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          down = await probeApp.request("/ready");
        }
        expect(down.status).toBe(503);
        const raw = await down.text();
        expect(JSON.parse(raw)).toEqual({
          status: "unavailable",
          checks: { db: "fail", redis: "ok" },
        });
        expect(raw).not.toMatch(/ECONN|wb_app|password|127\.0\.0\.1|postgres/i);
      } finally {
        await readyPool.end().catch(() => undefined);
      }
    } finally {
      await pg.stop().catch(() => undefined);
    }
  }, 90_000);
});
