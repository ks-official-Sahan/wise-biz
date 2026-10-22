import { isUuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/index.ts";

import {
  call,
  CookieJar,
  json,
  otpOf,
  PASSWORD,
  signIn,
  signedInJar,
  signUpVerified,
  startIdentity,
  SUBJECT_OTP,
} from "./support/harness.ts";

import type { CaptureMailer, IdentityHarness } from "./support/harness.ts";

let h: IdentityHarness;

beforeAll(async () => {
  h = await startIdentity();
});

afterAll(async () => {
  await h.close();
});

/** Waits for the next OTP mail to `to` sent after index `sentBefore`, and returns its code. */
async function nextOtp(mailer: CaptureMailer, to: string, sentBefore: number): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const mails = mailer.sent
      .slice(sentBefore)
      .filter((m) => m.to === to && m.subject === SUBJECT_OTP);
    const last = mails[mails.length - 1];
    if (last) return otpOf(last);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no OTP mail captured");
}

async function sendOtp(jar: CookieJar): Promise<number> {
  const before = h.mailer.sent.length;
  const res = await call(h.identity, "POST", "/two-factor/send-otp", { body: {}, jar });
  expect(res.status).toBe(200);
  return before;
}

async function userRow(email: string): Promise<{ id: string; two_factor_enabled: boolean }> {
  const { rows } = await h.adminPool.query<{ id: string; two_factor_enabled: boolean }>(
    "SELECT id, two_factor_enabled FROM identity.users WHERE email = $1",
    [email],
  );
  if (!rows[0]) throw new Error("no user");
  return rows[0];
}

/** Enrols `email` in email-OTP 2FA through the real flow, returns the signed-in jar. */
async function enrol(email: string): Promise<CookieJar> {
  await signUpVerified(h, email);
  const jar = await signedInJar(h, email);
  const enable = await call(h.identity, "POST", "/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  expect(enable.status).toBe(200);
  const sent = await sendOtp(jar);
  const code = await nextOtp(h.mailer, email, sent);
  const confirm = await call(h.identity, "POST", "/two-factor/verify-otp", {
    body: { code },
    jar,
  });
  expect(confirm.status).toBe(200);
  expect((await userRow(email)).two_factor_enabled).toBe(true);
  return jar;
}

describe("email OTP second factor", () => {
  const EMAIL = "mfa-flow@example.com";
  let signedIn: CookieJar;

  it("enabling requires the password", async () => {
    await signUpVerified(h, EMAIL);
    signedIn = await signedInJar(h, EMAIL);
    const res = await call(h.identity, "POST", "/two-factor/enable", {
      body: { password: "Wrong-Password-77" },
      jar: signedIn,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await userRow(EMAIL)).two_factor_enabled).toBe(false);
    const { rows } = await h.adminPool.query(
      "SELECT 1 FROM identity.two_factors WHERE user_id = $1",
      [(await userRow(EMAIL)).id],
    );
    expect(rows).toHaveLength(0);
  });

  it("enables with the password, and only after an emailed code is confirmed", async () => {
    const enable = await call(h.identity, "POST", "/two-factor/enable", {
      body: { password: PASSWORD },
      jar: signedIn,
    });
    expect(enable.status).toBe(200);
    const user = await userRow(EMAIL);
    expect(user.two_factor_enabled).toBe(false);
    const { rows } = await h.adminPool.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM identity.two_factors WHERE user_id = $1",
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(isUuidv7(rows[0]?.id ?? "")).toBe(true);

    const sent = await sendOtp(signedIn);
    const code = await nextOtp(h.mailer, EMAIL, sent);
    const confirm = await call(h.identity, "POST", "/two-factor/verify-otp", {
      body: { code },
      jar: signedIn,
    });
    expect(confirm.status).toBe(200);
    expect((await userRow(EMAIL)).two_factor_enabled).toBe(true);
  });

  it("sign-in returns a two-factor challenge and no session", async () => {
    const { res, jar } = await signIn(h, EMAIL);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.twoFactorRedirect).toBe(true);
    expect(body.twoFactorMethods).toContain("otp");
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    // The plugin clears the session cookie it just set (empty value); no live session token is issued.
    const liveSession = res.headers
      .getSetCookie()
      .filter(
        (c) =>
          c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.split(";")[0] !== `${SESSION_COOKIE_NAME}=`,
      );
    expect(liveSession).toHaveLength(0);
  });

  it("the challenge completes with the emailed code, and yields a session", async () => {
    const challenge = new CookieJar();
    const first = await call(h.identity, "POST", "/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      jar: challenge,
    });
    expect((await json(first)).twoFactorRedirect).toBe(true);

    const sent = await sendOtp(challenge);
    const code = await nextOtp(h.mailer, EMAIL, sent);
    const verify = await call(h.identity, "POST", "/two-factor/verify-otp", {
      body: { code },
      jar: challenge,
    });
    expect(verify.status).toBe(200);
    expect(challenge.has(SESSION_COOKIE_NAME)).toBe(true);
    const s = await h.identity.getSession(challenge.sessionHeaders());
    expect(s?.email).toBe(EMAIL);
    expect(s?.emailVerified).toBe(true);
  });

  it("a wrong code is refused and does not sign in", async () => {
    const challenge = new CookieJar();
    await call(h.identity, "POST", "/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      jar: challenge,
    });
    const sent = await sendOtp(challenge);
    const code = await nextOtp(h.mailer, EMAIL, sent);
    const wrong = code === "000000" ? "111111" : "000000";
    const res = await call(h.identity, "POST", "/two-factor/verify-otp", {
      body: { code: wrong },
      jar: challenge,
    });
    expect(res.status).toBe(401);
    expect(challenge.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("disabling requires the password", async () => {
    // With 2FA on, password sign-in only issues a challenge: finish it to get a session.
    const jar = new CookieJar();
    await call(h.identity, "POST", "/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      jar,
    });
    const sent = await sendOtp(jar);
    const code = await nextOtp(h.mailer, EMAIL, sent);
    expect(
      (await call(h.identity, "POST", "/two-factor/verify-otp", { body: { code }, jar })).status,
    ).toBe(200);
    const bad = await call(h.identity, "POST", "/two-factor/disable", {
      body: { password: "Wrong-Password-77" },
      jar,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await userRow(EMAIL)).two_factor_enabled).toBe(true);
    const ok = await call(h.identity, "POST", "/two-factor/disable", {
      body: { password: PASSWORD },
      jar,
    });
    expect(ok.status).toBe(200);
    expect((await userRow(EMAIL)).two_factor_enabled).toBe(false);
  });
});

describe("OTP attempts and storage", () => {
  const EMAIL = "mfa-lock@example.com";

  it("five wrong codes lock the challenge: no further attempt, right code included, signs in", async () => {
    await enrol(EMAIL);
    const challenge = new CookieJar();
    await call(h.identity, "POST", "/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      jar: challenge,
    });
    const sent = await sendOtp(challenge);
    const code = await nextOtp(h.mailer, EMAIL, sent);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await call(h.identity, "POST", "/two-factor/verify-otp", {
        body: { code: wrong },
        jar: challenge,
      });
      expect(res.status, `attempt ${String(attempt)}`).toBe(401);
    }

    const sixth = await call(h.identity, "POST", "/two-factor/verify-otp", {
      body: { code },
      jar: challenge,
    });
    expect(sixth.status).toBeGreaterThanOrEqual(400);
    expect(challenge.has(SESSION_COOKIE_NAME)).toBe(false);

    const seventh = await call(h.identity, "POST", "/two-factor/verify-otp", {
      body: { code },
      jar: challenge,
    });
    expect(seventh.status).toBeGreaterThanOrEqual(400);
    expect(challenge.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it("stores only a hash of the code, never the code itself", async () => {
    const challenge = new CookieJar();
    await call(h.identity, "POST", "/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      jar: challenge,
    });
    const sent = await sendOtp(challenge);
    const code = await nextOtp(h.mailer, EMAIL, sent);
    const { rows } = await h.adminPool.query<{ value: string }>(
      "SELECT value FROM identity.verifications WHERE identifier LIKE '2fa-otp-%' ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).not.toContain(code);
    // SHA-256 as base64url (43 chars, no padding), then the attempt counter.
    expect(rows[0]?.value).toMatch(/^[A-Za-z0-9_-]{43}:\d+$/);
  });
});
