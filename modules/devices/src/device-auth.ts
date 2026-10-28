import { DomainError } from "@wise-biz/errors";
import { verifyRequest } from "@wise-biz/http-signatures";

import { resolveDevice } from "./application/devices.ts";

import type { DeviceAuth } from "./application/devices.ts";
import type { NonceStore } from "@wise-biz/http-signatures";
import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";
import type pg from "pg";

/** Enrollment is signed with the key being enrolled, so the global check (key must be known) skips it. */
export const ENROLL_PATH = "/v1/devices/enroll";

export interface DeviceAuthDeps {
  pool: pg.Pool;
  /** Redis `SET NX EX` in production (fail closed: an error rejects the request). */
  nonces: NonceStore;
  clock: { now(): number };
}

/**
 * Kernel middleware. A request with a `signature` header must verify (RFC 9421 profile) against an enrolled device,
 * else 401: a bad signature never falls back to cookie auth. Unsigned requests pass with `device` unset. The device
 * row is read on every signed request (one indexed lookup), so a revoke applies to the very next request.
 */
export function deviceAuth(deps: DeviceAuthDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("device", undefined);
    if (c.req.header("signature") === undefined || c.req.path === ENROLL_PATH) {
      await next();
      return;
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    let found: DeviceAuth | null = null;
    const result = await verifyRequest({
      method: c.req.method,
      path: c.req.path,
      header: (n) => c.req.header(n),
      body,
      publicKeyOf: async (id) => {
        found = await resolveDevice(deps.pool, id, c.get("requestId"));
        return found?.publicKey ?? null;
      },
      nonces: deps.nonces,
      now: Math.floor(deps.clock.now() / 1000),
    });
    const device = found as DeviceAuth | null;
    if (!result.ok || device === null) {
      c.get("logger").info(
        { reason: result.ok ? "unknown_device" : result.reason },
        "device signature rejected",
      );
      throw new DomainError("UNAUTHENTICATED", "Invalid device signature");
    }
    c.set("device", {
      deviceId: device.deviceId,
      tenantId: device.tenantId,
      branchId: device.branchId,
      status: device.status,
    });
    await next();
  };
}

/** For the enroll route: the request must be signed by the key in its own body (proof of possession). */
export async function verifyEnrollSignature(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  deps: Pick<DeviceAuthDeps, "nonces" | "clock">,
  publicKey: Uint8Array,
  deviceId: string,
): Promise<boolean> {
  if (c.req.header("x-wb-device-id") !== deviceId) return false;
  const result = await verifyRequest({
    method: c.req.method,
    path: c.req.path,
    header: (n) => c.req.header(n),
    body: new Uint8Array(await c.req.arrayBuffer()),
    publicKeyOf: (id) => Promise.resolve(id === deviceId ? publicKey : null),
    nonces: deps.nonces,
    now: Math.floor(deps.clock.now() / 1000),
  });
  return result.ok;
}
