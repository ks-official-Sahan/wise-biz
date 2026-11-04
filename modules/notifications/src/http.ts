import { createRoute } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { requireTenant, requireUser } from "@wise-biz/module-kit";

import {
  addPushToken,
  list,
  markRead,
  preferences,
  removePushToken,
  setPreferences,
  unreadCount,
} from "./queries.ts";
import {
  ListQuerySchema,
  ListSchema,
  MarkReadSchema,
  MarkedSchema,
  OkSchema,
  PreferencesSchema,
  PushTokenSchema,
  SetPreferencesSchema,
  UnreadSchema,
} from "./schemas.ts";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const ok = <T>(schema: T) => ({ 200: { description: "OK", ...json(schema) } });
const body = <T>(schema: T) => ({ body: { required: true, ...json(schema) } });
const tags = ["notifications"];

const routes = {
  list: createRoute({
    method: "get",
    path: "/v1/notifications",
    tags,
    summary: "My notifications, newest first",
    request: { query: ListQuerySchema },
    responses: ok(ListSchema),
  }),
  unread: createRoute({
    method: "get",
    path: "/v1/notifications/unread-count",
    tags,
    summary: "How many of my notifications are unread",
    responses: ok(UnreadSchema),
  }),
  read: createRoute({
    method: "post",
    path: "/v1/notifications/read",
    tags,
    summary: "Mark some (ids) or all of my notifications read",
    request: { ...body(MarkReadSchema) },
    responses: ok(MarkedSchema),
  }),
  getPrefs: createRoute({
    method: "get",
    path: "/v1/notifications/preferences",
    tags,
    summary: "What I want to be told about",
    responses: ok(PreferencesSchema),
  }),
  setPrefs: createRoute({
    method: "put",
    path: "/v1/notifications/preferences",
    tags,
    summary: "Change what I want to be told about",
    request: { ...body(SetPreferencesSchema) },
    responses: ok(PreferencesSchema),
  }),
  addToken: createRoute({
    method: "put",
    path: "/v1/notifications/push-tokens",
    tags,
    summary: "Register this phone for push",
    request: { ...body(PushTokenSchema) },
    responses: ok(OkSchema),
  }),
  removeToken: createRoute({
    method: "delete",
    path: "/v1/notifications/push-tokens",
    tags,
    summary: "Stop push to this phone",
    request: { ...body(PushTokenSchema.pick({ token: true })) },
    responses: ok(OkSchema),
  }),
};

/**
 * Self-service: each route acts for the signed-in person inside their business (RLS scopes the tenant, the queries scope
 * the person). Setting your own preferences and marking read are idempotent, so these skip the audit/outbox path that
 * business mutations use.
 */
export function mountRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps): void {
  const mine = <T>(
    c: Parameters<typeof requireTenant>[0],
    fn: (
      tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
      tenantId: string,
      userId: string,
    ) => Promise<T>,
  ) => {
    const tenant = requireTenant(c);
    const { userId } = requireUser(c);
    return withTenantTx(deps.pool, tenant, (tx) => fn(tx, tenant.tenantId, userId));
  };

  app.openapi(routes.list, async (c) => {
    const q = c.req.valid("query");
    return c.json(await mine(c, (tx, t, u) => list(tx, t, u, q)), 200);
  });
  app.openapi(routes.unread, async (c) =>
    c.json({ unread: await mine(c, (tx, t, u) => unreadCount(tx, t, u)) }, 200),
  );
  app.openapi(routes.read, async (c) => {
    const b = c.req.valid("json");
    const target = b.ids === undefined ? ({ all: true } as const) : { ids: b.ids };
    return c.json({ marked: await mine(c, (tx, t, u) => markRead(tx, t, u, target)) }, 200);
  });
  app.openapi(routes.getPrefs, async (c) =>
    c.json({ preferences: await mine(c, (tx, t, u) => preferences(tx, t, u)) }, 200),
  );
  app.openapi(routes.setPrefs, async (c) => {
    const b = c.req.valid("json");
    const auth = c.get("auth");
    const verified =
      auth.kind === "user" && auth.emailVerified === true ? (auth.email ?? null) : null;
    // Email goes only to an address the person has verified; asking for it without one is a clear error, not a silent skip.
    if (b.preferences.some((p) => p.email) && verified === null) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Verify your email address before turning on email notifications",
      );
    }
    const all = await mine(c, async (tx, t, u) => {
      await setPreferences(tx, t, u, b.preferences, verified);
      return preferences(tx, t, u);
    });
    return c.json({ preferences: all }, 200);
  });
  app.openapi(routes.addToken, async (c) => {
    const b = c.req.valid("json");
    await mine(c, (tx, t, u) => addPushToken(tx, t, u, b.token, b.platform));
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(routes.removeToken, async (c) => {
    const b = c.req.valid("json");
    await mine(c, (tx, t, u) => removePushToken(tx, t, u, b.token));
    return c.json({ ok: true as const }, 200);
  });
}
