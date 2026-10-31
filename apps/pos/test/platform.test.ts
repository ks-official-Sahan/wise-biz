import { fromBase64url, generateKeyPair, verify } from "@wise-biz/crypto";
import { fromBase64, signatureBase, verifyRequest } from "@wise-biz/http-signatures";
import { uuidv7 } from "@wise-biz/ids";
import { TransportError } from "@wise-biz/sync";
import { describe, expect, it } from "vitest";

import {
  createKeyStore,
  createPullTransport,
  createPushTransport,
  createServerClock,
  createSignedFetch,
  createTicketSource,
  enrollDevice,
  heartbeat,
  pinLogin,
  pinLogout,
  signedFetchFor,
} from "../src/platform/index.ts";

import type { DeviceIdentity, DeviceVault, FetchLike } from "../src/platform/index.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake API: records requests, answers from a script, and can verify signatures like the real kernel does. */
function fakeApi(
  answer: (req: Seen) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const seen: Seen[] = [];
  const fetchFn: FetchLike = (url, init) => {
    const req: Seen = { url, method: init.method, headers: init.headers, body: init.body };
    seen.push(req);
    const res = answer(req);
    const headers = new Map(Object.entries(res.headers ?? {}));
    return Promise.resolve({
      status: res.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: () => Promise.resolve(res.body === undefined ? "" : JSON.stringify(res.body)),
    });
  };
  return { seen, fetchFn };
}

const first = (list: readonly Seen[]): Seen => {
  const x = list[0];
  if (x === undefined) throw new Error("no request was made");
  return x;
};

const keys = generateKeyPair();
const deviceId = uuidv7();
const identity: DeviceIdentity = {
  deviceId,
  tenantId: uuidv7(),
  branchId: uuidv7(),
  secretKey: Buffer.from(keys.secretKey).toString("base64"),
};
const BASE = "https://api.test/";

async function verifies(req: Seen, publicKey: Uint8Array, nowMs: number) {
  const path = new URL(req.url).pathname;
  return verifyRequest({
    method: req.method,
    path,
    header: (n) => req.headers[n.toLowerCase()],
    body: new TextEncoder().encode(req.body ?? ""),
    publicKeyOf: () => Promise.resolve(publicKey),
    nonces: { claim: () => Promise.resolve(true) },
    now: Math.floor(nowMs / 1000),
  });
}

describe("signed fetch", () => {
  it("signs method, path, body digest, time and nonce exactly as the server verifies", async () => {
    const api = fakeApi(() => ({ status: 200, body: { ok: true } }));
    const f = signedFetchFor(identity, BASE, api.fetchFn, () => 1_800_000_000_000);
    const res = await f<{ ok: boolean }>("POST", "/v1/sync/commands", { body: { commands: [] } });
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    const req = first(api.seen);
    expect(req.url).toBe("https://api.test/v1/sync/commands");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(await verifies(req, keys.publicKey, 1_800_000_000_000)).toMatchObject({
      ok: true,
      deviceId,
    });
    // A different key, a changed body, or a changed path fails.
    expect(await verifies(req, generateKeyPair().publicKey, 1_800_000_000_000)).toMatchObject({
      ok: false,
    });
    expect(await verifies({ ...req, body: "{}" }, keys.publicKey, 1_800_000_000_000)).toMatchObject(
      { ok: false },
    );
    expect(signatureBase).toBeTypeOf("function");
  });

  it("uses fresh nonces and sends no body header on a GET", async () => {
    const api = fakeApi(() => ({ status: 200 }));
    const f = signedFetchFor(identity, BASE, api.fetchFn);
    await f("GET", "/v1/devices");
    await f("GET", "/v1/devices");
    expect(api.seen[0]?.headers["content-type"]).toBeUndefined();
    expect(api.seen[0]?.headers["x-wb-nonce"]).not.toBe(api.seen[1]?.headers["x-wb-nonce"]);
  });

  it("maps problem responses to TransportError with the API code and Retry-After", async () => {
    const api = fakeApi(() => ({
      status: 429,
      body: { code: "RATE_LIMITED", detail: "slow down" },
      headers: { "retry-after": "12" },
    }));
    const f = signedFetchFor(identity, BASE, api.fetchFn);
    const err = await f("GET", "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterMs: 12_000,
      message: "slow down",
    });
  });

  it("treats a network failure as status 0 and an unreadable error body as a plain HTTP error", async () => {
    const down = createSignedFetch({
      baseUrl: BASE,
      deviceId,
      secretKey: () => keys.secretKey,
      fetch: () => Promise.reject(new Error("offline")),
    });
    await expect(down("GET", "/x")).rejects.toMatchObject({ status: 0 });
    const html = fakeApi(() => ({ status: 502, headers: {} }));
    const f = signedFetchFor(identity, BASE, (u, i) =>
      html
        .fetchFn(u, i)
        .then((r) => ({ ...r, text: () => Promise.resolve("<html>bad gateway</html>") })),
    );
    await expect(f("GET", "/x")).rejects.toMatchObject({
      status: 502,
      code: undefined,
      message: "HTTP 502",
    });
    const weird = fakeApi(() => ({ status: 500, headers: { "retry-after": "soon" } }));
    await expect(signedFetchFor(identity, BASE, weird.fetchFn)("GET", "/x")).rejects.toMatchObject({
      retryAfterMs: undefined,
    });
  });

  it("returns a 304 only when the caller accepts it", async () => {
    const api = fakeApi(() => ({ status: 304, headers: { etag: 'W/"a"' } }));
    const f = signedFetchFor(identity, BASE, api.fetchFn);
    expect(await f("GET", "/x", { accept304: true })).toMatchObject({ status: 304, etag: 'W/"a"' });
    await expect(f("GET", "/x")).rejects.toMatchObject({ status: 304 });
  });
});

describe("transports", () => {
  it("pushes commands and returns the server's answer as is", async () => {
    const answer = { acks: [{ seq: 0, status: "applied" }], stopped: null, lastSeq: 0 };
    const api = fakeApi(() => ({ status: 200, body: answer }));
    const t = createPushTransport(signedFetchFor(identity, BASE, api.fetchFn));
    const cmd = {
      type: "open_shift",
      body: { meta: { deviceSeq: 0, prevHash: "a", hash: "b", signature: "c" } },
    };
    expect(await t.push([cmd])).toEqual(answer);
    expect(JSON.parse(api.seen[0]?.body ?? "{}")).toEqual({ commands: [cmd] });
  });

  it("pulls with a cursor, remembers the idle ETag and revalidates with it", async () => {
    let calls = 0;
    const api = fakeApi((req) => {
      calls++;
      if (req.headers["if-none-match"] === 'W/"idle"')
        return { status: 304, headers: { etag: 'W/"idle"' } };
      return {
        status: 200,
        body: { dataset: "prices", changes: [], nextCursor: "c1", hasMore: false },
        headers: { etag: 'W/"idle"' },
      };
    });
    const t = createPullTransport({
      signed: signedFetchFor(identity, BASE, api.fetchFn),
      download: () => Promise.resolve(new Uint8Array()),
    });
    const first = await t.changes("prices", "c0", 100);
    expect(first).toMatchObject({ nextCursor: "c1" });
    expect(api.seen[0]?.url).toBe(
      "https://api.test/v1/sync/changes?dataset=prices&limit=100&cursor=c0",
    );
    expect(await t.changes("prices", "c0", 100)).toBe("not_modified");
    expect(calls).toBe(2);
    // A different cursor has no remembered ETag.
    await t.changes("prices", undefined, 50);
    expect(api.seen[2]?.headers["if-none-match"]).toBeUndefined();
    expect(api.seen[2]?.url).toBe("https://api.test/v1/sync/changes?dataset=prices&limit=50");
  });

  it("does not remember the ETag of a page that carried changes", async () => {
    const api = fakeApi(() => ({
      status: 200,
      body: { dataset: "tax", changes: [{ entity: "x" }], nextCursor: "c2", hasMore: false },
      headers: { etag: 'W/"busy"' },
    }));
    const t = createPullTransport({
      signed: signedFetchFor(identity, BASE, api.fetchFn),
      download: () => Promise.resolve(new Uint8Array()),
    });
    await t.changes("tax", "c1", 10);
    await t.changes("tax", "c1", 10);
    expect(api.seen[1]?.headers["if-none-match"]).toBeUndefined();
  });

  it("asks for a bootstrap URL and a stream ticket", async () => {
    const api = fakeApi((req) =>
      req.url.includes("bootstrap")
        ? { status: 200, body: { cursor: "c9", url: "https://files.test/s.gz" } }
        : { status: 200, body: { token: "t", url: "https://rt.test" } },
    );
    const signed = signedFetchFor(identity, BASE, api.fetchFn);
    const t = createPullTransport({ signed, download: () => Promise.resolve(new Uint8Array([1])) });
    expect(await t.bootstrap("catalog")).toEqual({ cursor: "c9", url: "https://files.test/s.gz" });
    expect(api.seen[0]?.url).toBe("https://api.test/v1/sync/bootstrap?dataset=catalog");
    expect(await createTicketSource(signed)()).toEqual({ token: "t", url: "https://rt.test" });
    expect(api.seen[1]?.method).toBe("POST");
  });
});

describe("enrollment", () => {
  const memoryVault = () => {
    let saved: DeviceIdentity | undefined;
    const vault: DeviceVault = {
      load: () => Promise.resolve(saved),
      save: (i) => {
        saved = i;
        return Promise.resolve();
      },
      clear: () => {
        saved = undefined;
        return Promise.resolve();
      },
    };
    return { vault, saved: () => saved };
  };

  it("proves possession with the new key and stores the identity only after the server accepts", async () => {
    const m = memoryVault();
    const tenantId = uuidv7();
    const branchId = uuidv7();
    let body: { publicKey: string; deviceId: string; code: string } | undefined;
    const api = fakeApi((req) => {
      body = JSON.parse(req.body ?? "{}") as typeof body;
      return {
        status: 201,
        body: { deviceId: body?.deviceId, tenantId, branchId, name: "Till 1", status: "active" },
      };
    });
    const device = await enrollDevice({
      baseUrl: BASE,
      code: "ABCD-2345",
      platform: "android",
      appVersion: "1.0.0",
      vault: m.vault,
      fetch: api.fetchFn,
      now: () => 1_800_000_000_000,
    });
    expect(device).toMatchObject({ tenantId, branchId, name: "Till 1" });
    expect(api.seen[0]?.url).toBe("https://api.test/v1/devices/enroll");
    // The request verifies against the public key it announces: the secret never left the device.
    const pub = fromBase64url(body?.publicKey ?? "");
    expect(await verifies(first(api.seen), pub, 1_800_000_000_000)).toMatchObject({ ok: true });
    expect(m.saved()).toMatchObject({ deviceId: body?.deviceId, tenantId, branchId });
    expect(JSON.stringify(api.seen)).not.toContain(m.saved()?.secretKey ?? "unreachable");
  });

  it("leaves nothing behind when the server refuses the code", async () => {
    const m = memoryVault();
    const api = fakeApi(() => ({
      status: 404,
      body: { code: "NOT_FOUND", detail: "no such code" },
    }));
    await expect(
      enrollDevice({
        baseUrl: BASE,
        code: "ZZZZ-ZZZZ",
        platform: "web",
        appVersion: "1",
        vault: m.vault,
        fetch: api.fetchFn,
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(m.saved()).toBeUndefined();
  });
});

describe("key store, clock, session", () => {
  it("signs commands with the vault key; the signature verifies under the public key", async () => {
    const ks = createKeyStore(identity);
    const msg = new Uint8Array([1, 2, 3]);
    const sig = await ks.sign(msg);
    expect(verify(sig, msg, await ks.publicKey())).toBe(true);
    expect(await ks.publicKey()).toEqual(keys.publicKey);
    expect(fromBase64(identity.secretKey)).toHaveLength(32);
  });

  it("learns the server clock offset from heartbeats and applies it", async () => {
    let t = 1_000_000;
    const clock = createServerClock(() => t);
    expect(clock.now()).toBe(1_000_000);
    const api = fakeApi(() => ({
      status: 200,
      body: { status: "active", serverTime: new Date(1_000_000 + 420_000).toISOString() },
    }));
    const signed = signedFetchFor(identity, BASE, api.fetchFn, clock.now);
    const reply = await heartbeat(signed, clock, { appVersion: "1.0.0", unsyncedCount: 3 });
    expect(reply.status).toBe("active");
    expect(clock.offsetMs()).toBe(420_000);
    t += 1000;
    expect(clock.now()).toBe(1_000_000 + 1000 + 420_000);
    // A garbage server time leaves the offset alone.
    clock.observe("not a date");
    expect(clock.offsetMs()).toBe(420_000);
    expect(JSON.parse(api.seen[0]?.body ?? "{}")).toEqual({
      appVersion: "1.0.0",
      unsyncedCount: 3,
    });
  });

  it("logs an operator in and out with signed requests", async () => {
    const userId = uuidv7();
    const api = fakeApi((req) =>
      req.url.endsWith("pin-login")
        ? { status: 201, body: { sessionId: "s1", userId, expiresAt: "2026-01-01T12:00:00Z" } }
        : { status: 204 },
    );
    const signed = signedFetchFor(identity, BASE, api.fetchFn);
    expect(await pinLogin(signed, userId, "4821")).toMatchObject({ sessionId: "s1", userId });
    expect(JSON.parse(api.seen[0]?.body ?? "{}")).toEqual({ userId, pin: "4821" });
    await pinLogout(signed);
    expect(api.seen[1]?.url).toBe("https://api.test/v1/devices/pin-logout");
  });
});
