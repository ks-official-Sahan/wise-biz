import { afterEach, describe, expect, it } from "vitest";

import { captureError, resetSentryForTests, scrubEvent, startSentry } from "../src/index.ts";

import type { SentryEventLike, SentryModule } from "../src/index.ts";

afterEach(() => {
  resetSentryForTests();
});

const DSN = "https://k@o1.ingest.sentry.io/1";
const ID = "0198f3a2-aaaa-7bbb-8ccc-1234567890ab";

function fake() {
  const calls: { init?: Record<string, unknown>; captured: unknown[]; closed: number[] } = {
    captured: [],
    closed: [],
  };
  const mod: SentryModule = {
    init: (o) => {
      calls.init = o;
    },
    captureException: (e, hint) => {
      calls.captured.push([e, hint]);
    },
    close: (t) => {
      calls.closed.push(t ?? 0);
      return Promise.resolve(true);
    },
  };
  return { mod, calls };
}

describe("startSentry", () => {
  it("does nothing without a DSN and never loads the SDK", async () => {
    const load = () => Promise.reject(new Error("not loaded"));
    expect(await startSentry({}, load, "api")).toBeUndefined();
    expect(await startSentry({ SENTRY_DSN: "" }, load, "api")).toBeUndefined();
    expect(() => {
      captureError(new Error("x"));
    }).not.toThrow();
  });

  it("starts errors-only with no PII, tracing or breadcrumbs, and flushes on stop", async () => {
    const { mod, calls } = fake();
    const stop = await startSentry(
      {
        SENTRY_DSN: DSN,
        NODE_ENV: "production",
        SENTRY_ENVIRONMENT: "staging",
        SENTRY_RELEASE: "v0.2.1",
      },
      () => Promise.resolve(mod),
      "wise-biz-api",
    );
    expect(calls.init).toMatchObject({
      dsn: DSN,
      environment: "staging",
      release: "v0.2.1",
      serverName: "wise-biz-api",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      skipOpenTelemetrySetup: true,
      maxBreadcrumbs: 0,
    });
    await stop?.();
    expect(calls.closed).toEqual([2000]);
  });

  it("falls back to NODE_ENV and omits the release when not given", async () => {
    const { mod, calls } = fake();
    await startSentry(
      { SENTRY_DSN: DSN, NODE_ENV: "production" },
      () => Promise.resolve(mod),
      "wise-biz-workers",
    );
    expect(calls.init?.environment).toBe("production");
    expect(calls.init).not.toHaveProperty("release");
  });

  it("applies the scrubber to every event", async () => {
    const { mod, calls } = fake();
    await startSentry({ SENTRY_DSN: DSN }, () => Promise.resolve(mod), "x");
    const beforeSend = calls.init?.beforeSend as (e: unknown) => { user?: unknown };
    expect(beforeSend({ user: { email: "a@b.co" } }).user).toBeUndefined();
  });

  it("reports a handled error with the request id as a tag", async () => {
    const { mod, calls } = fake();
    await startSentry({ SENTRY_DSN: DSN }, () => Promise.resolve(mod), "x");
    const err = new Error("boom");
    captureError(err, { requestId: "r-1" });
    captureError(err);
    expect(calls.captured).toEqual([
      [err, { tags: { request_id: "r-1" } }],
      [err, undefined],
    ]);
  });
});

describe("scrubEvent", () => {
  const scrub = (e: SentryEventLike): SentryEventLike => scrubEvent(e);

  it("keeps the error and the stack, masks ids and emails, and drops everything personal", () => {
    const input: SentryEventLike = {
      message: `no row for ${ID} owned by jane@shop.example`,
      exception: { values: [{ type: "Error", value: `bad ${ID} ${"x".repeat(500)}` }] },
      user: { id: "u", email: "jane@shop.example", ip_address: "1.2.3.4" },
      extra: { sale: { totalMinor: 1250 } },
      breadcrumbs: [{ message: "select * from sales" }],
      contexts: { device: { name: "till" } },
      request: {
        method: "POST",
        url: `https://api.example.test/v1/sales/${ID}?token=secret&q=jane`,
        headers: { authorization: "Bearer abc", cookie: "s=1" },
        data: { card: "4111111111111111" },
        query_string: "token=secret",
      },
    };
    const out = scrubEvent(input);
    expect(out.message).toBe("no row for <id> owned by <email>");
    expect(out.exception?.values?.[0]?.type).toBe("Error");
    expect(out.exception?.values?.[0]?.value).toHaveLength(300);
    expect(out.exception?.values?.[0]?.value).toContain("bad <id> ");
    expect(out).not.toHaveProperty("user");
    expect(out).not.toHaveProperty("extra");
    expect(out).not.toHaveProperty("breadcrumbs");
    expect(out).not.toHaveProperty("contexts");
    expect(out.request).toEqual({ method: "POST", url: "/v1/sales/<id>" });
    expect(JSON.stringify(out)).not.toMatch(/secret|Bearer|4111|jane@/);
  });

  it("masks a receipt code in the path", () => {
    expect(scrub({ request: { url: "https://x.test/r/AbC123xyz?lang=en" } }).request).toEqual({
      url: "/r/<code>",
    });
  });

  it("copes with an event that has no message, exception or request, and an unparsable url", () => {
    expect(scrub({})).toEqual({});
    expect(scrub({ request: { url: "http://[bad" } }).request).toEqual({});
    expect(scrub({ request: {} }).request).toEqual({});
    expect(scrub({ exception: { values: [{ type: "E" }] } }).exception?.values).toEqual([
      { type: "E" },
    ]);
  });
});
