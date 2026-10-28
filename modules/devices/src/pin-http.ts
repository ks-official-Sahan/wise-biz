import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { requireTerminal, runCommand } from "@wise-biz/module-kit";

import { pinLogin, pinLogout, resetPinCommand, setPinCommand } from "./application/pins.ts";

import type { PinDeps } from "./application/pins.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");

export const SetPinSchema = z
  .object({ pin: z.string().min(1).max(16) })
  .strict()
  .openapi("SetPin");
export const PinLoginSchema = z
  .object({ userId: uuid7, pin: z.string().min(1).max(16) })
  .strict()
  .openapi("PinLogin");
const OperatorSessionSchema = z
  .object({ sessionId: z.string(), userId: z.string(), expiresAt: z.string() })
  .openapi("OperatorSession");

const setPinRoute = createRoute({
  method: "put",
  path: "/v1/devices/pin",
  tags: ["devices"],
  summary: "Set or change my operator PIN for the active business",
  request: { body: { required: true, ...json(SetPinSchema) } },
  responses: {
    200: { description: "Set", ...json(z.object({ set: z.boolean(), setAt: z.string() })) },
  },
});

const resetRoute = createRoute({
  method: "post",
  path: "/v1/devices/operators/{userId}/pin/unlock",
  tags: ["devices"],
  summary: "Supervisor: unlock an operator PIN after 5 failed tries",
  request: { params: z.object({ userId: uuid7 }) },
  responses: { 200: { description: "Unlocked", ...json(z.object({ reset: z.boolean() })) } },
});

const loginRoute = createRoute({
  method: "post",
  path: "/v1/devices/pin-login",
  tags: ["devices"],
  summary:
    "Terminal: unlock for one operator with their PIN (request signed by an active terminal)",
  request: { body: { required: true, ...json(PinLoginSchema) } },
  responses: {
    201: { description: "Operator session on this terminal", ...json(OperatorSessionSchema) },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/v1/devices/pin-logout",
  tags: ["devices"],
  summary: "Terminal: end the operator session",
  responses: { 204: { description: "Ended" } },
});

export function mountPinRoutes(app: OpenAPIHono<AppEnv>, deps: ModuleDeps, pin: PinDeps): void {
  app.openapi(setPinRoute, async (c) => {
    const res = await runCommand(c, deps, {
      permission: "devices:pin",
      input: SetPinSchema,
      // A replay would keep the PIN in infra.idempotency_keys' request hash input only; the body holds no PIN.
      handler: (tx, body, ctx) => setPinCommand(tx, ctx, body.pin, pin),
    });
    return res as never;
  });

  app.openapi(resetRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const res = await runCommand(c, deps, {
      permission: "devices:unlock",
      input: z.object({}).strict(),
      idempotency: "optional",
      handler: (tx, _body, ctx) => resetPinCommand(tx, ctx, userId),
    });
    return res as never;
  });

  app.openapi(loginRoute, async (c) => {
    const device = requireTerminal(c);
    const body = c.req.valid("json");
    const now = new Date(deps.clock.now());
    const requestId = c.get("requestId");
    // The failed attempt (counter + audit row) commits before the 401.
    const result = await withTenantTx(deps.pool, { tenantId: device.tenantId, requestId }, (tx) =>
      pinLogin(tx, device, body, { ...pin, ids: deps.ids, now, requestId }),
    );
    if (!result.ok) {
      throw new DomainError(
        "UNAUTHENTICATED",
        result.locked ? "PIN locked. Ask a supervisor to unlock it." : "Wrong PIN.",
      );
    }
    return c.json(
      { sessionId: result.sessionId, userId: result.userId, expiresAt: result.expiresAt },
      201,
    );
  });

  app.openapi(logoutRoute, async (c) => {
    const device = requireTerminal(c);
    const requestId = c.get("requestId");
    await withTenantTx(deps.pool, { tenantId: device.tenantId, requestId }, (tx) =>
      pinLogout(tx, device, new Date(deps.clock.now()), requestId),
    );
    return c.body(null, 204);
  });
}
