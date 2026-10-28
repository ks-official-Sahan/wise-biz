import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { generateKeyPair, toBase64url } from "@wise-biz/crypto";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { signRequest } from "@wise-biz/http-signatures";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware, requireTerminal } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { codeHash, newEnrollmentCode, normaliseCode } from "../src/domain/device.ts";
import { createDevicesModule, deviceAuth } from "../src/index.ts";

import type { NonceStore } from "@wise-biz/http-signatures";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const BRANCH = uuidv7();
const OTHER_BRANCH = uuidv7();
const OWNER = uuidv7();
const GONE = uuidv7();
let userId = OWNER;
let nowMs = Date.UTC(2026, 9, 28, 12);
const clock = { now: () => nowMs };
const ids = { uuidv7 };

function nonceStore(): NonceStore {
  const seen = new Set<string>();
  return {
    claim: (k) => {
      if (seen.has(k)) return Promise.resolve(false);
      seen.add(k);
      return Promise.resolve(true);
    },
  };
}

const devicesModule = createDevicesModule({
  branchExists: (_tx, tenantId, branchId) => Promise.resolve(tenantId === T && branchId === BRANCH),
  nonces: nonceStore(),
  pin: {
    pepper: new TextEncoder().encode("test-pepper-test-pepper-test-pepper!"),
    isActiveMember: (_tx, tenantId, userId) => Promise.resolve(tenantId === T && userId !== GONE),
  },
});
const catalog = createCatalog(devicesModule.permissions);
const matrix = matrixFromRows(catalog, [
  { role: "owner", permission: "devices:read" },
  { role: "owner", permission: "devices:manage" },
  { role: "cashier", permission: "devices:read" },
]);

let pool: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;
let role: string | null = "owner";

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "devices", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  drop = async () => {
    await pool.end();
    await db.drop();
  };
  app = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set(
      "auth",
      role === null
        ? { kind: "anonymous" }
        : {
            kind: "user",
            userId,
            sessionId: "01900000-0000-7000-8000-0000000000aa",
            tenantId: T,
            roles: [role],
            branchScope: "all",
            permissionsVersion: 1,
          },
    );
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  app.use("*", deviceAuth({ pool, nonces: nonceStore(), clock }));
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  devicesModule.routes(app, { pool, clock, ids });
  // A selling route, as sales/sync will mount it.
  app.post("/v1/test/sell", (c) => c.json(requireTerminal(c), 200));
});
afterAll(async () => {
  await drop();
});

interface Terminal {
  deviceId: string;
  keys: ReturnType<typeof generateKeyPair>;
}

const json = async <T>(res: Response) => (await res.json()) as T;

async function signed(
  t: Terminal,
  method: string,
  path: string,
  body?: unknown,
  over: { deviceId?: string } = {},
) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = signRequest({
    method,
    path,
    body: text,
    deviceId: over.deviceId ?? t.deviceId,
    secretKey: t.keys.secretKey,
    now: Math.floor(nowMs / 1000),
  });
  return app.request(path, {
    method,
    headers: { ...headers, ...(text === undefined ? {} : { "content-type": "application/json" }) },
    ...(text === undefined ? {} : { body: text }),
  });
}

async function newCode(branchId = BRANCH): Promise<Response> {
  role = "owner";
  return app.request("/v1/devices/enrollment-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branchId, name: "Till 1" }),
  });
}

async function enrollTerminal(): Promise<Terminal> {
  const { code } = await json<{ code: string }>(await newCode());
  const t = { deviceId: uuidv7(), keys: generateKeyPair() };
  role = null;
  const res = await signed(t, "POST", "/v1/devices/enroll", {
    code,
    deviceId: t.deviceId,
    publicKey: toBase64url(t.keys.publicKey),
    platform: "android",
    appVersion: "1.0.0",
  });
  expect(res.status).toBe(201);
  return t;
}

const setStatus = (deviceId: string, status: string) => {
  role = "owner";
  return app.request(`/v1/devices/${deviceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
    body: JSON.stringify({ status }),
  });
};

const beat = { appVersion: "1.0.0", unsyncedCount: 0 };

describe("enrollment codes", () => {
  it("are Crockford base32, normalise look-alikes and hash stably", () => {
    const code = newEnrollmentCode(() => new Uint8Array([0, 1, 31, 32, 33, 63, 64, 255]));
    expect(code).toBe("01Z0-1Z0Z");
    expect(normaliseCode("o1z0 1zoz")).toBe("01Z01Z0Z");
    expect(normaliseCode("ABC-12")).toBeNull();
    expect(normaliseCode("UUUU-UUUU")).toBeNull();
    expect(codeHash("01Z01Z0Z")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("owner creates one for a known branch; unknown branch and non-managers get 404", async () => {
    const res = await newCode();
    expect(res.status).toBe(201);
    const body = await json<{ code: string; qr: string }>(res);
    expect(body.qr).toBe(`wb-enroll:${body.code}`);
    expect((await newCode(OTHER_BRANCH)).status).toBe(404);
    role = "cashier";
    const denied = await app.request("/v1/devices/enrollment-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branchId: BRANCH, name: "x" }),
    });
    expect(denied.status).toBe(404);
  });
});

describe("enroll", () => {
  it("redeems a code once with proof of possession, then the device is listed active", async () => {
    const t = await enrollTerminal();
    role = "owner";
    const list = await json<{ devices: { deviceId: string; status: string; branchId: string }[] }>(
      await app.request("/v1/devices"),
    );
    expect(list.devices.find((d) => d.deviceId === t.deviceId)).toMatchObject({
      status: "active",
      branchId: BRANCH,
    });
  });

  it("refuses a reused code, an expired code, an unsigned request or another key with the same 404", async () => {
    const { code } = await json<{ code: string }>(await newCode());
    role = null;
    const a = { deviceId: uuidv7(), keys: generateKeyPair() };
    const body = (t: Terminal) => ({
      code,
      deviceId: t.deviceId,
      publicKey: toBase64url(t.keys.publicKey),
      platform: "android",
      appVersion: "1.0.0",
    });
    // Signed by a different key than the one in the body.
    const liar = { deviceId: a.deviceId, keys: generateKeyPair() };
    const forged = await app.request("/v1/devices/enroll", {
      method: "POST",
      headers: {
        ...signRequest({
          method: "POST",
          path: "/v1/devices/enroll",
          body: JSON.stringify(body(a)),
          deviceId: a.deviceId,
          secretKey: liar.keys.secretKey,
          now: Math.floor(nowMs / 1000),
        }),
        "content-type": "application/json",
      },
      body: JSON.stringify(body(a)),
    });
    expect(forged.status).toBe(404);
    const unsigned = await app.request("/v1/devices/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(a)),
    });
    expect(unsigned.status).toBe(404);
    expect((await signed(a, "POST", "/v1/devices/enroll", body(a))).status).toBe(201);
    const b = { deviceId: uuidv7(), keys: generateKeyPair() };
    expect((await signed(b, "POST", "/v1/devices/enroll", body(b))).status).toBe(404); // used

    const { code: late } = await json<{ code: string }>(await newCode());
    role = null;
    nowMs += 16 * 60 * 1000;
    const c = { deviceId: uuidv7(), keys: generateKeyPair() };
    expect((await signed(c, "POST", "/v1/devices/enroll", { ...body(c), code: late })).status).toBe(
      404,
    );
    nowMs -= 16 * 60 * 1000;
  });
});

describe("signed requests", () => {
  it("an active terminal sends a heartbeat and may sell", async () => {
    const t = await enrollTerminal();
    const res = await signed(t, "POST", "/v1/devices/heartbeat", beat);
    expect(res.status).toBe(200);
    expect(await json<{ status: string }>(res)).toMatchObject({ status: "active" });
    expect((await signed(t, "POST", "/v1/test/sell", {})).status).toBe(200);
  });

  it("rejects an unknown device, a wrong key and a replay with 401", async () => {
    const t = await enrollTerminal();
    expect(
      (await signed(t, "POST", "/v1/devices/heartbeat", beat, { deviceId: uuidv7() })).status,
    ).toBe(401);
    expect(
      (await signed({ ...t, keys: generateKeyPair() }, "POST", "/v1/devices/heartbeat", beat))
        .status,
    ).toBe(401);
    const text = JSON.stringify(beat);
    const headers = {
      ...signRequest({
        method: "POST",
        path: "/v1/devices/heartbeat",
        body: text,
        deviceId: t.deviceId,
        secretKey: t.keys.secretKey,
        now: Math.floor(nowMs / 1000),
      }),
      "content-type": "application/json",
    };
    const send = () =>
      app.request("/v1/devices/heartbeat", { method: "POST", headers, body: text });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
  });

  it("unsigned requests to terminal routes get 401", async () => {
    role = null;
    const res = await app.request("/v1/devices/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(beat),
    });
    expect(res.status).toBe(401);
  });

  it("suspended: heartbeat still answers, selling is refused; reactivated sells again", async () => {
    const t = await enrollTerminal();
    expect((await setStatus(t.deviceId, "suspended")).status).toBe(200);
    const hb = await signed(t, "POST", "/v1/devices/heartbeat", beat);
    expect(await json<{ status: string }>(hb)).toMatchObject({ status: "suspended" });
    const sell = await signed(t, "POST", "/v1/test/sell", {});
    expect(sell.status).toBe(401);
    expect(await json<{ code: string }>(sell)).toMatchObject({ code: "DEVICE_INACTIVE" });
    expect((await setStatus(t.deviceId, "active")).status).toBe(200);
    expect((await signed(t, "POST", "/v1/test/sell", {})).status).toBe(200);
  });

  it("revoked: the next request gets DEVICE_REVOKED (wipe), and revoke is final", async () => {
    const t = await enrollTerminal();
    expect((await signed(t, "POST", "/v1/devices/heartbeat", beat)).status).toBe(200);
    expect((await setStatus(t.deviceId, "revoked")).status).toBe(200);
    const res = await signed(t, "POST", "/v1/devices/heartbeat", beat);
    expect(res.status).toBe(401);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "DEVICE_REVOKED" });
    expect((await setStatus(t.deviceId, "active")).status).toBe(409);
  });

  it("every status change is audited with an outbox event", async () => {
    const t = await enrollTerminal();
    await setStatus(t.deviceId, "suspended");
    const audit = await withTenantTx(pool, { tenantId: T, requestId: "r" }, (tx) =>
      tx.query<{ action: string }>(
        "select action from audit.audit_log where entity_id = $1 order by at",
        [t.deviceId],
      ),
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "devices.device.enrolled",
      "devices.device.suspended",
    ]);
  });
});

describe("operator PIN", () => {
  const setPin = (pin: string, as = OWNER) => {
    role = "owner";
    userId = as;
    return app.request("/v1/devices/pin", {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
      body: JSON.stringify({ pin }),
    });
  };
  const login = (t: Terminal, uid: string, pin: string) =>
    signed(t, "POST", "/v1/devices/pin-login", { userId: uid, pin });

  it("refuses short, long, repeated and sequential PINs", async () => {
    for (const pin of ["123", "123456789", "1111", "4567", "98765", "12ab"]) {
      expect((await setPin(pin)).status).toBe(422);
    }
  });

  it("is unique per business", async () => {
    const a = uuidv7();
    const b = uuidv7();
    expect((await setPin("4826", a)).status).toBe(200);
    expect((await setPin("4826", b)).status).toBe(422);
    expect((await setPin("4826", a)).status).toBe(200); // the same operator may set it again
  });

  it("unlocks an active terminal, and one operator at a time", async () => {
    const op = uuidv7();
    expect((await setPin("7391", op)).status).toBe(200);
    const t = await enrollTerminal();
    const first = await login(t, op, "7391");
    expect(first.status).toBe(201);
    const second = await login(t, op, "7391");
    const s2 = await json<{ sessionId: string }>(second);
    const open = await withTenantTx(pool, { tenantId: T, requestId: "r" }, (tx) =>
      tx.query<{ id: string }>(
        "select id from devices.operator_sessions where device_id = $1 and ended_at is null",
        [t.deviceId],
      ),
    );
    expect(open.rows.map((r) => r.id)).toEqual([s2.sessionId]);
    expect((await signed(t, "POST", "/v1/devices/pin-logout")).status).toBe(204);
  });

  it("locks after 5 wrong PINs; a supervisor unlock is audited", async () => {
    const op = uuidv7();
    await setPin("5072", op);
    const t = await enrollTerminal();
    for (let i = 0; i < 5; i++) expect((await login(t, op, "0000")).status).toBe(401);
    const locked = await login(t, op, "5072");
    expect(locked.status).toBe(401);
    expect((await json<{ detail: string }>(locked)).detail).toMatch(/locked/i);

    role = "owner";
    userId = OWNER;
    const unlock = await app.request(`/v1/devices/operators/${op}/pin/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unlock.status).toBe(200);
    expect((await login(t, op, "5072")).status).toBe(201);
    const audit = await withTenantTx(pool, { tenantId: T, requestId: "r" }, (tx) =>
      tx.query<{ action: string }>(
        "select action from audit.audit_log where entity_id = $1 order by at, id",
        [op],
      ),
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "devices.pin.set",
      ...Array.from({ length: 4 }, () => "devices.pin.failed"),
      "devices.pin.locked",
      "devices.pin.reset",
      "devices.operator.signed_in",
    ]);
  });

  it("refuses unknown operators, removed members and suspended terminals", async () => {
    const t = await enrollTerminal();
    expect((await login(t, uuidv7(), "7391")).status).toBe(401);
    await setPin("6183", GONE);
    expect((await login(t, GONE, "6183")).status).toBe(401);
    const op = uuidv7();
    await setPin("2958", op);
    await setStatus(t.deviceId, "suspended");
    const res = await login(t, op, "2958");
    expect(res.status).toBe(401);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "DEVICE_INACTIVE" });
  });
});
