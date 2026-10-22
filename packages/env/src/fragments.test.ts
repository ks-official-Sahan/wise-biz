import { describe, expect, it } from "vitest";

import {
  ALL_ENV_FRAGMENTS,
  assertProductionEnv,
  consoleEnv,
  demoSeedEnv,
  defineEnv,
  inviteEnv,
  mailEnv,
  webauthnEnv,
} from "./index.ts";

const SECRET32 = "k".repeat(32);
const mailGood = { MAIL_FROM: "no-reply@wise-biz.test" };
const prod = { NODE_ENV: "production", AUTH_SECRET: "x".repeat(40), EMAIL_PROVIDER: "smtp" };

describe("mailEnv", () => {
  it("requires a valid sender and parses an optional SMTP port", () => {
    expect(() => defineEnv(mailEnv, {})).toThrow(/MAIL_FROM: required/);
    expect(() => defineEnv(mailEnv, { MAIL_FROM: "not-an-address" })).toThrow(/MAIL_FROM/);
    const env = defineEnv(mailEnv, {
      ...mailGood,
      MAIL_SMTP_HOST: "localhost",
      MAIL_SMTP_PORT: "1025",
    });
    expect(env.MAIL_SMTP_PORT).toBe(1025);
    expect(env.MAIL_SMTP_HOST).toBe("localhost");
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("bounds the SMTP port", () => {
    for (const bad of ["0", "65536", "1.5", "x"]) {
      expect(() => defineEnv(mailEnv, { ...mailGood, MAIL_SMTP_PORT: bad })).toThrow(
        /MAIL_SMTP_PORT/,
      );
    }
  });

  it("reuses the RESEND_API_KEY schema from the email fragment", () => {
    const env = defineEnv(mailEnv, { ...mailGood, RESEND_API_KEY: "re_test_1" });
    expect(env.RESEND_API_KEY).toBe("re_test_1");
    expect(mailEnv.RESEND_API_KEY).toBe(ALL_ENV_FRAGMENTS.email.RESEND_API_KEY);
  });
});

describe("inviteEnv", () => {
  it("requires a secret of at least 32 characters", () => {
    expect(() => defineEnv(inviteEnv, {})).toThrow(/INVITE_SECRET: required/);
    expect(() => defineEnv(inviteEnv, { INVITE_SECRET: "k".repeat(31) })).toThrow(/INVITE_SECRET/);
    expect(defineEnv(inviteEnv, { INVITE_SECRET: SECRET32 }).INVITE_SECRET).toBe(SECRET32);
  });

  it("production rejects the .env.example placeholder and short values", () => {
    expect(() => {
      assertProductionEnv({
        ...prod,
        INVITE_SECRET: "dev-only-change-me-invite-secret-0123456789",
      });
    }).toThrow(/INVITE_SECRET: dev placeholder/);
    expect(() => {
      assertProductionEnv({ ...prod, INVITE_SECRET: "short" });
    }).toThrow(/INVITE_SECRET: too short/);
    expect(() => {
      assertProductionEnv({ ...prod, INVITE_SECRET: SECRET32 });
    }).not.toThrow();
  });
});

describe("consoleEnv", () => {
  it("requires an absolute URL", () => {
    expect(() => defineEnv(consoleEnv, {})).toThrow(/CONSOLE_URL: required/);
    expect(() => defineEnv(consoleEnv, { CONSOLE_URL: "console.local" })).toThrow(/CONSOLE_URL/);
    expect(defineEnv(consoleEnv, { CONSOLE_URL: "http://localhost:3001" }).CONSOLE_URL).toBe(
      "http://localhost:3001",
    );
  });
});

describe("webauthnEnv", () => {
  it("defaults the RP id to localhost", () => {
    expect(defineEnv(webauthnEnv, {}).AUTH_RP_ID).toBe("localhost");
  });

  it("accepts a bare hostname only", () => {
    expect(defineEnv(webauthnEnv, { AUTH_RP_ID: "shop.example.com" }).AUTH_RP_ID).toBe(
      "shop.example.com",
    );
    for (const bad of ["https://shop.example.com", "shop.example.com:443", "a..b", "-x.com"]) {
      expect(() => defineEnv(webauthnEnv, { AUTH_RP_ID: bad })).toThrow(/AUTH_RP_ID/);
    }
  });
});

describe("demoSeedEnv", () => {
  it("is optional with a minimum length", () => {
    expect(defineEnv(demoSeedEnv, {}).DEMO_PASSWORD).toBeUndefined();
    expect(() => defineEnv(demoSeedEnv, { DEMO_PASSWORD: "short" })).toThrow(/DEMO_PASSWORD/);
  });

  it("production refuses any demo password without echoing it", () => {
    const demo = "demo-pass-value-1234";
    try {
      assertProductionEnv({ ...prod, DEMO_PASSWORD: demo });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/DEMO_PASSWORD/);
      expect(String(error)).not.toContain(demo);
    }
  });
});

describe("registry", () => {
  it("includes every new fragment", () => {
    for (const key of ["mail", "invite", "console", "webauthn", "demoSeed"]) {
      expect(ALL_ENV_FRAGMENTS).toHaveProperty(key);
    }
  });
});
