import { MailError } from "@wise-biz/mailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/index.ts";

import {
  call,
  CONSOLE_URL,
  json,
  PASSWORD,
  signIn,
  startIdentity,
  SUBJECT_VERIFY,
  verifyLinkOf,
  waitForMail,
} from "./support/harness.ts";

import type { IdentityHarness } from "./support/harness.ts";
import type { IdentityPort } from "../src/index.ts";

let h: IdentityHarness;

beforeAll(async () => {
  h = await startIdentity();
});

afterAll(async () => {
  await h.close();
});

function signUp(identity: IdentityPort, email: string): Promise<Response> {
  return call(identity, "POST", "/sign-up/email", {
    body: { email, password: PASSWORD, name: "Verify Me" },
  });
}

describe("email verification", () => {
  it("sign-up creates no session and mails a verification link", async () => {
    const res = await signUp(h.identity, "newbie@example.com");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(SESSION_COOKIE_NAME))).toBe(false);
    const body = await json(res);
    expect(body.token).toBeNull();
    expect((body.user as { emailVerified: boolean }).emailVerified).toBe(false);

    const mail = await waitForMail(h.mailer, "newbie@example.com", SUBJECT_VERIFY);
    expect(verifyLinkOf(mail)).toContain("/v1/auth/verify-email?token=");
    expect(mail.text).toContain(CONSOLE_URL);
  });

  it("refuses sign-in until the emailed link is followed, and re-sends the link", async () => {
    const before = h.mailer.sent.length;
    const { res, jar } = await signIn(h, "newbie@example.com");
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("EMAIL_NOT_VERIFIED");
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    await waitForMail(h.mailer, "newbie@example.com", SUBJECT_VERIFY);
    expect(h.mailer.sent.length).toBeGreaterThan(before);
  });

  it("the link verifies the account, and sign-in then succeeds with a cookie", async () => {
    const mail = h.mailer.sent.filter((m) => m.to === "newbie@example.com").pop();
    if (!mail) throw new Error("no verification mail");
    const verify = await h.identity.handler(new Request(verifyLinkOf(mail)));
    expect(verify.status).toBeLessThan(400);

    const { rows } = await h.adminPool.query<{ email_verified: boolean }>(
      "SELECT email_verified FROM identity.users WHERE email = 'newbie@example.com'",
    );
    expect(rows[0]?.email_verified).toBe(true);

    const { res, jar } = await signIn(h, "newbie@example.com");
    expect(res.status).toBe(200);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);
  });

  it("answers an existing email exactly like a new one (status and body shape)", async () => {
    const fresh = await signUp(h.identity, "shape-new@example.com");
    const existing = await signUp(h.identity, "newbie@example.com");
    expect(existing.status).toBe(fresh.status);
    expect(existing.headers.getSetCookie()).toEqual(fresh.headers.getSetCookie());

    const a = await json(fresh);
    const b = await json(existing);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(Object.keys(b.user as object).sort()).toEqual(Object.keys(a.user as object).sort());
    expect(b.token).toBeNull();
    expect((b.user as { email: string }).email).toBe("newbie@example.com");
    // The existing account is untouched: still one row, still verified, password unchanged.
    const { rows } = await h.adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM identity.users WHERE email = 'newbie@example.com'",
    );
    expect(rows[0]?.n).toBe(1);
    expect((await signIn(h, "newbie@example.com")).res.status).toBe(200);
  });

  it("does not wait for a slow mail provider", async () => {
    const hanging = h.build({
      mailer: { send: () => new Promise<void>(() => undefined) },
    });
    const started = Date.now();
    const res = await signUp(hanging, "slow-mail@example.com");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps sign-up working when the provider fails, and logs only the error class", async () => {
    const failing = h.build({
      mailer: {
        send: () => Promise.reject(new MailError("smtp_ECONNREFUSED", true)),
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await signUp(failing, "failing-mail@example.com");
      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled();
      });
      const logged = spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).toContain("smtp_ECONNREFUSED");
      expect(logged).not.toContain("failing-mail@example.com");
      expect(logged).not.toMatch(/token|verify-email/i);
    } finally {
      spy.mockRestore();
    }
  });
});
