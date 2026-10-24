import { createServer } from "node:net";

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailError, createCaptureMailer, createMailer } from "../src/index.ts";
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
