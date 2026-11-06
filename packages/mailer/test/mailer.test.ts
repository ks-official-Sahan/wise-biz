import { createServer } from "node:net";

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MailError,
  createCaptureMailer,
  createMailer,
  mailerLogHooks,
  redactCopy,
} from "../src/index.ts";
import { smtpTransportOptions } from "../src/mailer.ts";

import type { MailEnv } from "../src/index.ts";
import type { AddressInfo, Server, Socket } from "node:net";

const base: MailEnv = { MAIL_FROM: "no-reply@wise-biz.local" };
const msg = {
  to: "jane@example.com",
  subject: "Verify your email",
  text: "Open the link: https://x.test/v?t=SECRET",
};

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** Minimal SMTP relay: no AUTH, no STARTTLS. Records recipients and accepted messages. */
async function fakeSmtp(
  refuseRcpt = false,
): Promise<{ port: number; received: string[]; rcpt: string[] }> {
  const received: string[] = [];
  const rcpt: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let data = "";
    socket.write("220 localhost ready\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\r\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\r\n");
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(data);
            data = "";
            socket.write("250 queued\r\n");
          } else {
            data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250 localhost\r\n");
        else if (verb === "RCPT") {
          rcpt.push(line);
          socket.write(refuseRcpt ? "550 no such user\r\n" : "250 ok\r\n");
        } else if (verb === "MAIL" || verb === "RSET" || verb === "NOOP") {
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 end with .\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 not implemented\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  return { port: (server.address() as AddressInfo).port, received, rcpt };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("createCaptureMailer", () => {
  it("records sent mail with a generated html body and clears on demand", async () => {
    const mailer = createCaptureMailer();
    await mailer.send(msg);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toEqual({
      to: "jane@example.com",
      subject: "Verify your email",
      text: msg.text,
      html: "<p>Open the link: https://x.test/v?t=SECRET</p>",
    });
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
  });

  it("lets programmer errors (not guard rejections) propagate unchanged", async () => {
    const mailer = createCaptureMailer();
    const bad = { ...msg, subject: 42 } as unknown as { to: string; subject: string; text: string };
    await expect(mailer.send(bad)).rejects.toThrow(TypeError);
  });

  it("keeps caller html and escapes the generated one", async () => {
    const mailer = createCaptureMailer();
    await mailer.send({ ...msg, html: "<a href='x'>go</a>" });
    await mailer.send({ ...msg, text: "<b>&\nnext" });
    expect(mailer.sent[0]?.html).toBe("<a href='x'>go</a>");
    expect(mailer.sent[1]?.html).toBe("<p>&lt;b&gt;&amp;<br>next</p>");
  });

  it("rejects header injection and malformed recipients before recording", async () => {
    const mailer = createCaptureMailer();
    const cases = [
      { ...msg, to: "jane@example.com\r\nBcc: spy@evil.test" },
      { ...msg, subject: "Hi\r\nBcc: spy@evil.test" },
      { ...msg, subject: "Hi\nBcc: spy@evil.test" },
      { ...msg, to: "not-an-address" },
      { ...msg, to: "" },
    ];
    for (const bad of cases) {
      const error = await rejection(mailer.send(bad));
      expect(error).toBeInstanceOf(MailError);
      expect(String(error)).not.toMatch(/spy@evil|Bcc|SECRET/);
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it("rejects any subject containing a line break (property)", async () => {
    const mailer = createCaptureMailer();
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 40 }),
        fc.constantFrom("\r", "\n", "\0", " ", " "),
        fc.string({ maxLength: 40 }),
        async (a, brk, b) => {
          const error = await rejection(mailer.send({ ...msg, subject: `${a}${brk}${b}` }));
          expect(error).toBeInstanceOf(MailError);
        },
      ),
      { numRuns: 100 },
    );
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("createMailer provider selection", () => {
  it("sends through plain SMTP (no AUTH, no TLS) when MAIL_SMTP_HOST is set", async () => {
    const smtp = await fakeSmtp();
    const mailer = createMailer({
      ...base,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: smtp.port,
    });
    await mailer.send(msg);
    expect(smtp.rcpt).toEqual(["RCPT TO:<jane@example.com>"]);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]).toContain("Subject: Verify your email");
    expect(smtp.received[0]).toContain("Open the link: https://x.test/v?t=SECRET");
  });

  it("classifies an unreachable SMTP host as retryable, without addresses in the error", async () => {
    const mailer = createMailer({
      ...base,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: await freePort(),
    });
    const error = await rejection(mailer.send(msg));
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).errorClass).toMatch(/^smtp_/);
    expect((error as MailError).retryable).toBe(true);
    expect(String(error)).not.toContain("jane@example.com");
  });

  it("classifies an SMTP recipient refusal from the relay", async () => {
    const smtp = await fakeSmtp(true);
    const mailer = createMailer({
      ...base,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: smtp.port,
    });
    const error = await rejection(mailer.send(msg));
    expect((error as MailError).errorClass).toMatch(/^smtp_/);
    expect(smtp.received).toHaveLength(0);
  });

  it("maps a Resend API failure to a classified, redacted MailError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ name: "validation_error", message: "bad" }, { status: 422 }),
        ),
      ),
    );
    const mailer = createMailer({ ...base, RESEND_API_KEY: "re_test_key" });
    const error = await rejection(mailer.send(msg));
    expect((error as MailError).errorClass).toMatch(/^resend_/);
    expect(String(error)).not.toContain("re_test_key");
    expect(String(error)).not.toContain("jane@example.com");
  });

  it("uses Resend when only RESEND_API_KEY is set", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ id: "re_msg_1" }, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({ ...base, RESEND_API_KEY: "re_test_key" });
    await mailer.send(msg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "no-reply@wise-biz.local",
      to: ["jane@example.com"],
      subject: "Verify your email",
    });
  });

  it("prefers SMTP when both providers are configured", async () => {
    const smtp = await fakeSmtp();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({
      ...base,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: smtp.port,
      RESEND_API_KEY: "re_test_key",
    });
    await mailer.send(msg);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(smtp.received).toHaveLength(1);
  });

  it("refuses to start in production without a provider", () => {
    expect(() => createMailer({ ...base, NODE_ENV: "production" })).toThrow(MailError);
  });

  it("fails each send loudly outside production without a provider", async () => {
    const mailer = createMailer({ ...base, NODE_ENV: "development" });
    const error = await rejection(mailer.send(msg));
    expect((error as MailError).errorClass).toBe("no_provider_configured");
  });

  it("validates the sender at construction", () => {
    expect(() => createMailer({ MAIL_FROM: "bad\r\nBcc: x@y.test" })).toThrow(/MAIL_FROM/);
  });
});

describe("SMTP transport security", () => {
  it("production never sends in cleartext: implicit TLS on 465, required STARTTLS elsewhere", () => {
    expect(smtpTransportOptions("smtp.x", 465, true)).toMatchObject({
      secure: true,
      requireTLS: false,
    });
    expect(smtpTransportOptions("smtp.x", 587, true)).toMatchObject({
      secure: false,
      requireTLS: true,
    });
    expect(smtpTransportOptions("smtp.x", undefined, true)).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });

  it("other environments use opportunistic STARTTLS (Mailpit has none)", () => {
    expect(smtpTransportOptions("localhost", 1025, false)).toMatchObject({
      secure: false,
      requireTLS: false,
    });
  });
});

const ok = (id: string) => Promise.resolve(Response.json({ id, messageId: id }, { status: 200 }));
const fail = (status: number, name = "error") =>
  Promise.resolve(Response.json({ name, code: name, message: "x" }, { status }));
const urlOf = (call: unknown[]) => String(call[0]);
const bodyOf = (call: unknown[]) =>
  JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;

describe("providers and fallback", () => {
  it("sends through the Brevo API with the Brevo sender", async () => {
    const fetchMock = vi.fn(() => ok("b1"));
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({
      ...base,
      BREVO_API_KEY: "xkeysib-test",
      BREVO_EMAIL_SENDER_USER: "support@wise-biz.local",
    });
    await mailer.send(msg);
    const call = fetchMock.mock.calls[0] as unknown as unknown[];
    expect(urlOf(call)).toBe("https://api.brevo.com/v3/smtp/email");
    expect(new Headers((call[1] as RequestInit).headers).get("api-key")).toBe("xkeysib-test");
    expect(JSON.stringify(bodyOf(call))).toContain("support@wise-biz.local");
  });

  it("in auto mode moves to the next provider when one fails for an account reason", async () => {
    const fetchMock = vi.fn((url: string) =>
      url.includes("brevo.com") ? fail(401, "unauthorized") : ok("r1"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onFallback = vi.fn();
    const mailer = createMailer(
      { ...base, BREVO_API_KEY: "xkeysib-bad", RESEND_API_KEY: "re_test_key" },
      { onFallback },
    );
    await mailer.send(msg);
    expect(fetchMock.mock.calls.map((c) => urlOf(c as unknown[]))).toEqual([
      "https://api.brevo.com/v3/smtp/email",
      "https://api.resend.com/emails",
    ]);
    expect(onFallback).toHaveBeenCalledWith("brevo-api", expect.any(String));
  });

  it("stops at a failure about the message itself instead of trying every provider", async () => {
    const fetchMock = vi.fn(() => fail(400, "invalid_parameter"));
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({
      ...base,
      BREVO_API_KEY: "xkeysib-test",
      RESEND_API_KEY: "re_test_key",
    });
    const error = await rejection(mailer.send(msg));
    expect((error as MailError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses only the named provider when EMAIL_PROVIDER names one", async () => {
    const fetchMock = vi.fn(() => ok("r1"));
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({
      ...base,
      EMAIL_PROVIDER: "resend",
      BREVO_API_KEY: "xkeysib-test",
      RESEND_API_KEY: "re_test_key",
    });
    await mailer.send(msg);
    expect(urlOf(fetchMock.mock.calls[0] as unknown[])).toBe("https://api.resend.com/emails");
    const none = createMailer({ ...base, EMAIL_PROVIDER: "brevo-api", RESEND_API_KEY: "re_k" });
    expect(((await rejection(none.send(msg))) as MailError).errorClass).toBe(
      "no_provider_configured",
    );
  });

  it("puts the providers in EMAIL_PROVIDER_ORDER first", async () => {
    const fetchMock = vi.fn(() => ok("r1"));
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({
      ...base,
      EMAIL_PROVIDER_ORDER: ["resend"],
      BREVO_API_KEY: "xkeysib-test",
      RESEND_API_KEY: "re_test_key",
    });
    await mailer.send(msg);
    expect(urlOf(fetchMock.mock.calls[0] as unknown[])).toBe("https://api.resend.com/emails");
  });

  it("configures Brevo SMTP from the BREVO_EMAIL_* keys and falls back to it last", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fail(401, "unauthorized")),
    );
    const mailer = createMailer({
      ...base,
      BREVO_API_KEY: "xkeysib-bad",
      BREVO_EMAIL_HOST: "127.0.0.1",
      BREVO_EMAIL_PORT: await freePort(),
      BREVO_EMAIL_USE_TLS: false,
      BREVO_EMAIL_HOST_USER: "user@smtp-brevo.com",
      BREVO_EMAIL_HOST_PASSWORD: "xsmtpsib-test",
    });
    const error = await rejection(mailer.send(msg));
    // the API was refused, then the SMTP attempt reached the unreachable relay
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).errorClass).not.toBe("no_provider_configured");
    expect(String(error)).not.toContain("xsmtpsib-test");
  });

  it("skips a provider that reached its daily limit", async () => {
    const fetchMock = vi.fn((url: string) => ok(url.includes("brevo") ? "b" : "r"));
    vi.stubGlobal("fetch", fetchMock);
    const mailer = createMailer({
      ...base,
      BREVO_API_KEY: "xkeysib-test",
      RESEND_API_KEY: "re_test_key",
      BREVO_DAILY_LIMIT: 1,
    });
    await mailer.send(msg);
    await mailer.send(msg);
    expect(fetchMock.mock.calls.map((c) => urlOf(c as unknown[]))).toEqual([
      "https://api.brevo.com/v3/smtp/email",
      "https://api.resend.com/emails",
    ]);
  });

  it("keeps mail in memory with EMAIL_PROVIDER=capture outside production", async () => {
    const mailer = createMailer({ ...base, EMAIL_PROVIDER: "capture", NODE_ENV: "development" });
    await mailer.send(msg);
  });
});

describe("CC and BCC", () => {
  const withCopies = {
    MAIL_CC_EMAILS: ["boss@example.com"],
    MAIL_BCC_EMAILS: ["audit@example.com"],
  };

  it("full mode puts real CC and BCC on the one mail, on any provider", async () => {
    const smtp = await fakeSmtp();
    await createMailer({
      ...base,
      ...withCopies,
      MAIL_COPY_MODE: "full",
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: smtp.port,
    }).send(msg);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.rcpt).toEqual([
      "RCPT TO:<jane@example.com>",
      "RCPT TO:<boss@example.com>",
      "RCPT TO:<audit@example.com>",
    ]);
    expect(smtp.received[0]).toContain("Open the link: https://x.test/v?t=SECRET");

    const fetchMock = vi.fn(() => ok("r1"));
    vi.stubGlobal("fetch", fetchMock);
    await createMailer({
      ...base,
      ...withCopies,
      MAIL_COPY_MODE: "full",
      RESEND_API_KEY: "re_test_key",
    }).send(msg);
    expect(bodyOf(fetchMock.mock.calls[0] as unknown as unknown[])).toMatchObject({
      to: ["jane@example.com"],
      cc: ["boss@example.com"],
      bcc: ["audit@example.com"],
    });
  });

  it("redacted mode (the default) sends the original untouched and a separate copy with no link or code", async () => {
    const smtp = await fakeSmtp();
    await createMailer({
      ...base,
      ...withCopies,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: smtp.port,
    }).send({ ...msg, text: "Code 123456. Open https://x.test/v?t=SECRET" });
    expect(smtp.received).toHaveLength(2);
    expect(smtp.received[0]).toContain("https://x.test/v?t=SECRET");
    // the original reaches only the real recipient
    expect(smtp.rcpt.slice(0, 1)).toEqual(["RCPT TO:<jane@example.com>"]);
    // the copy goes to the sender, with every copy address hidden in BCC
    expect(smtp.rcpt.slice(1)).toEqual([
      "RCPT TO:<no-reply@wise-biz.local>",
      "RCPT TO:<boss@example.com>",
      "RCPT TO:<audit@example.com>",
    ]);
    const copy = smtp.received[1] ?? "";
    expect(copy).toContain("[Copy] Verify your email");
    expect(copy).not.toContain("SECRET");
    expect(copy).not.toContain("123456");
    expect(copy).toContain("[link removed]");
    expect(copy).toContain("[code removed]");
  });

  it("never fails the original mail when the copy fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => (++calls === 1 ? ok("r1") : fail(500, "application_error"))),
    );
    const onCopyError = vi.fn();
    const mailer = createMailer(
      { ...base, ...withCopies, RESEND_API_KEY: "re_test_key" },
      { onCopyError },
    );
    await mailer.send(msg);
    expect(calls).toBe(2);
    expect(onCopyError).toHaveBeenCalledWith(expect.stringMatching(/^resend_/));
  });

  it("sends no copy when none is configured", async () => {
    const fetchMock = vi.fn(() => ok("r1"));
    vi.stubGlobal("fetch", fetchMock);
    await createMailer({ ...base, RESEND_API_KEY: "re_test_key" }).send(msg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("redactCopy", () => {
  it("removes links of any scheme and 6 to 8 digit codes, and keeps the rest", () => {
    expect(redactCopy("Hi. Code 482913, link https://a.test/x?y=1 and wise://invite/9.")).toBe(
      "Hi. Code [code removed], link [link removed] and [link removed]",
    );
    expect(redactCopy("Order 12345 in 2026")).toBe("Order 12345 in 2026");
  });
});

describe("mailerLogHooks", () => {
  it("logs labels only", () => {
    const warn = vi.fn();
    const hooks = mailerLogHooks({ warn });
    hooks.onCopyError?.("smtp_ECONNREFUSED");
    hooks.onFallback?.("resend", "http_401");
    expect(warn).toHaveBeenCalledWith({ errorClass: "smtp_ECONNREFUSED" }, expect.any(String));
    expect(warn).toHaveBeenCalledWith(
      { provider: "resend", errorClass: "http_401" },
      expect.any(String),
    );
  });
});
