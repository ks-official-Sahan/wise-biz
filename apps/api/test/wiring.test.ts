import { createServer } from "node:net";
import { join } from "node:path";

import { migrate } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { startRedis, testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer } from "../src/server.ts";

import type { RunningServer } from "../src/server.ts";
import type { RedisHarness, TestDatabase } from "@wise-biz/testing/containers";

/**
 * Smoke test of the production wiring only (identity <- tenancy <- kernel through startServer). The full
 * acceptance flow lives in identity-tenancy.e2e.test.ts.
 */
const modulesDir = join(import.meta.dirname, "..", "..", "..", "modules");
const ORIGIN = "http://localhost:3000";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });

let redis: RedisHarness;
let db: TestDatabase;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  [redis, db] = await Promise.all([startRedis(), testDatabase()]);
  await migrate(
    db.url("migrator"),
    ["infra", "audit", "identity", "tenancy"].map((module) => ({
      module,
      dir: join(modulesDir, module, "migrations"),
    })),
  );
  server = await startServer({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: db.url("app"),
    DATABASE_IDENTITY_URL: db.url("identity"),
    AUTH_SECRET: "wiring-test-secret-".padEnd(40, "x"),
    AUTH_URL: "http://localhost:3001",
    CORS_ORIGINS: ORIGIN,
    REDIS_URL: redis.url,
    PORT: String(await freePort()),
  });
  base = `http://127.0.0.1:${String(server.port)}`;
});
afterAll(async () => {
  await server.close();
  await Promise.all([redis.stop(), db.drop()]);
});

describe("production wiring", () => {
  it("sign-up -> create business -> /me/tenants -> switch, with the real cookie and guards", async () => {
    const json = { "content-type": "application/json", origin: ORIGIN };
    const email = `wiring-${uuidv7()}@example.com`;
    const up = await fetch(`${base}/v1/auth/sign-up/email`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Wire", email, password: "correct-horse-battery-staple-91" }),
    });
    expect(up.status).toBe(200);
    const setCookie = up.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-wb_session=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toMatch(/domain=/i);
    const cookie = setCookie.split(";")[0] ?? "";

    const tenantId = uuidv7();
    const create = await fetch(`${base}/v1/tenancy/tenants`, {
      method: "POST",
      headers: { ...json, cookie, "idempotency-key": `k-${uuidv7()}` },
      body: JSON.stringify({
        tenantId,
        name: "Wire Co",
        branch: {
          name: "Main",
          kind: "store",
          timezone: "Asia/Colombo",
          currency: "LKR",
          taxRegion: "LK",
        },
      }),
    });
    expect(create.status).toBe(201);

    const mine = await fetch(`${base}/v1/tenancy/me/tenants`, { headers: { cookie } });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { tenants: { tenantId: string }[] }).tenants[0]?.tenantId).toBe(
      tenantId,
    );

    const evil = await fetch(`${base}/v1/tenancy/switch`, {
      method: "POST",
      headers: { ...json, cookie, origin: "https://evil.example" },
      body: JSON.stringify({ tenantId }),
    });
    expect(evil.status).toBe(403);
    const ok = await fetch(`${base}/v1/tenancy/switch`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ tenantId }),
    });
    expect(ok.status).toBe(204);

    const anon = await fetch(`${base}/v1/tenancy/me/tenants`);
    expect(anon.status).toBe(401);
  });
});
