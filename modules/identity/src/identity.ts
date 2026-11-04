import { passkey } from "@better-auth/passkey";
import { isUuidv7, uuidv7 } from "@wise-biz/ids";
import { MailError } from "@wise-biz/mailer";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";

import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-policy.ts";
import * as schema from "./schema.ts";

import type { Mailer, MailMessage } from "@wise-biz/mailer";
import type pg from "pg";

export interface IdentitySession {
  sessionId: string;
  userId: string;
  /** Lower-cased. Read from the user row at session resolution. */
  email: string;
  emailVerified: boolean;
  activeTenantId: string | null;
  expiresAt: Date;
}

export interface IdentityPort {
  getSession(headers: Headers): Promise<IdentitySession | null>;
  /** Matches the session on id AND owner, so one user can never move another user's session. */
  setActiveTenant(sessionId: string, userId: string, tenantId: string | null): Promise<void>;
  /** Better Auth handler, mounted at /v1/auth/*. */
  handler(req: Request): Promise<Response>;
}

export interface CreateIdentityOptions {
  /** Pool connected as wb_identity (the only role with access to the identity schema). */
  pool: pg.Pool;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  /** Sends verification and second-factor mail. Never awaited on the request path. */
  mailer: Mailer;
  /** Console origin, shown in mail so users know where to sign in. */
  consoleUrl: string;
  /** WebAuthn relying-party id (a hostname, e.g. "localhost" in dev). */
  rpId: string;
  /** WebAuthn origins allowed to run ceremonies (exact match, scheme + host + port). */
  rpOrigins: string[];
}

export const SESSION_COOKIE_NAME = "__Host-wb_session";
export const AUTH_BASE_PATH = "/v1/auth";
/**
 * The ONLY header Better Auth reads the client IP from (sessions.ip_address). The API kernel overwrites it with the
 * IP it derived under TRUST_PROXY_HOPS and strips any client-sent value, so the stored address is not spoofable.
 */
export const CLIENT_IP_HEADER = "x-wb-client-ip";

const SESSION_EXPIRES_IN_SECONDS = 12 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60;
const VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;
const OTP_DIGITS = 6;
/** Better Auth's otpOptions.period is in minutes. */
const OTP_PERIOD_MINUTES = 3;
const OTP_ALLOWED_ATTEMPTS = 5;
const ISSUER = "wise-biz";
const PASSKEY_RP_NAME = "wise-biz";

// Paths whose body carries a new password to be checked against the policy.
/** authenticatorData layout: rpIdHash (32 bytes), then the flags byte; bit 0x04 = UV (user verified). */
const AUTH_DATA_FLAGS_OFFSET = 32;
const AUTH_DATA_FLAG_UV = 0x04;

/**
 * True when the WebAuthn assertion's authenticatorData carries the UV flag. These are the exact bytes the plugin then
 * signature-checks, so a client cannot set the flag without the authenticator signing it.
 */
function assertionUserVerified(body: unknown): boolean {
  const data = (body as { response?: { response?: { authenticatorData?: unknown } } } | undefined)
    ?.response?.response?.authenticatorData;
  if (typeof data !== "string") return false;
  const flags = Buffer.from(data, "base64url")[AUTH_DATA_FLAGS_OFFSET];
  return flags !== undefined && (flags & AUTH_DATA_FLAG_UV) !== 0;
}

const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  "/sign-up/email": "password",
  "/change-password": "newPassword",
  "/reset-password": "newPassword",
};

/**
 * Fire-and-forget mail. The caller answers its request without waiting for the provider, so a slow or failing mail
 * path cannot leak whether an address exists. A failure is logged with its error class only: no address, subject,
 * body, token or code.
 */
function sendInBackground(
  mailer: Mailer,
  kind: "verification" | "second-factor",
  msg: MailMessage,
): void {
  Promise.resolve()
    .then(() => mailer.send(msg))
    .catch((err: unknown) => {
      const errorClass = err instanceof MailError ? err.errorClass : "unknown";
      console.error(JSON.stringify({ msg: "identity mail not delivered", kind, errorClass }));
    });
}

export function createIdentity(opts: CreateIdentityOptions): IdentityPort {
  const db = drizzle(opts.pool, { schema });

  const auth = betterAuth({
    appName: "wise-biz",
    baseURL: opts.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: opts.secret,
    // A wildcard would let any site pass Better Auth's own CSRF check; never forward one.
    trustedOrigins: opts.trustedOrigins.filter((o) => o !== "*"),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
        // Model names below are the ones passed to the plugins (twoFactorTable, passkey modelName).
        two_factors: schema.twoFactors,
        passkeys: schema.passkeys,
      },
    }),
    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
      additionalFields: {
        // Written only by IdentityPort.setActiveTenant, never by a client.
        activeTenantId: { type: "string", required: false, input: false },
      },
    },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // Unverified accounts cannot sign in. Sign-up answers the same way for new and existing emails (Better Auth's
      // generic duplicate response), and never auto-signs-in: the user must follow the emailed link first.
      requireEmailVerification: true,
      autoSignIn: false,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: VERIFICATION_EXPIRES_IN_SECONDS,
      autoSignInAfterVerification: false,
      sendVerificationEmail: ({ user, url }) => {
        sendInBackground(opts.mailer, "verification", {
          to: user.email,
          subject: "Confirm your wise-biz email",
          text: [
            "Confirm your email address to finish setting up your wise-biz account:",
            "",
            url,
            "",
            "The link expires in one hour. If you did not sign up, ignore this email.",
            `Sign in at ${opts.consoleUrl}.`,
          ].join("\n"),
        });
        // Resolved at once: Better Auth awaits this callback, the mail itself is not awaited.
        return Promise.resolve();
      },
    },
    // The kernel rate-limits sign-in/sign-up (Redis, fail closed).
    rateLimit: { enabled: false },
    // Pinned: Better Auth's info/debug lines include email addresses (PII never reaches logs).
    logger: { level: "warn" },
    advanced: {
      database: { generateId: () => uuidv7() },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // false: Better Auth must not prepend "__Secure-" (it would yield "__Secure-__Host-..."). The Secure attribute
      // is forced below instead.
      useSecureCookies: false,
      // Every other Better Auth cookie (two-factor, trust-device, passkey challenge, dont-remember) gets the same
      // attributes as the session cookie instead of the library default (no Secure, SameSite=Lax).
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "strict", path: "/" },
      cookies: {
        session_token: {
          name: SESSION_COOKIE_NAME,
          attributes: { secure: true, httpOnly: true, sameSite: "strict", path: "/" },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: ISSUER,
        // Model name for the plugin table; mapped to identity.two_factors in the drizzle adapter above.
        twoFactorTable: "two_factors",
        // skipVerificationOnEnable stays false: enabling is confirmed by an emailed code from the signed-in session, so
        // a typo in the account email cannot lock the user out.
        otpOptions: {
          digits: OTP_DIGITS,
          period: OTP_PERIOD_MINUTES,
          allowedAttempts: OTP_ALLOWED_ATTEMPTS,
          // Only the hash of the code is stored (verifications.value).
          storeOTP: "hashed",
          sendOTP: ({ user, otp }) => {
            sendInBackground(opts.mailer, "second-factor", {
              to: user.email,
              subject: "Your wise-biz sign-in code",
              text: [
                `Your wise-biz code is ${otp}.`,
                `It expires in ${String(OTP_PERIOD_MINUTES)} minutes.`,
                "If you did not try to sign in, change your password.",
              ].join("\n"),
            });
          },
        },
      }),
      passkey({
        rpID: opts.rpId,
        rpName: PASSKEY_RP_NAME,
        origin: opts.rpOrigins.filter((o) => o !== "*"),
        // Registration also runs Better Auth's fresh-session check (re-auth within freshAge).
        registration: { requireSession: true },
        // UV = PIN or biometrics. A passkey is a full sign-in on its own (no email OTP), so possession alone is not
        // enough: the hook below rejects assertions whose UV flag is unset (the plugin verifies with UV optional).
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        schema: { passkey: { modelName: "passkeys" } },
      }),
    ],
    hooks: {
      before: createAuthMiddleware((ctx) => {
        if (ctx.path === "/passkey/verify-authentication") {
          if (assertionUserVerified(ctx.body)) return Promise.resolve();
          return Promise.reject(
            new APIError("UNAUTHORIZED", {
              code: "USER_VERIFICATION_REQUIRED",
              message: "Passkey sign-in needs user verification (PIN or biometrics).",
            }),
          );
        }
        const field = PASSWORD_FIELD_BY_PATH[ctx.path];
        if (field === undefined) return Promise.resolve();
        const body = ctx.body as Record<string, unknown> | undefined;
        const password = body?.[field];
        if (typeof password !== "string") return Promise.resolve(); // schema validation reports the shape error
        const email = typeof body?.email === "string" ? body.email : null;
        const name = typeof body?.name === "string" ? body.name : null;
        const check = checkPassword(password, { email, name });
        if (!check.ok) {
          return Promise.reject(
            new APIError("BAD_REQUEST", {
              code: "WEAK_PASSWORD",
              message: check.problems.join(" "),
            }),
          );
        }
        return Promise.resolve();
      }),
    },
  });

  return {
    async getSession(headers) {
      let result;
      try {
        result = await auth.api.getSession({ headers });
      } catch (err) {
        // A missing/tampered/invalid cookie is a client error (4xx APIError) -> no session. Anything else (pool or
        // driver failure, bug) is infrastructure: rethrow so the caller answers 5xx and NEVER treats it as anonymous.
        if (err instanceof APIError && err.statusCode < 500) return null;
        throw err;
      }
      if (!result) return null;
      const s = result.session as typeof result.session & { activeTenantId?: unknown };
      if (s.expiresAt.getTime() <= Date.now()) return null;
      return {
        sessionId: s.id,
        userId: s.userId,
        email: result.user.email.toLowerCase(),
        emailVerified: result.user.emailVerified,
        activeTenantId: isUuidv7(s.activeTenantId) ? s.activeTenantId : null,
        expiresAt: s.expiresAt,
      };
    },
    async setActiveTenant(sessionId, userId, tenantId) {
      await opts.pool.query(
        "UPDATE identity.sessions SET active_tenant_id = $2, updated_at = now() WHERE id = $1 AND user_id = $3",
        [sessionId, tenantId, userId],
      );
    },
    handler: (req) => auth.handler(req),
  };
}
