import { Writable } from "node:stream";

import { createRoute, z } from "@hono/zod-openapi";
import { DomainError } from "@wise-biz/errors";
import { defineModule, authorize, requireTenant } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";

import type { ApiEnv, CreateAppOptions } from "../src/app.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, WbModule } from "@wise-biz/module-kit";
import type pg from "pg";

export const TENANT = "01900000-0000-7000-8000-000000000001";
export const USER = "01900000-0000-7000-8000-000000000002";

export const devHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "x-wb-dev-tenant": TENANT,
  "x-wb-dev-user": USER,
  ...extra,
});

const createItem = createRoute({
  method: "post",
  path: "/v1/probe/validate",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ name: z.string().min(1), lines: z.array(z.object({ qty: z.int() })) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "ok",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

export const probeModule = (opts: { devOnly?: boolean } = {}): WbModule =>
  defineModule({
    name: "probe",
    migrationsDir: "/tmp/probe/migrations",
    permissions: definePermissions("probe", ["read", "write"]),
    events: [],
    ...(opts.devOnly ? { devOnly: true } : {}),
    routes(app: OpenAPIHono<AppEnv>) {
      app.openapi(createItem, (c) => c.json({ ok: true }, 200));
      app.get("/v1/probe/domain", () => {
        throw new DomainError("CONFLICT", "already exists");
      });
      app.get("/v1/probe/crash", () => {
        throw new Error("secret internal detail");
      });
      app.get("/v1/probe/me", (c) => c.json(requireTenant(c)));
      app.get("/v1/probe/guarded", (c) => {
        authorize(c, "probe:write");
        return c.json({ ok: true });
      });
      app.get("/v1/probe/log", (c) => {
        c.get("logger").info(
          { headers: { authorization: c.req.header("authorization") } },
          "probe",
        );
        return c.json({ ok: true });
      });
    },
  });

export const okRedis = { ping: () => Promise.resolve("PONG") };
export const fakePool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;

export interface LogCapture {
  lines(): Record<string, unknown>[];
  raw(): string;
}

export function capture(): { stream: Writable; logs: LogCapture } {
  let buf = "";
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    logs: {
      raw: () => buf,
      lines: () =>
        buf
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>),
    },
  };
}

export const baseEnv: ApiEnv = {
  NODE_ENV: "test",
  API_DEV_AUTH: false,
  CORS_ORIGINS: ["https://app.test"],
};

export function build(over: Partial<CreateAppOptions> = {}): {
  app: OpenAPIHono<AppEnv>;
  logs: LogCapture;
} {
  const { stream, logs } = capture();
  const app = createApp({
    modules: [probeModule()],
    pool: fakePool,
    redis: okRedis,
    env: baseEnv,
    logger: createLogger("info", stream),
    ...over,
  });
  return { app, logs };
}
