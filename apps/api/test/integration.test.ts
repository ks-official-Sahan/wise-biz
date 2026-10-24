import { createServer } from "node:net";

import { createPool } from "@wise-biz/db";
import { startRedis, testDatabase } from "@wise-biz/testing/containers";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";
import { startServer } from "../src/server.ts";

import { baseEnv, headerAuth, probeModule } from "./helpers.ts";

import type { RedisHarness, TestDatabase } from "@wise-biz/testing/containers";

let redis: RedisHarness;
let db: TestDatabase;
beforeAll(async () => {
  [redis, db] = await Promise.all([startRedis(), testDatabase()]);
});
afterAll(async () => {
  await Promise.all([redis.stop(), db.drop()]);
});

const AUTH_SECRET = "test-secret-".padEnd(40, "x");

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

describe("ready against real services", () => {
  it("200 with live postgres and redis, 503 when the pool points at a dead port", async () => {
    const client = createClient({ url: redis.url });
    await client.connect();
    const pool = createPool(db.url("app"), { max: 2 });
    const mk = (p: typeof pool) =>
      createApp({
        modules: [probeModule()],
        pool: p,
        redis: client,
        env: baseEnv,
        auth: headerAuth,
        logger: createLogger("silent"),
      });
    try {
      const ok = await mk(pool).request("/ready");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: "ready", checks: { db: "ok", redis: "ok" } });

      const dead = createPool("postgres://wb_app:wb_app@127.0.0.1:1/none", {
        max: 1,
        connectionTimeoutMs: 300,
      });
      try {
        const bad = await mk(dead).request("/ready");
        expect(bad.status).toBe(503);
        expect(await bad.json()).toEqual({
          status: "unavailable",
          checks: { db: "fail", redis: "ok" },
        });
      } finally {
        await dead.end();
      }
    } finally {
      await pool.end();
      await client.close();
    }
  });
});

describe("startServer", () => {
  it("listens, serves /health and /ready, then shuts down gracefully", async () => {
    const port = await freePort();
    const server = await startServer({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: db.url("app"),
      DATABASE_IDENTITY_URL: db.url("identity"),
      AUTH_SECRET: AUTH_SECRET,
      AUTH_URL: "http://localhost:3001",
      MAIL_FROM: "no-reply@wise-biz.local",
      INVITE_SECRET: "integration-invite-secret-".padEnd(40, "x"),
      CONSOLE_URL: "http://localhost:3001",
      REDIS_URL: redis.url,
      PORT: String(port),
    });
    try {
      expect(server.port).toBe(port);
      const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(health.status).toBe(200);
      // Readiness is false until Redis has connected (no offline queue), so poll briefly instead of racing boot.
      let readyStatus = 0;
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        readyStatus = (await fetch(`http://127.0.0.1:${String(port)}/ready`)).status;
        if (readyStatus === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 1100)); // past the 1 s ready cache
      }
      expect(readyStatus).toBe(200);
    } finally {
      await server.close();
    }
    await server.close(); // idempotent
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow();
  });

  it("boots with an unreachable Redis: /health 200, /ready 503 within 2 s", async () => {
    const port = await freePort();
    const started = Date.now();
    const server = await startServer({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: db.url("app"),
      DATABASE_IDENTITY_URL: db.url("identity"),
      AUTH_SECRET: AUTH_SECRET,
      AUTH_URL: "http://localhost:3001",
      MAIL_FROM: "no-reply@wise-biz.local",
      INVITE_SECRET: "integration-invite-secret-".padEnd(40, "x"),
      CONSOLE_URL: "http://localhost:3001",
      REDIS_URL: "redis://127.0.0.1:1",
      PORT: String(port),
    });
    try {
      const base = `http://127.0.0.1:${String(port)}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "unavailable",
        checks: { db: "ok", redis: "fail" },
      });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await server.close();
    }
  });

  it("releases the pool and redis when listen fails", async () => {
    const port = await freePort();
    const base = {
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: db.url("app"),
      DATABASE_IDENTITY_URL: db.url("identity"),
      AUTH_SECRET: AUTH_SECRET,
      AUTH_URL: "http://localhost:3001",
      MAIL_FROM: "no-reply@wise-biz.local",
      INVITE_SECRET: "integration-invite-secret-".padEnd(40, "x"),
      CONSOLE_URL: "http://localhost:3001",
      REDIS_URL: redis.url,
      PORT: String(port),
    };
    const first = await startServer(base);
    try {
      await expect(startServer(base)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });

  it("still enforces the production env guard", async () => {
    await expect(
      startServer({
        NODE_ENV: "production",
        AUTH_SECRET,
        EMAIL_PROVIDER: "capture",
        DATABASE_URL: db.url("app"),
        DATABASE_IDENTITY_URL: db.url("identity"),
        AUTH_URL: "https://api.example.com",
        REDIS_URL: redis.url,
      }),
    ).rejects.toThrow(/EMAIL_PROVIDER/);
  });
});
