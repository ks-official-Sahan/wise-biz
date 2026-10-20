import { OpenAPIHono } from "@hono/zod-openapi";
import { DomainError, toProblem } from "@wise-biz/errors";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { describe, expect, it } from "vitest";

import { authorize, policyMiddleware, requireTenant } from "./index.ts";

import type { AppEnv, AuthContext } from "./index.ts";

const T = "01900000-0000-7000-8000-000000000001";
const U = "01900000-0000-7000-8000-000000000002";
const B1 = "01900000-0000-7000-8000-0000000000b1";
const B2 = "01900000-0000-7000-8000-0000000000b2";

const catalog = createCatalog(["t:read", "t:sell"]);
const matrix = matrixFromRows(catalog, [
  { role: "cashier", permission: "t:sell", conditions: { maxAmountMinor: 1000 } },
  { role: "manager", permission: "t:sell" },
]);

function build(auth: AuthContext, withPolicy = true): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", auth);
    await next();
  });
  if (withPolicy) app.use("*", policyMiddleware(matrix));
  app.get("/tenant", (c) => c.json(requireTenant(c)));
  app.get("/read", (c) => {
    authorize(c, "t:read");
    return c.json({ ok: true });
  });
  app.get("/sell/:amt", (c) => {
    authorize(c, "t:sell", { amountMinor: Number(c.req.param("amt")) });
    return c.json({ ok: true });
  });
  app.get("/branch", (c) => {
    authorize(c, "t:read", { branchId: B2 });
    return c.json({ ok: true });
  });
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    const details = err instanceof DomainError ? err.details : undefined;
    return c.json({ ...p, details }, p.status as 401);
  });
  return app;
}

const user = (roles: string[], branchScope: "all" | string[] = "all"): AuthContext => ({
  kind: "user",
  userId: U,
  tenantId: T,
  roles,
  branchScope,
});

describe("requireTenant", () => {
  it("401 for anonymous", async () => {
    const res = await build({ kind: "anonymous" }).request("/tenant");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHENTICATED");
  });

  it("returns tenant ctx for a user", async () => {
    const res = await build(user(["owner"])).request("/tenant");
    expect(await res.json()).toEqual({ tenantId: T, userId: U, requestId: "req-12345678" });
  });
});

describe("authorize", () => {
  it("allows a granted permission (owner has none registered => catalog check via matrix)", async () => {
    expect((await build(user(["owner"])).request("/read")).status).toBe(200);
  });

  it("not granted => 404", async () => {
    const res = await build(user(["cashier"])).request("/read");
    expect(res.status).toBe(404);
  });

  it("branch out of scope => 404", async () => {
    const res = await build(user(["owner"], [B1])).request("/branch");
    expect(res.status).toBe(404);
  });

  it("condition denial => 412 with approver roles override", async () => {
    const res = await build(user(["cashier"])).request("/sell/5000");
    expect(res.status).toBe(412);
    const body = (await res.json()) as { details: { override: { approverRoles: string[] } } };
    expect(body.details.override.approverRoles).toEqual(
      expect.arrayContaining(["manager", "owner"]),
    );
  });

  it("condition satisfied => 200", async () => {
    expect((await build(user(["cashier"])).request("/sell/500")).status).toBe(200);
  });

  it("anonymous => 401", async () => {
    expect((await build({ kind: "anonymous" }).request("/read")).status).toBe(401);
  });

  it("missing policy fails closed with 500", async () => {
    expect((await build(user(["owner"]), false).request("/read")).status).toBe(500);
  });
});

describe("authorize responses never leak details", () => {
  const leaks = ["t:sell", "maxAmount", "reason", "override", "approver", "manager", "details"];
  const problemOf = (err: unknown): string => JSON.stringify(toProblem(err, "r"));

  it("404 (not_granted) problem has no permission/reason", async () => {
    let caught: unknown;
    const app = build(user(["cashier"]));
    app.onError((err, c) => {
      caught = err;
      return c.json({});
    });
    await app.request("/read");
    await app.request("/branch");
    expect(caught).toBeInstanceOf(DomainError);
    const text = problemOf(caught);
    expect(text).toContain("NOT_FOUND");
    for (const l of ["t:read", "not_granted", "branch_out_of_scope", "reason"]) {
      expect(text).not.toContain(l);
    }
  });

  it("412 (condition) problem has no permission/reason/approver roles", async () => {
    let caught: unknown;
    const app = build(user(["cashier"]));
    app.onError((err, c) => {
      caught = err;
      return c.json({});
    });
    await app.request("/sell/5000");
    expect((caught as DomainError).code).toBe("PRECONDITION_FAILED");
    const text = problemOf(caught);
    for (const l of leaks) expect(text).not.toContain(l);
  });
});
