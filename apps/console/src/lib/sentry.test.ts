import { describe, expect, it } from "vitest";

import { buildCsp } from "./csp.ts";
import { consoleSentryOptions, sentryOrigin } from "./sentry.ts";

const DSN = "https://abc123@o1234.ingest.de.sentry.io/5678";

describe("sentryOrigin", () => {
  it("takes the ingest origin from a Sentry DSN", () => {
    expect(sentryOrigin(DSN)).toBe("https://o1234.ingest.de.sentry.io");
    expect(sentryOrigin("https://k@sentry.io/1")).toBe("https://sentry.io");
  });
  it("ignores anything that is not an https sentry.io DSN, so a bad value cannot widen the CSP", () => {
    for (const bad of [
      undefined,
      "",
      "not a url",
      "http://abc@o1.ingest.sentry.io/1",
      "https://abc@evil.example/1",
      "https://abc@sentry.io.evil.example/1",
    ]) {
      expect(sentryOrigin(bad)).toBeUndefined();
    }
  });
  it("is allowed in connect-src and nowhere else", () => {
    const csp = buildCsp("n", { dev: false, reportOrigin: sentryOrigin(DSN) ?? "" });
    expect(csp).toContain("connect-src 'self' https://o1234.ingest.de.sentry.io;");
    expect(buildCsp("n", { dev: false })).not.toContain("sentry");
  });
});

describe("consoleSentryOptions", () => {
  it("is off without a valid DSN", () => {
    expect(consoleSentryOptions(undefined)).toBeUndefined();
    expect(consoleSentryOptions("https://k@evil.example/1")).toBeUndefined();
  });
  it("reports errors only, with no tracing, breadcrumbs or default PII", () => {
    const o = consoleSentryOptions(DSN, { environment: "staging", release: "v1" }) ?? {};
    expect(o).toMatchObject({
      dsn: DSN,
      environment: "staging",
      release: "v1",
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
    });
    expect(consoleSentryOptions(DSN)).not.toHaveProperty("environment");
    expect(o).not.toHaveProperty("tracesSampleRate");
    expect(o).not.toHaveProperty("tracesSampler");
  });
  it("scrubs every event: no user, no query string, ids and emails masked", () => {
    const o = consoleSentryOptions(DSN) as { beforeSend: (e: unknown) => Record<string, unknown> };
    const out = o.beforeSend({
      user: { email: "a@b.co" },
      message: "failed for a@b.co",
      request: { method: "GET", url: "https://app.test/sales?token=SECRET" },
    });
    expect(out.user).toBeUndefined();
    expect(out.message).toBe("failed for <email>");
    expect(out.request).toEqual({ method: "GET", url: "/sales" });
  });
});
