import {
  EmailGuardError,
  assertMailbox,
  assertNoHeaderInjection,
  escapeHtml,
  prepareMessage,
} from "@sahan-sac/email-kit";
import { createResendProvider } from "@sahan-sac/email-kit/providers/resend";
import nodemailer from "nodemailer";

import type { PreparedMessage } from "@sahan-sac/email-kit";

/** The mail env keys this package reads. Structurally matches the `mailEnv` fragment plus NODE_ENV. */
export interface MailEnv {
  readonly MAIL_FROM: string;
  readonly MAIL_SMTP_HOST?: string | undefined;
  readonly MAIL_SMTP_PORT?: number | undefined;
  readonly RESEND_API_KEY?: string | undefined;
  readonly NODE_ENV?: "development" | "test" | "production" | undefined;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Caller-escaped HTML. When omitted, the text is escaped and wrapped in a paragraph. */
  readonly html?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export interface SentMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Delivery failure. Carries a short machine label only: never an address, subject or body. */
export class MailError extends Error {
  readonly errorClass: string;
  readonly retryable: boolean;

  constructor(errorClass: string, retryable: boolean) {
    super(`mail not delivered: ${errorClass}`);
    this.name = "MailError";
    this.errorClass = errorClass;
    this.retryable = retryable;
  }
}

type Deliver = (message: PreparedMessage) => Promise<void>;

const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
/** Category tag sent with every provider call. The mailer API has no category, so all mail is tagged as security. */
const CATEGORY = "security";

function toHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;
}

function prepare(msg: MailMessage): PreparedMessage {
  try {
    // Reject line breaks before email-kit trims them away: a stray CR/LF is a bug or an attack, never a value to keep.
    assertNoHeaderInjection(msg.to, "to");
    assertNoHeaderInjection(msg.subject, "subject");
    return prepareMessage({
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html ?? toHtml(msg.text),
      category: CATEGORY,
    });
  } catch (error) {
    if (error instanceof EmailGuardError) throw new MailError(error.errorClass, false);
    throw error;
  }
}

/**
 * SMTP without AUTH (a local relay). Mail carries OTP codes and invite links, so production never sends in cleartext:
 * port 465 uses implicit TLS, any other port must upgrade with STARTTLS or the send fails. Other environments use
 * opportunistic STARTTLS (Mailpit offers none).
 */
export function smtpTransportOptions(host: string, port: number | undefined, production: boolean) {
  const implicitTls = production && port === 465;
  return {
    host,
    port,
    secure: implicitTls,
    requireTLS: production && !implicitTls,
    ...SMTP_TIMEOUTS,
  };
}

function smtpDeliver(
  host: string,
  port: number | undefined,
  from: string,
  production: boolean,
): Deliver {
  const transport = nodemailer.createTransport(smtpTransportOptions(host, port, production));
  // nodemailer rejects the send when every recipient is refused (EENVELOPE), so no accepted-list check is needed.
  return async (message) => {
    try {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      throw new MailError(`smtp_${String((error as { code?: string }).code)}`, true);
    }
  };
}

function resendDeliver(apiKey: string, from: string): Deliver {
  const provider = createResendProvider({ apiKey, from });
  return async (message) => {
    const outcome = await provider.send(message);
    if (!outcome.ok) throw new MailError(outcome.errorClass, outcome.retryable);
  };
}

/**
 * Picks the provider: SMTP when MAIL_SMTP_HOST is set, else Resend when RESEND_API_KEY is set.
 * With neither: production refuses to start; other environments fail each send loudly.
 */
function selectDeliver(env: MailEnv, from: string): Deliver {
  if (env.MAIL_SMTP_HOST !== undefined) {
    return smtpDeliver(env.MAIL_SMTP_HOST, env.MAIL_SMTP_PORT, from, env.NODE_ENV === "production");
  }
  if (env.RESEND_API_KEY !== undefined) return resendDeliver(env.RESEND_API_KEY, from);
  if (env.NODE_ENV === "production") {
    throw new MailError("no_provider_configured", false);
  }
  return () => Promise.reject(new MailError("no_provider_configured", false));
}

/** Production mail sender. Pure apart from the network: no logging of bodies, subjects or addresses. */
export function createMailer(env: MailEnv): Mailer {
  const from = assertMailbox(env.MAIL_FROM, "MAIL_FROM");
  const deliver = selectDeliver(env, from);
  return {
    async send(msg) {
      await deliver(prepare(msg));
    },
  };
}

/** In-memory mailer for tests. Runs the same guards, so header-injection tests hold for both. */
export function createCaptureMailer(): Mailer & { sent: SentMail[]; clear(): void } {
  const sent: SentMail[] = [];
  return {
    sent,
    clear() {
      sent.length = 0;
    },
    send(msg) {
      return new Promise<void>((resolve) => {
        const prepared = prepare(msg);
        sent.push({
          to: prepared.to.join(", "),
          subject: prepared.subject,
          text: prepared.text,
          html: prepared.html,
        });
        resolve();
      });
    },
  };
}
