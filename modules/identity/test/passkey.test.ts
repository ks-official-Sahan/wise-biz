import { isUuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/index.ts";

import {
  call,
  CookieJar,
  json,
  ORIGIN,
  RP_ID,
  signedInJar,
  signUpVerified,
  startIdentity,
} from "./support/harness.ts";
import { SoftAuthenticator } from "./support/soft-authenticator.ts";

import type { IdentityHarness } from "./support/harness.ts";

let h: IdentityHarness;

beforeAll(async () => {
  h = await startIdentity();
});

afterAll(async () => {
  await h.close();
});

const EMAIL = "passkey-user@example.com";

describe("passkeys", () => {
  const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
  let userId = "";

  it("registration requires a session", async () => {
    await signUpVerified(h, EMAIL);
    const res = await call(h.identity, "GET", "/passkey/generate-register-options");
    expect(res.status).toBe(401);
  });

  it("registers a passkey for the signed-in user, stored with a UUIDv7 id", async () => {
    const jar = await signedInJar(h, EMAIL);
    const s = await h.identity.getSession(jar.sessionHeaders());
    userId = s?.userId ?? "";
    expect(userId).not.toBe("");

    const optsRes = await call(h.identity, "GET", "/passkey/generate-register-options", { jar });
    expect(optsRes.status).toBe(200);
    const options = (await json(optsRes)) as {
      challenge: string;
      rp: { id: string; name: string };
    };
    expect(options.rp).toEqual({ id: RP_ID, name: "wise-biz" });

    const reg = await call(h.identity, "POST", "/passkey/verify-registration", {
      body: { response: authenticator.register(options.challenge), name: "Test key" },
      jar,
    });
    expect(reg.status).toBe(200);

    const { rows } = await h.adminPool.query<{
      id: string;
      user_id: string;
      credential_id: string;
      counter: number;
      device_type: string;
      backed_up: boolean;
      public_key: string;
      name: string | null;
    }>("SELECT * FROM identity.passkeys WHERE user_id = $1", [userId]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(isUuidv7(row?.id ?? "")).toBe(true);
    expect(row?.credential_id).toBe(authenticator.credentialId.toString("base64url"));
    expect(row?.device_type).toBe("singleDevice");
    expect(row?.backed_up).toBe(false);
    expect(row?.name).toBe("Test key");
    expect(row?.public_key.length).toBeGreaterThan(0);
  });

  /** Options and verify share one jar: the server keeps the challenge in a signed cookie between the two. */
  async function authenticateOptions(): Promise<{ jar: CookieJar; challenge: string }> {
    const jar = new CookieJar();
    const res = await call(h.identity, "GET", "/passkey/generate-authenticate-options", { jar });
    expect(res.status).toBe(200);
    return { jar, challenge: ((await json(res)) as { challenge: string }).challenge };
  }

  it("signs in with the passkey alone, and advances the signature counter", async () => {
    const { jar, challenge } = await authenticateOptions();
    const res = await call(h.identity, "POST", "/passkey/verify-authentication", {
      body: { response: authenticator.assert(challenge) },
      jar,
    });
    expect(res.status).toBe(200);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);

    const s = await h.identity.getSession(jar.sessionHeaders());
    expect(s?.userId).toBe(userId);
    expect(s?.email).toBe(EMAIL);

    const { rows } = await h.adminPool.query<{ counter: number }>(
      "SELECT counter FROM identity.passkeys WHERE user_id = $1",
      [userId],
    );
    expect(rows[0]?.counter).toBe(1);
  });

  it("refuses an assertion made for another origin", async () => {
    const { jar, challenge } = await authenticateOptions();
    const phishing = authenticator.assert(challenge, "https://evil.example");
    const res = await call(h.identity, "POST", "/passkey/verify-authentication", {
      body: { response: phishing },
      jar,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("refuses an assertion without user verification (possession alone is not enough)", async () => {
    const { jar, challenge } = await authenticateOptions();
    const res = await call(h.identity, "POST", "/passkey/verify-authentication", {
      body: { response: authenticator.assert(challenge, undefined, false) },
      jar,
    });
    expect(res.status).toBe(401);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("refuses a replayed assertion (the challenge is single-use)", async () => {
    const { jar, challenge } = await authenticateOptions();
    const assertion = authenticator.assert(challenge);
    const first = await call(h.identity, "POST", "/passkey/verify-authentication", {
      body: { response: assertion },
      jar,
    });
    expect(first.status).toBe(200);
    // Same jar, same challenge cookie: the challenge was consumed by the first verify.
    const replay = await call(h.identity, "POST", "/passkey/verify-authentication", {
      body: { response: assertion },
      jar,
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });
});
