import {
  EmailGuardError,
  assertMailbox,
  assertNoHeaderInjection,
  createDailyQuota,
  createMemoryQuotaStore,
  escapeHtml,
  maskAddress,
  prepareMessage,
} from "@sahan-sac/email-kit";
import { createBrevoApiProvider } from "@sahan-sac/email-kit/providers/brevo-api";
import { createSmtpProvider } from "@sahan-sac/email-kit/providers/brevo-smtp";
import { createCaptureProvider } from "@sahan-sac/email-kit/providers/capture";
import { createResendProvider } from "@sahan-sac/email-kit/providers/resend";
import nodemailer from "nodemailer";

import type {
  EmailProvider,
  PreparedMessage,
  ProviderName,
  ProviderOutcome,
} from "@sahan-sac/email-kit";

export type MailProviderName = "smtp" | "brevo-api" | "resend" | "brevo-smtp";

/** The mail env keys this package reads. Structurally matches the `mailEnv` fragment plus NODE_ENV. */
export interface MailEnv {
  readonly MAIL_FROM: string;
  readonly EMAIL_PROVIDER?: "auto" | MailProviderName | "capture" | undefined;
  readonly EMAIL_PROVIDER_ORDER?: readonly MailProviderName[] | undefined;
  readonly MAIL_CC_EMAILS?: readonly string[] | undefined;
  readonly MAIL_BCC_EMAILS?: readonly string[] | undefined;
  readonly MAIL_COPY_MODE?: "redacted" | "full" | undefined;
  readonly MAIL_SMTP_HOST?: string | undefined;
  readonly MAIL_SMTP_PORT?: number | undefined;
  readonly RESEND_API_KEY?: string | undefined;
  readonly RESEND_EMAIL_SENDER_EMAIL?: string | undefined;
  readonly BREVO_API_KEY?: string | undefined;
  readonly BREVO_EMAIL_SENDER_USER?: string | undefined;
  readonly BREVO_EMAIL_HOST?: string | undefined;
  readonly BREVO_EMAIL_PORT?: number | undefined;
  readonly BREVO_EMAIL_USE_TLS?: boolean | undefined;
  readonly BREVO_EMAIL_HOST_USER?: string | undefined;
  readonly BREVO_EMAIL_HOST_PASSWORD?: string | undefined;
  readonly BREVO_DAILY_LIMIT?: number | undefined;
  readonly RESEND_DAILY_LIMIT?: number | undefined;
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

const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
/** Category tag sent with every provider call. The mailer API has no category, so all mail is tagged as security. */
const CATEGORY = "security";

/** The order `auto` tries providers in: the local relay first (it only exists where MAIL_SMTP_HOST is set). */
const DEFAULT_ORDER: readonly MailProviderName[] = ["smtp", "brevo-api", "resend", "brevo-smtp"];

function toHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;
}

function prepare(
  msg: MailMessage,
  copies?: { cc: readonly string[]; bcc: readonly string[] },
): PreparedMessage {
  try {
    // Reject line breaks before email-kit trims them away: a stray CR/LF is a bug or an attack, never a value to keep.
    assertNoHeaderInjection(msg.to, "to");
    assertNoHeaderInjection(msg.subject, "subject");
    return prepareMessage({
      to: msg.to,
      ...(copies && { cc: copies.cc, bcc: copies.bcc }),
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
 * What a copy recipient sees: the text with every link and every 6 to 8 digit code removed. Mail carries invite links,
 * verification links and one-time codes, and whoever reads a copy must not be able to use them.
 */
export function redactCopy(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]")
    .replace(/\b\d{6,8}\b/g, "[code removed]");
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

interface NamedProvider {
  readonly name: MailProviderName;
  send(message: PreparedMessage): Promise<ProviderOutcome>;
}

function localSmtp(
  host: string,
  port: number | undefined,
  from: string,
  production: boolean,
): NamedProvider {
  const transport = nodemailer.createTransport(smtpTransportOptions(host, port, production));
  // nodemailer rejects the send when every recipient is refused (EENVELOPE), so no accepted-list check is needed.
  return {
    name: "smtp",
    async send(message) {
      try {
        await transport.sendMail({
          from,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return { ok: true };
      } catch (error) {
        const code = String((error as { code?: string }).code);
        return { ok: false, errorClass: `smtp_${code}`, retryable: true };
      }
    },
  };
}

const named = (name: MailProviderName, p: EmailProvider): NamedProvider => ({
  name,
  send: (m) => p.send(m),
});

/** Every provider the env configures, by name. A provider with a missing piece is simply absent. */
function configured(env: MailEnv, production: boolean): Map<MailProviderName, NamedProvider> {
  const out = new Map<MailProviderName, NamedProvider>();
  if (env.MAIL_SMTP_HOST !== undefined) {
    out.set("smtp", localSmtp(env.MAIL_SMTP_HOST, env.MAIL_SMTP_PORT, env.MAIL_FROM, production));
  }
  if (env.BREVO_API_KEY !== undefined) {
    const from = assertMailbox(
      env.BREVO_EMAIL_SENDER_USER ?? env.MAIL_FROM,
      "BREVO_EMAIL_SENDER_USER",
    );
    out.set(
      "brevo-api",
      named("brevo-api", createBrevoApiProvider({ apiKey: env.BREVO_API_KEY, from })),
    );
  }
  if (env.RESEND_API_KEY !== undefined) {
    const from = assertMailbox(
      env.RESEND_EMAIL_SENDER_EMAIL ?? env.MAIL_FROM,
      "RESEND_EMAIL_SENDER_EMAIL",
    );
    out.set("resend", named("resend", createResendProvider({ apiKey: env.RESEND_API_KEY, from })));
  }
  if (
    env.BREVO_EMAIL_HOST !== undefined &&
    env.BREVO_EMAIL_HOST_USER !== undefined &&
    env.BREVO_EMAIL_HOST_PASSWORD !== undefined
  ) {
    const port = env.BREVO_EMAIL_PORT ?? 587;
    const from = assertMailbox(
      env.BREVO_EMAIL_SENDER_USER ?? env.MAIL_FROM,
      "BREVO_EMAIL_SENDER_USER",
    );
    out.set(
      "brevo-smtp",
      named(
        "brevo-smtp",
        createSmtpProvider({
          host: env.BREVO_EMAIL_HOST,
          port,
          secure: port === 465,
          requireTLS: port !== 465 && (env.BREVO_EMAIL_USE_TLS ?? true),
          user: env.BREVO_EMAIL_HOST_USER,
          pass: env.BREVO_EMAIL_HOST_PASSWORD,
          from,
        }),
      ),
    );
  }
  return out;
}

/**
 * The providers to try, in order. A named provider is the only one; `auto` uses every configured provider, the ones in
 * EMAIL_PROVIDER_ORDER first. `capture` keeps mail in memory and is refused in production by the env check.
 * With none: production refuses to start; other environments fail each send loudly.
 */
function selectChain(env: MailEnv, production: boolean): NamedProvider[] {
  const mode = env.EMAIL_PROVIDER ?? "auto";
  if (mode === "capture") {
    const p = createCaptureProvider(production);
    return [{ name: "smtp", send: (m) => p.send(m) }];
  }
  const all = configured(env, production);
  const order =
    mode === "auto"
      ? [...new Set([...(env.EMAIL_PROVIDER_ORDER ?? []), ...DEFAULT_ORDER])]
      : [mode];
  const chain = order.flatMap((n) => {
    const p = all.get(n);
    return p === undefined ? [] : [p];
  });
  if (chain.length === 0 && production) throw new MailError("no_provider_configured", false);
  return chain;
}

/** Free-tier daily limits per provider (0 turns one off). Counted in this process only: a hint, never a guarantee. */
function dailyQuota(env: MailEnv) {
  const limits: Partial<Record<ProviderName, number>> = {};
  const brevo = env.BREVO_DAILY_LIMIT ?? 300;
  const resend = env.RESEND_DAILY_LIMIT ?? 100;
  if (brevo > 0) {
    limits["brevo-api"] = brevo;
    limits["brevo-smtp"] = brevo;
  }
  if (resend > 0) limits.resend = resend;
  return createDailyQuota({ limits, store: createMemoryQuotaStore() });
}

export interface MailerOptions {
  /** A copy could not be delivered. The original mail was not affected. Receives a short label, never an address. */
  onCopyError?: (errorClass: string) => void;
  /** A provider failed and the next one was tried. */
  onFallback?: (provider: MailProviderName, errorClass: string) => void;
}

/** Hooks that log fallbacks and copy failures (labels only, never an address). Pass the result to createMailer. */
export function mailerLogHooks(logger: {
  warn(fields: object, message: string): void;
}): MailerOptions {
  return {
    onCopyError: (errorClass) => {
      logger.warn({ errorClass }, "mail copy not delivered");
    },
    onFallback: (provider, errorClass) => {
      logger.warn({ provider, errorClass }, "mail provider failed; trying the next");
    },
  };
}

/** Production mail sender. Pure apart from the network: no logging of bodies, subjects or addresses. */
export function createMailer(env: MailEnv, opts: MailerOptions = {}): Mailer {
  const from = assertMailbox(env.MAIL_FROM, "MAIL_FROM");
  const production = env.NODE_ENV === "production";
  const chain = selectChain(env, production);
  const quota = dailyQuota(env);
  const cc = env.MAIL_CC_EMAILS ?? [];
  const bcc = env.MAIL_BCC_EMAILS ?? [];
  const hasCopies = cc.length + bcc.length > 0;
  const full = env.MAIL_COPY_MODE === "full";

  const deliver = async (message: PreparedMessage): Promise<void> => {
    let last: MailError | undefined;
    for (const p of chain) {
      if (p.name !== "smtp" && !(await quota.allow(p.name))) {
        last = new MailError("daily_limit", true);
        opts.onFallback?.(p.name, "daily_limit");
        continue;
      }
      const outcome = await p.send(message);
      if (outcome.ok) {
        if (p.name !== "smtp") await quota.record(p.name);
        return;
      }
      last = new MailError(outcome.errorClass, outcome.retryable);
      // A problem with the message itself would fail at every provider: stop. An account problem moves on.
      if (!outcome.retryable) break;
      opts.onFallback?.(p.name, outcome.errorClass);
    }
    throw last ?? new MailError("no_provider_configured", false);
  };

  return {
    async send(msg) {
      await deliver(prepare(msg, full ? { cc, bcc } : undefined));
      if (full || !hasCopies) return;
      // Redacted copy: one separate mail, every copy address hidden in BCC, sent to the sender's own address.
      const redacted = redactCopy(msg.text);
      const note = `Redacted copy of a mail sent to ${maskAddress(msg.to)}. Links and codes are removed.\n\n`;
      try {
        await deliver(
          prepareMessage({
            to: from,
            bcc: [...cc, ...bcc],
            subject: `[Copy] ${msg.subject}`,
            text: note + redacted,
            html: toHtml(note + redacted),
            category: CATEGORY,
          }),
        );
      } catch (error) {
        opts.onCopyError?.(error instanceof MailError ? error.errorClass : "copy_failed");
      }
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
