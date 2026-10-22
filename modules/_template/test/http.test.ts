import { OpenAPIHono } from "@hono/zod-openapi";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { templateModule } from "../src/index.ts";

import { clock, ids, setup } from "./helpers.ts";

import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const T = uuidv7();
const catalog = createCatalog(templateModule.permissions);
const matrix = matrixFromRows(catalog, [
  { role: "reader", permission: "template:read" },
  { role: "writer", permission: "template:read" },
  { role: "writer", permission: "template:write" },
]);

let pool: pg.Pool;
let drop: () => Promise<void>;
let appFor: (role: string) => OpenAPIHono<AppEnv>;

beforeAll(async () => {
  ({ pool, drop } = await setup());
  appFor = (role) => {
    // Same 422 mapping apps/api installs as defaultHook.
    const app = new OpenAPIHono<AppEnv>({
      defaultHook: (r) => {
        if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
      },
    });
    app.use("*", async (c, next) => {
      c.set("requestId", "req-12345678");
      c.set("auth", {
        kind: "user",
        userId: uuidv7(),
        sessionId: "01900000-0000-7000-8000-0000000000aa",
        tenantId: T,
        roles: [role],
        branchScope: "all",
        permissionsVersion: 1,
      });
      await next();
    });
    app.use("*", policyMiddleware(matrix));
    app.onError((err, c) => {
      const p = toProblem(err, "r");
      return c.json(p, p.status as 404);
    });
    templateModule.routes(app, { pool, clock, ids });
    return app;
  };
});
afterAll(async () => {
  await drop();
});

const post = (app: OpenAPIHono<AppEnv>, body: unknown) =>
  app.request("/v1/template/items", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
    body: JSON.stringify(body),
  });

describe("http", () => {
  it("writer creates (201) then lists with include=children", async () => {
    const app = appFor("writer");
    const created = await post(app, { name: " Mug ", children: ["a", "b"] });
    expect(created.status).toBe(201);
    const res = await app.request("/v1/template/items?include=children&limit=10");
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: { name: string; children: unknown[] }[] };
    expect(page.items[0]).toMatchObject({ name: "Mug" });
    expect(page.items[0]?.children).toHaveLength(2);
  });

  it("reader cannot write: 404 before any validation", async () => {
    expect((await post(appFor("reader"), { not: "valid" })).status).toBe(404);
  });

  it("422 for blank name and for a non-allowlisted include", async () => {
    const app = appFor("writer");
    expect((await post(app, { name: "   " })).status).toBe(422);
    expect((await app.request("/v1/template/items?include=secrets")).status).toBe(422);
  });
});
