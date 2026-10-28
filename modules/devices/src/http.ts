import { createRoute, z } from "@hono/zod-openapi";
import { withTenantTx } from "@wise-biz/db";
import { authorize, requireDevice, requireTenant, runCommand } from "@wise-biz/module-kit";

import {
  createEnrollmentCodeCommand,
  enroll,
  listDevices,
  recordHeartbeat,
  updateDeviceCommand,
} from "./application/devices.ts";
import { ENROLL_PATH, verifyEnrollSignature } from "./device-auth.ts";
import { mountPinRoutes } from "./pin-http.ts";
import {
  CreateEnrollmentCodeSchema,
  DeviceListSchema,
  DeviceSchema,
  EnrollSchema,
  EnrollmentCodeSchema,
  HeartbeatReplySchema,
  HeartbeatSchema,
  UpdateDeviceSchema,
} from "./schemas.ts";

import type { BranchExists } from "./application/devices.ts";
import type { PinDeps } from "./application/pins.ts";
import type { DeviceAuthDeps } from "./device-auth.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, ModuleDeps } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

export interface DevicesHttpOptions {
  branchExists: BranchExists;
  nonces: DeviceAuthDeps["nonces"];
  /** Operator PINs: the server pepper and a membership check (tenancy owns memberships). */
  pin: PinDeps;
}

/** authorize runs BEFORE validation, so an unauthorized caller gets 404 without learning the body shape. */
const needs =
  (permission: "devices:read" | "devices:manage"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    authorize(c, permission);
    await next();
  };

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const DeviceIdParam = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
});

const createCodeRoute = createRoute({
  method: "post",
  path: "/v1/devices/enrollment-codes",
  tags: ["devices"],
  summary: "Create a one-time code that enrolls one terminal into a branch (15 minutes)",
  middleware: [needs("devices:manage")] as const,
  request: { body: { required: true, ...json(CreateEnrollmentCodeSchema) } },
  responses: { 201: { description: "Code, shown once", ...json(EnrollmentCodeSchema) } },
});

const enrollRoute = createRoute({
  method: "post",
  path: ENROLL_PATH,
  tags: ["devices"],
  summary: "Terminal: redeem a code with a new Ed25519 key (request signed with that key)",
  request: { body: { required: true, ...json(EnrollSchema) } },
  responses: { 201: { description: "Enrolled and active", ...json(DeviceSchema) } },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/devices",
  tags: ["devices"],
  summary: "List the business's terminals",
  middleware: [needs("devices:read")] as const,
  responses: { 200: { description: "Terminals", ...json(DeviceListSchema) } },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/v1/devices/{id}",
  tags: ["devices"],
  summary: "Rename, move, suspend, reactivate, revoke or blacklist a terminal",
  middleware: [needs("devices:manage")] as const,
  request: { params: DeviceIdParam, body: { required: true, ...json(UpdateDeviceSchema) } },
  responses: { 200: { description: "Updated", ...json(DeviceSchema) } },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/v1/devices/heartbeat",
  tags: ["devices"],
  summary: "Terminal: report health; the reply carries the device status and server time",
  request: { body: { required: true, ...json(HeartbeatSchema) } },
  responses: { 200: { description: "Recorded", ...json(HeartbeatReplySchema) } },
});

export function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ModuleDeps,
  opts: DevicesHttpOptions,
): void {
  app.openapi(createCodeRoute, async (c) => {
    // No idempotency: a replay would store the plain code in infra.idempotency_keys. A retry just makes a new code.
    const res = await runCommand(c, deps, {
      permission: "devices:manage",
      input: CreateEnrollmentCodeSchema,
      idempotency: "off",
      resource: (b) => ({ branchId: b.branchId }),
      handler: (tx, body, ctx) => createEnrollmentCodeCommand(tx, ctx, body, opts.branchExists),
    });
    return res as never;
  });

  app.openapi(enrollRoute, async (c) => {
    const body = c.req.valid("json");
    const device = await enroll(
      {
        pool: deps.pool,
        ids: deps.ids,
        clock: deps.clock,
        verifyPossession: (publicKey) =>
          verifyEnrollSignature(
            c,
            { nonces: opts.nonces, clock: deps.clock },
            publicKey,
            body.deviceId,
          ),
      },
      body,
      c.get("requestId"),
    );
    return c.json(device, 201);
  });

  app.openapi(listRoute, async (c) => {
    const tenant = requireTenant(c);
    const devices = await withTenantTx(deps.pool, tenant, (tx) => listDevices(tx, tenant.tenantId));
    return c.json({ devices }, 200);
  });

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid("param");
    const res = await runCommand(c, deps, {
      permission: "devices:manage",
      input: UpdateDeviceSchema,
      handler: (tx, body, ctx) => updateDeviceCommand(tx, ctx, id, body, opts.branchExists),
    });
    return res as never;
  });

  app.openapi(heartbeatRoute, async (c) => {
    const device = requireDevice(c);
    const body = c.req.valid("json");
    const now = new Date(deps.clock.now());
    await withTenantTx(
      deps.pool,
      { tenantId: device.tenantId, requestId: c.get("requestId") },
      (tx) => recordHeartbeat(tx, device, body, now),
    );
    return c.json({ status: device.status, serverTime: now.toISOString() }, 200);
  });
  mountPinRoutes(app, deps, opts.pin);
}
