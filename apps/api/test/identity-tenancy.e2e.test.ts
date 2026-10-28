import { createServer } from "node:net";
import { join } from "node:path";

import { createPool, migrate } from "@wise-biz/db";
import { isUuidv7, uuidv7 } from "@wise-biz/ids";
import { createMailer } from "@wise-biz/mailer";
import { createInviteEmailConsumer } from "@wise-biz/module-tenancy";
import { startRedis, testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SoftAuthenticator } from "../../../modules/identity/test/support/soft-authenticator.ts";
import { startServer } from "../src/server.ts";

import type { RunningServer } from "../src/server.ts";
import type { AddressInfo, Socket } from "node:net";
import type pg from "pg";

/**
 * P0-08a/08b acceptance over real HTTP (fetch, cookies carried by hand) against the production wiring from
 * startServer: Postgres + Redis containers, and a local SMTP sink that the API's own mailer delivers to. Invite mail is
 * produced by the real invite consumer run on the outbox row. Each describe boots its own stack, so the per-IP and
 * per-email sign-up/sign-in counters and Redis outages never leak between suites.
 */
const modulesDir = join(import.meta.dirname, "..", "..", "..", "modules");
const ORIGIN = "http://localhost:3000";
const AUTH_URL = "http://localhost:3001";
const CONSOLE_URL = "http://localhost:3002";
const RP_ID = "localhost";
const MAIL_FROM = "noreply@example.com";
const INVITE_SECRET = "e2e-invite-secret".padEnd(40, "x");
const FOREIGN_ORIGIN = "https://evil.example";
const PASSWORD = "correct-horse-battery-staple-91";
const SESSION_COOKIE = "__Host-wb_session";
const SUBJECT_VERIFY = "Confirm your wise-biz email";
const SUBJECT_OTP = "Your wise-biz sign-in code";
const SUBJECT_INVITE_PREFIX = "You are invited to ";
const BOOT_TIMEOUT_MS = 180_000;
const CLOSE_TIMEOUT_MS = 120_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIGRATIONS = ["infra", "audit", "identity", "tenancy", "_template"].map((module) => ({
  module,
  dir: join(modulesDir, module, "migrations"),
}));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });

const stopQuietly = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch {
    // already stopped or dropped
  }
};

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// SMTP sink: a plain SMTP server on 127.0.0.1 (no AUTH, no STARTTLS) that the API's mailer delivers to.
// ---------------------------------------------------------------------------------------------------------------------

interface CapturedMail {
  to: string;
  subject: string;
  text: string;
}

interface MailSink {
  readonly port: number;
  readonly mail: CapturedMail[];
  /** Newest message at or after index `since` that matches. Polls until one arrives. */
  waitFor(
    match: (m: CapturedMail) => boolean,
    since?: number,
    timeoutMs?: number,
  ): Promise<CapturedMail>;
  close(): Promise<void>;
}

function unfoldHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "7bit").trim().toLowerCase();
  if (enc === "quoted-printable") {
    const bytes = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  return body;
}

/** The text/plain part of a message (or the whole body when the message is not multipart). */
function plainTextOf(raw: string): string {
  const split = raw.indexOf("\r\n\r\n");
  const headers = unfoldHeaders(split === -1 ? raw : raw.slice(0, split));
  const body = split === -1 ? "" : raw.slice(split + 4);
  const type = headers.get("content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (boundary === undefined) return decodeBody(body, headers.get("content-transfer-encoding"));
  for (const part of body.split(`--${boundary}`)) {
    const cut = part.indexOf("\r\n\r\n");
    if (cut === -1) continue;
    const partHeaders = unfoldHeaders(part.slice(0, cut));
    if (!/^text\/plain/i.test(partHeaders.get("content-type") ?? "")) continue;
    return decodeBody(
      part.slice(cut + 4).replace(/\r\n$/, ""),
      partHeaders.get("content-transfer-encoding"),
    );
  }
  return "";
}

function messageOf(raw: string): { subject: string; text: string } {
  const split = raw.indexOf("\r\n\r\n");
  const headers = unfoldHeaders(split === -1 ? raw : raw.slice(0, split));
  return { subject: headers.get("subject") ?? "", text: plainTextOf(raw) };
}

const addressOf = (line: string): string => {
  const angled = /<([^>]*)>/.exec(line)?.[1];
  return (angled ?? line.slice(8)).trim().toLowerCase();
};

function startMailSink(): Promise<MailSink> {
  const mail: CapturedMail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let pending = "";
    let recipients: string[] = [];
    let inData = false;
    const say = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    say("220 mail-sink ESMTP");
    /** Consumes one complete unit (a command line, or a whole DATA block). False when more input is needed. */
    const drain = (): boolean => {
      if (inData) {
        const end = pending.indexOf("\r\n.\r\n");
        if (end === -1) return false;
        const raw = pending.slice(0, end + 2);
        pending = pending.slice(end + 5);
        inData = false;
        for (const to of recipients) mail.push({ to, ...messageOf(raw) });
        recipients = [];
        say("250 queued");
        return true;
      }
      const eol = pending.indexOf("\r\n");
      if (eol === -1) return false;
      const line = pending.slice(0, eol);
      pending = pending.slice(eol + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO" || verb === "HELO") say("250 mail-sink");
      else if (verb === "MAIL" || verb === "RSET") {
        recipients = [];
        say("250 OK");
      } else if (verb === "RCPT") {
        recipients.push(addressOf(line));
        say("250 OK");
      } else if (verb === "DATA") {
        inData = true;
        say("354 end with <CRLF>.<CRLF>");
      } else if (verb === "QUIT") {
        say("221 bye");
        socket.end();
        pending = "";
        return false;
      } else say("250 OK");
      return true;
    };
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let more = drain();
      while (more) more = drain();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        mail,
        waitFor: async (match, since = 0, timeoutMs = 10_000) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const hit = mail.slice(since).reverse().find(match);
            if (hit !== undefined) return hit;
            if (Date.now() > deadline) throw new Error("expected mail was not captured");
            await new Promise((r) => setTimeout(r, 15));
          }
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Stack: Postgres (migrated), Redis, SMTP sink, and the production server.
// ---------------------------------------------------------------------------------------------------------------------

interface Stack {
  base: string;
  mail: MailSink;
  admin: pg.Pool;
  /** Stops Redis (idempotent). Used to simulate an outage. */
  stopRedis(): Promise<void>;
  close(): Promise<void>;
}

async function bootStack(): Promise<Stack> {
  const [redis, db, mail] = await Promise.all([startRedis(), testDatabase(), startMailSink()]);
  const admin = createPool(db.url("admin"), { max: 2 });
  let redisGone = false;
  const stopRedis = async (): Promise<void> => {
    if (redisGone) return;
    redisGone = true;
    await redis.stop();
  };
  const cleanup = async (): Promise<void> => {
    await stopQuietly(() => admin.end());
    await stopQuietly(stopRedis);
    await stopQuietly(() => mail.close());
    await stopQuietly(() => db.drop());
  };
  try {
    await migrate(db.url("migrator"), MIGRATIONS);
    const running: RunningServer = await startServer({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: db.url("app"),
      DATABASE_IDENTITY_URL: db.url("identity"),
      AUTH_SECRET: "e2e-identity-tenancy-secret".padEnd(40, "x"),
      AUTH_URL,
      AUTH_RP_ID: RP_ID,
      CORS_ORIGINS: ORIGIN,
      CONSOLE_URL,
      INVITE_SECRET,
      PIN_PEPPER: "test-pin-pepper-".padEnd(40, "x"),
      MAIL_FROM,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: String(mail.port),
      REDIS_URL: redis.url,
      PORT: String(await freePort()),
    });
    return {
      base: `http://127.0.0.1:${String(running.port)}`,
      mail,
      admin,
      stopRedis,
      close: async () => {
        await stopQuietly(() => running.close());
        await cleanup();
      },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: Headers;
  json: unknown;
}

interface SendOpts {
  body?: unknown;
  cookie?: string;
  origin?: string;
}

const parseJson = (text: string): unknown => {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

async function send(
  stack: Stack,
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: SendOpts = {},
): Promise<Reply> {
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  // Every mutation carries an Idempotency-Key (the API requires it on runCommand routes).
  if (method !== "GET") headers["idempotency-key"] = uuidv7();
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`${stack.base}${path}`, init);
  return { status: res.status, headers: res.headers, json: parseJson(await res.text()) };
}

interface ProblemBody {
  code: string;
  status: number;
  requestId: string;
}

const problemOf = (reply: Reply): ProblemBody => reply.json as ProblemBody;
const codeOf = (reply: Reply): string | undefined => (reply.json as { code?: string } | null)?.code;

const sessionSetCookie = (reply: Reply): string =>
  must(
    reply.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)),
    "session Set-Cookie",
  );

const cookieOf = (reply: Reply): string => sessionSetCookie(reply).split(";")[0] ?? "";

/** True when the reply starts a session: a non-empty __Host-wb_session value. Clearing it (Max-Age=0) is not one. */
const startsSession = (reply: Reply): boolean =>
  reply.headers
    .getSetCookie()
    .some(
      (c) =>
        c.startsWith(`${SESSION_COOKIE}=`) &&
        (c.split(";")[0] ?? "").length > SESSION_COOKIE.length + 1 &&
        !/max-age=0\b/i.test(c),
    );

/** Every name=value a reply sets (challenge cookies for 2FA and passkeys), joined for the next request. */
const allCookiesOf = (reply: Reply): string =>
  reply.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((pair) => pair.includes("="))
    .join("; ");

/** The first URL in a mail body that contains `marker`, parsed. */
function urlIn(text: string, marker: string): URL | undefined {
  const word = text.split(/\s+/).find((w) => w.startsWith("http") && w.includes(marker));
  return word === undefined ? undefined : new URL(word);
}

// ---------------------------------------------------------------------------------------------------------------------
// Account, session and tenancy helpers
// ---------------------------------------------------------------------------------------------------------------------

const newEmail = (): string => `e2e-${uuidv7()}@example.com`;

function signUp(stack: Stack, name: string, email: string): Promise<Reply> {
  return send(stack, "POST", "/v1/auth/sign-up/email", {
    body: { name, email, password: PASSWORD },
  });
}

function signIn(stack: Stack, email: string, password = PASSWORD): Promise<Reply> {
  return send(stack, "POST", "/v1/auth/sign-in/email", { body: { email, password } });
}

/** Follows the newest verification link sent to `email` (the Better Auth URL, requested against this server). */
async function verifyEmail(stack: Stack, email: string): Promise<void> {
  const mail = await stack.mail.waitFor((m) => m.to === email && m.subject === SUBJECT_VERIFY);
  const link = must(urlIn(mail.text, "/verify-email"), "verification link");
  const reply = await send(stack, "GET", `${link.pathname}${link.search}`);
  expect(reply.status).toBeLessThan(400);
}

interface Member {
  email: string;
  cookie: string;
  userId: string;
  signInReply: Reply;
}

/** Sign up, verify the emailed link, then sign in. Returns the signed-in session. */
async function enrollAs(stack: Stack, name: string, email: string): Promise<Member> {
  const up = await signUp(stack, name, email);
  expect(up.status).toBe(200);
  await verifyEmail(stack, email);
  const signedIn = await signIn(stack, email);
  expect(signedIn.status).toBe(200);
  const cookie = cookieOf(signedIn);
  const session = await sessionOf(stack, cookie);
  return { email, cookie, userId: session.userId, signInReply: signedIn };
}

const enroll = (stack: Stack, name: string): Promise<Member> => enrollAs(stack, name, newEmail());

interface SessionView {
  userId: string;
  email: string;
  emailVerified: boolean;
  activeTenantId: string | null;
}

async function sessionOf(stack: Stack, cookie: string): Promise<SessionView> {
  const reply = await send(stack, "GET", "/v1/auth/get-session", { cookie });
  expect(reply.status).toBe(200);
  const body = reply.json as {
    session: { activeTenantId: string | null };
    user: { id: string; email: string; emailVerified: boolean };
  };
  return {
    userId: body.user.id,
    email: body.user.email,
    emailVerified: body.user.emailVerified,
    activeTenantId: body.session.activeTenantId,
  };
}

interface Business {
  tenantId: string;
  branchId: string;
  name: string;
}

async function createBusiness(stack: Stack, cookie: string, name: string): Promise<Business> {
  const tenantId = uuidv7();
  const reply = await send(stack, "POST", "/v1/tenancy/tenants", {
    cookie,
    body: {
      tenantId,
      name,
      branch: {
        name: "Main",
        kind: "store",
        timezone: "Asia/Colombo",
        currency: "LKR",
        taxRegion: "LK",
      },
    },
  });
  expect(reply.status).toBe(201);
  return { tenantId, branchId: (reply.json as { branchId: string }).branchId, name };
}

async function createItem(stack: Stack, cookie: string, name: string): Promise<string> {
  const reply = await send(stack, "POST", "/v1/template/items", { cookie, body: { name } });
  expect(reply.status).toBe(201);
  return (reply.json as { id: string }).id;
}

interface ItemRow {
  id: string;
  name: string;
}

async function listItems(stack: Stack, cookie: string): Promise<Reply & { items: ItemRow[] }> {
  const reply = await send(stack, "GET", "/v1/template/items?limit=50", { cookie });
  const items = reply.status === 200 ? (reply.json as { items: ItemRow[] }).items : [];
  return { ...reply, items };
}

async function roleIdsOf(stack: Stack, cookie: string): Promise<Record<string, string>> {
  const reply = await send(stack, "GET", "/v1/tenancy/roles", { cookie });
  expect(reply.status).toBe(200);
  const roles = (reply.json as { roles: { roleId: string; name: string }[] }).roles;
  return Object.fromEntries(roles.map((r) => [r.name, r.roleId]));
}

interface MemberRow {
  membershipId: string;
  userId: string;
  roles: string[];
  branchIds: string[] | null;
}

async function membersOf(stack: Stack, cookie: string): Promise<MemberRow[]> {
  const reply = await send(stack, "GET", "/v1/tenancy/members?limit=200", { cookie });
  expect(reply.status).toBe(200);
  return (reply.json as { members: MemberRow[] }).members;
}

async function insertBranch(stack: Stack, tenantId: string, name: string): Promise<string> {
  const id = uuidv7();
  await stack.admin.query(
    `insert into tenancy.branches (tenant_id, id, name, kind, timezone, currency, tax_region, business_day_cutoff, created_at)
     values ($1, $2, $3, 'warehouse', 'Asia/Colombo', 'LKR', 'LK', '00:00', now())`,
    [tenantId, id, name],
  );
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Invite helpers: the real invite consumer runs on the outbox row, its mail goes through the SMTP sink.
// ---------------------------------------------------------------------------------------------------------------------

interface InviteLink {
  to: string;
  tenantId: string;
  inviteId: string;
  token: string;
}

async function createInvite(
  stack: Stack,
  cookie: string,
  input: { email: string; roleIds: string[]; branchIds?: string[] | null },
): Promise<{ reply: Reply; inviteId: string }> {
  const inviteId = uuidv7();
  const reply = await send(stack, "POST", "/v1/tenancy/invites", {
    cookie,
    body: {
      id: inviteId,
      email: input.email,
      roleIds: input.roleIds,
      branchIds: input.branchIds ?? null,
    },
  });
  return { reply, inviteId };
}

/** Runs the invite consumer on the stored event and returns the (t, i, k) parsed from the captured invite mail. */
/** The accept link carries its parameters in the fragment (never sent to a server). */
const inviteParams = (url: URL | undefined): URLSearchParams | undefined =>
  url === undefined ? undefined : new URLSearchParams(url.hash.slice(1));

async function deliverInvite(stack: Stack, inviteId: string): Promise<InviteLink> {
  const rows = await stack.admin.query<{ payload: unknown }>(
    "select payload from infra.outbox where type = 'tenancy.member.invited' and payload::text like $1",
    [`%${inviteId}%`],
  );
  expect(rows.rows).toHaveLength(1);
  const consumer = createInviteEmailConsumer({
    mailer: createMailer({
      MAIL_FROM,
      MAIL_SMTP_HOST: "127.0.0.1",
      MAIL_SMTP_PORT: stack.mail.port,
    }),
    consoleUrl: CONSOLE_URL,
    inviteSecret: INVITE_SECRET,
  });
  await consumer.handle({ payload: must(rows.rows[0], "outbox row").payload });
  const mail = await stack.mail.waitFor(
    (m) =>
      m.subject.startsWith(SUBJECT_INVITE_PREFIX) &&
      inviteParams(urlIn(m.text, "/invite/accept"))?.get("i") === inviteId,
  );
  const link = must(inviteParams(urlIn(mail.text, "/invite/accept")), "invite link");
  return {
    to: mail.to,
    tenantId: must(link.get("t"), "t"),
    inviteId: must(link.get("i"), "i"),
    token: must(link.get("k"), "k"),
  };
}

const acceptInvite = (
  stack: Stack,
  cookie: string,
  link: InviteLink,
  token = link.token,
): Promise<Reply> =>
  send(stack, "POST", "/v1/tenancy/invites/accept", {
    cookie,
    body: { tenantId: link.tenantId, inviteId: link.inviteId, token },
  });

const revokeInvite = (stack: Stack, cookie: string, inviteId: string): Promise<Reply> =>
  send(stack, "POST", `/v1/tenancy/invites/${inviteId}/revoke`, { cookie, body: {} });

async function expireInvite(stack: Stack, tenantId: string, inviteId: string): Promise<void> {
  const res = await stack.admin.query(
    "update tenancy.invites set expires_at = now() - interval '1 minute' where tenant_id = $1 and id = $2",
    [tenantId, inviteId],
  );
  expect(res.rowCount).toBe(1);
}

/** Flips the first character of a token, keeping its length (so the failure is the value, not the shape). */
const tamper = (token: string): string => `${token.startsWith("A") ? "B" : "A"}${token.slice(1)}`;

// ---------------------------------------------------------------------------------------------------------------------

describe("identity + tenancy e2e: sessions, isolation, cookies, origin, permissions", () => {
  let main: Stack;
  let owner: Member;
  let ownerBiz: Business;
  let ownerItemIds: string[];
  let other: Member;
  let otherBiz: Business;
  let otherItemId: string;

  beforeAll(async () => {
    main = await bootStack();
    owner = await enroll(main, "Owner Olu");
    ownerBiz = await createBusiness(main, owner.cookie, "Wise Co");
    ownerItemIds = [
      await createItem(main, owner.cookie, "rice"),
      await createItem(main, owner.cookie, "dal"),
    ];
    other = await enroll(main, "Other Ann");
    otherBiz = await createBusiness(main, other.cookie, "Other Co");
    otherItemId = await createItem(main, other.cookie, "tea");
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await main.close();
  }, CLOSE_TIMEOUT_MS);

  describe("owner journey", () => {
    it("the session created by sign-in is active on the business created with it", async () => {
      expect((await sessionOf(main, owner.cookie)).activeTenantId).toBe(ownerBiz.tenantId);
    });

    it("GET /v1/tenancy/me/tenants lists the business the owner created", async () => {
      const reply = await send(main, "GET", "/v1/tenancy/me/tenants", { cookie: owner.cookie });
      expect(reply.status).toBe(200);
      const tenants = (reply.json as { tenants: { tenantId: string; name: string }[] }).tenants;
      expect(tenants).toContainEqual(
        expect.objectContaining({ tenantId: ownerBiz.tenantId, name: ownerBiz.name }),
      );
    });

    it("the owner lists the items it created in its business", async () => {
      const page = await listItems(main, owner.cookie);
      expect(page.status).toBe(200);
      expect(page.items.map((i) => i.id)).toEqual(expect.arrayContaining(ownerItemIds));
    });

    it("the owner creates an item and it shows up in the next list", async () => {
      const id = await createItem(main, owner.cookie, "sugar");
      const page = await listItems(main, owner.cookie);
      expect(page.items.map((i) => i.id)).toContain(id);
    });
  });

  describe("second user isolation", () => {
    it("switching to another user's business returns 404 NOT_FOUND", async () => {
      const reply = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: other.cookie,
        body: { tenantId: ownerBiz.tenantId },
      });
      expect(reply.status).toBe(404);
      expect(reply.headers.get("content-type")).toContain("application/problem+json");
      expect(problemOf(reply).code).toBe("NOT_FOUND");
    });

    it("the refused switch leaves the second user's session on its own business", async () => {
      expect((await sessionOf(main, other.cookie)).activeTenantId).toBe(otherBiz.tenantId);
    });

    it("reading items as the second user returns only its own rows, never the owner's", async () => {
      const page = await listItems(main, other.cookie);
      expect(page.status).toBe(200);
      expect(page.items.map((i) => i.id)).toEqual([otherItemId]);
    });
  });

  describe("session cookie", () => {
    it("sign-in Set-Cookie is __Host-wb_session with Path=/, HttpOnly, Secure, SameSite=Strict and no Domain", () => {
      const raw = sessionSetCookie(owner.signInReply);
      expect(raw.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      expect(raw.slice(SESSION_COOKIE.length + 1).split(";")[0]?.length).toBeGreaterThan(0);
      const attrs = raw
        .split(";")
        .slice(1)
        .map((a) => a.trim())
        .filter((a) => !/^(expires|max-age)=/i.test(a));
      expect([...attrs].sort()).toEqual(["HttpOnly", "Path=/", "SameSite=Strict", "Secure"]);
      expect(raw).not.toMatch(/;\s*domain=/i);
    });
  });

  describe("origin guard", () => {
    it("a cookie-bearing POST with a foreign Origin is 403 ORIGIN_REJECTED", async () => {
      const reply = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: owner.cookie,
        origin: FOREIGN_ORIGIN,
        body: { tenantId: ownerBiz.tenantId },
      });
      expect(reply.status).toBe(403);
      expect(reply.headers.get("content-type")).toContain("application/problem+json");
      expect(problemOf(reply).code).toBe("ORIGIN_REJECTED");
    });

    it("the same cookie-bearing POST from an allowed origin is accepted (204)", async () => {
      const reply = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: owner.cookie,
        body: { tenantId: ownerBiz.tenantId },
      });
      expect(reply.status).toBe(204);
    });
  });

  describe("permission removal by SQL (grant row deleted, version bumped)", () => {
    it("deleting a template:read grant returns 404 on the very next request, with no cache lag", async () => {
      const member = await enroll(main, "Cashier Cy");
      const pool = main.admin;
      const tenantId = ownerBiz.tenantId;
      const cashierRoleId = (await roleIdsOf(main, owner.cookie)).cashier;
      const membershipId = uuidv7();
      await pool.query(
        "insert into tenancy.memberships (tenant_id, id, user_id, created_at) values ($1, $2, $3, now())",
        [tenantId, membershipId, member.userId],
      );
      await pool.query(
        "insert into tenancy.membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)",
        [tenantId, membershipId, must(cashierRoleId, "cashier role")],
      );
      const switched = await send(main, "POST", "/v1/tenancy/switch", {
        cookie: member.cookie,
        body: { tenantId },
      });
      expect(switched.status).toBe(204);
      expect((await listItems(main, member.cookie)).status).toBe(404);

      // Grant changes run in the tenant's context, as the app does: the version-bump trigger only sees that tenant.
      const inTenant = async (sql: string, params: unknown[]): Promise<number> => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
          const res = await client.query(sql, params);
          await client.query("commit");
          return res.rowCount ?? 0;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      };
      const grantId = uuidv7();
      await inTenant(
        "insert into tenancy.role_permissions (tenant_id, id, role_id, permission, created_at) values ($1, $2, $3, 'template:read', now())",
        [tenantId, grantId, cashierRoleId],
      );
      const withGrant = await listItems(main, member.cookie);
      expect(withGrant.status).toBe(200);
      expect(withGrant.items.map((i) => i.id)).toEqual(expect.arrayContaining(ownerItemIds));

      expect(
        await inTenant("delete from tenancy.role_permissions where tenant_id = $1 and id = $2", [
          tenantId,
          grantId,
        ]),
      ).toBe(1);
      const afterRevoke = await listItems(main, member.cookie);
      expect(afterRevoke.status).toBe(404);
      expect(problemOf(afterRevoke).code).toBe("NOT_FOUND");
    });
  });

  describe("identifiers", () => {
    it("every identity.users, identity.sessions and identity.accounts id is UUIDv7", async () => {
      for (const table of ["users", "sessions", "accounts"]) {
        const res = await main.admin.query<{ id: string }>(`select id from identity.${table}`);
        expect(res.rows.length, `identity.${table} has rows`).toBeGreaterThan(0);
        for (const row of res.rows) {
          expect(row.id, `identity.${table}.id`).toMatch(UUID_V7);
          expect(isUuidv7(row.id), `identity.${table}.id`).toBe(true);
        }
      }
    });
  });
});

describe("member invites, roles, branch scope and last-owner rules", () => {
  let stack: Stack;
  let owner: Member;
  let biz: Business;
  let branchB: string;
  let roles: Record<string, string>;
  let ownerItemId: string;
  let scoped: Member;
  let scopedLink: InviteLink;
  let scopedAcceptReply: Reply;
  let nia: Member;
  let wes: Member;
  const niaEmail = newEmail();

  beforeAll(async () => {
    stack = await bootStack();
    owner = await enroll(stack, "Owner Olu");
    biz = await createBusiness(stack, owner.cookie, "Wise Co");
    branchB = await insertBranch(stack, biz.tenantId, "Warehouse");
    roles = await roleIdsOf(stack, owner.cookie);
    ownerItemId = await createItem(stack, owner.cookie, "rice");

    // Scoped member: invited to manager on branch A only, then accepts.
    const scopedEmail = newEmail();
    const invited = await createInvite(stack, owner.cookie, {
      email: scopedEmail,
      roleIds: [must(roles.manager, "manager role")],
      branchIds: [biz.branchId],
    });
    expect(invited.reply.status).toBe(201);
    scoped = await enrollAs(stack, "Scoped Sam", scopedEmail);
    scopedLink = await deliverInvite(stack, invited.inviteId);
    scopedAcceptReply = await acceptInvite(stack, scoped.cookie, scopedLink);

    nia = await enrollAs(stack, "Nia", niaEmail);
    wes = await enroll(stack, "Wes");
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  }, CLOSE_TIMEOUT_MS);

  describe("accepting an invite", () => {
    it("the invite email carries a link whose t and i match the invite, sent to the invited address", () => {
      expect(scopedLink.to).toBe(scoped.email);
      expect(scopedLink.tenantId).toBe(biz.tenantId);
      expect(scopedLink.token.length).toBeGreaterThan(0);
    });

    it("the emailed link joins the verified invitee to the business (200 with a membership)", () => {
      expect(scopedAcceptReply.status).toBe(200);
      expect((scopedAcceptReply.json as { membershipId: string }).membershipId).toMatch(UUID_V7);
    });

    it("after switching, the new member's session is on the business and it is listed under members", async () => {
      const switched = await send(stack, "POST", "/v1/tenancy/switch", {
        cookie: scoped.cookie,
        body: { tenantId: biz.tenantId },
      });
      expect(switched.status).toBe(204);
      expect((await sessionOf(stack, scoped.cookie)).activeTenantId).toBe(biz.tenantId);

      const members = await membersOf(stack, owner.cookie);
      expect(members).toContainEqual(
        expect.objectContaining({
          userId: scoped.userId,
          roles: ["manager"],
          branchIds: [biz.branchId],
        }),
      );
    });

    it("an invite accepted with a tampered token is 404 and the invitee is not joined", async () => {
      const invited = await createInvite(stack, owner.cookie, {
        email: niaEmail,
        roleIds: [must(roles.manager, "manager role")],
      });
      expect(invited.reply.status).toBe(201);
      const link = await deliverInvite(stack, invited.inviteId);
      const reply = await acceptInvite(stack, nia.cookie, link, tamper(link.token));
      expect(reply.status).toBe(404);
      expect(problemOf(reply).code).toBe("NOT_FOUND");
      expect((await membersOf(stack, owner.cookie)).map((m) => m.userId)).not.toContain(nia.userId);
      expect((await revokeInvite(stack, owner.cookie, invited.inviteId)).status).toBe(200);
    });

    it("a revoked invite's valid link is 404", async () => {
      const invited = await createInvite(stack, owner.cookie, {
        email: niaEmail,
        roleIds: [must(roles.manager, "manager role")],
      });
      expect(invited.reply.status).toBe(201);
      const link = await deliverInvite(stack, invited.inviteId);
      expect((await revokeInvite(stack, owner.cookie, invited.inviteId)).status).toBe(200);
      const reply = await acceptInvite(stack, nia.cookie, link);
      expect(reply.status).toBe(404);
      expect(problemOf(reply).code).toBe("NOT_FOUND");
    });

    it("an expired invite's valid link is 404", async () => {
      const invited = await createInvite(stack, owner.cookie, {
        email: niaEmail,
        roleIds: [must(roles.manager, "manager role")],
      });
      expect(invited.reply.status).toBe(201);
      const link = await deliverInvite(stack, invited.inviteId);
      await expireInvite(stack, biz.tenantId, invited.inviteId);
      const reply = await acceptInvite(stack, nia.cookie, link);
      expect(reply.status).toBe(404);
      expect(problemOf(reply).code).toBe("NOT_FOUND");
      // An expired invite stays pending until revoked, so it must be revoked before the email can be invited again.
      expect((await revokeInvite(stack, owner.cookie, invited.inviteId)).status).toBe(200);
    });

    it("a verified user who is not the invited email gets 404 with the link", async () => {
      const invited = await createInvite(stack, owner.cookie, {
        email: niaEmail,
        roleIds: [must(roles.manager, "manager role")],
      });
      expect(invited.reply.status).toBe(201);
      const link = await deliverInvite(stack, invited.inviteId);
      const reply = await acceptInvite(stack, wes.cookie, link);
      expect(reply.status).toBe(404);
      expect(problemOf(reply).code).toBe("NOT_FOUND");
      expect((await revokeInvite(stack, owner.cookie, invited.inviteId)).status).toBe(200);
    });
  });

  describe("branch scope", () => {
    it("a member scoped to branch A reads branch A", async () => {
      const reply = await send(stack, "GET", `/v1/tenancy/branches/${biz.branchId}`, {
        cookie: scoped.cookie,
      });
      expect(reply.status).toBe(200);
    });

    it("a member scoped to branch A gets 404 for branch B", async () => {
      const reply = await send(stack, "GET", `/v1/tenancy/branches/${branchB}`, {
        cookie: scoped.cookie,
      });
      expect(reply.status).toBe(404);
      expect(problemOf(reply).code).toBe("NOT_FOUND");
    });

    it("the scoped member's branch list contains only branch A", async () => {
      const reply = await send(stack, "GET", "/v1/tenancy/branches", { cookie: scoped.cookie });
      expect(reply.status).toBe(200);
      const ids = (reply.json as { branches: { branchId: string }[] }).branches.map(
        (b) => b.branchId,
      );
      expect(ids).toEqual([biz.branchId]);
    });

    it("the owner sees both branches", async () => {
      const reply = await send(stack, "GET", "/v1/tenancy/branches", { cookie: owner.cookie });
      const ids = (reply.json as { branches: { branchId: string }[] }).branches.map(
        (b) => b.branchId,
      );
      expect(ids).toEqual(expect.arrayContaining([biz.branchId, branchB]));
    });
  });

  describe("last-owner protection", () => {
    it("the only owner cannot remove its own owner role (409)", async () => {
      const ownerRow = (await membersOf(stack, owner.cookie)).find((m) =>
        m.roles.includes("owner"),
      );
      const membershipId = must(ownerRow, "owner membership").membershipId;
      const reply = await send(stack, "PUT", `/v1/tenancy/members/${membershipId}/roles`, {
        cookie: owner.cookie,
        body: { roleIds: [must(roles.manager, "manager role")] },
      });
      expect(reply.status, JSON.stringify(reply.json)).toBe(409);
      expect(problemOf(reply).code).toBe("CONFLICT");
    });
  });

  describe("permission removal through PUT /roles/:id/permissions", () => {
    it("removing the grant from a custom role returns 404 on the member's very next request", async () => {
      const created = await send(stack, "POST", "/v1/tenancy/roles", {
        cookie: owner.cookie,
        body: { id: uuidv7(), name: "floor_lead" },
      });
      expect(created.status).toBe(201);
      const floorId = (created.json as { roleId: string }).roleId;

      const granted = await send(stack, "PUT", `/v1/tenancy/roles/${floorId}/permissions`, {
        cookie: owner.cookie,
        body: { grants: [{ permission: "template:read" }] },
      });
      expect(granted.status, JSON.stringify(granted.json)).toBe(200);

      const pat = newEmail();
      const invited = await createInvite(stack, owner.cookie, { email: pat, roleIds: [floorId] });
      expect(invited.reply.status).toBe(201);
      const pamela = await enrollAs(stack, "Pat", pat);
      const link = await deliverInvite(stack, invited.inviteId);
      expect((await acceptInvite(stack, pamela.cookie, link)).status).toBe(200);

      const withGrant = await listItems(stack, pamela.cookie);
      expect(withGrant.status).toBe(200);
      expect(withGrant.items.map((i) => i.id)).toContain(ownerItemId);

      const revoked = await send(stack, "PUT", `/v1/tenancy/roles/${floorId}/permissions`, {
        cookie: owner.cookie,
        body: { grants: [] },
      });
      expect(revoked.status).toBe(200);

      const afterRevoke = await listItems(stack, pamela.cookie);
      expect(afterRevoke.status).toBe(404);
      expect(problemOf(afterRevoke).code).toBe("NOT_FOUND");
    });
  });
});

describe("identity: verification, uniform sign-up, passkeys and emailed OTP", () => {
  let stack: Stack;
  let kai: Member;
  let passkeyRegistration: Reply;
  const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);

  beforeAll(async () => {
    stack = await bootStack();
    kai = await enroll(stack, "Kai");

    const options = await send(stack, "GET", "/v1/auth/passkey/generate-register-options", {
      cookie: kai.cookie,
    });
    expect(options.status).toBe(200);
    const challenge = (options.json as { challenge: string }).challenge;
    // The challenge rides in a signed cookie set by the options call: send it back with the session.
    passkeyRegistration = await send(stack, "POST", "/v1/auth/passkey/verify-registration", {
      cookie: `${kai.cookie}; ${allCookiesOf(options)}`,
      body: { response: authenticator.register(challenge), name: "e2e key" },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  }, CLOSE_TIMEOUT_MS);

  it("sign-up for an existing email answers like a new one and starts no session", async () => {
    const fresh = await signUp(stack, "Fresh", newEmail());
    const existing = await signUp(stack, "Again", kai.email);
    expect(existing.status).toBe(fresh.status);
    expect(Object.keys(existing.json as object).sort()).toEqual(
      Object.keys(fresh.json as object).sort(),
    );
    expect(startsSession(fresh)).toBe(false);
    expect(startsSession(existing)).toBe(false);
  });

  it("an unverified account cannot sign in until it follows the emailed link", async () => {
    const email = newEmail();
    expect((await signUp(stack, "Una", email)).status).toBe(200);
    const refused = await signIn(stack, email);
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe("EMAIL_NOT_VERIFIED");
    expect(startsSession(refused)).toBe(false);
  });

  it("a passkey registered with a session is stored with a UUIDv7 id", async () => {
    expect(passkeyRegistration.status, JSON.stringify(passkeyRegistration.json)).toBe(200);
    const rows = await stack.admin.query<{ id: string; user_id: string }>(
      "select id, user_id from identity.passkeys",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.id).toMatch(UUID_V7);
  });

  it("a registered passkey signs the user in without a password (software authenticator)", async () => {
    const options = await send(stack, "GET", "/v1/auth/passkey/generate-authenticate-options");
    expect(options.status).toBe(200);
    const challengeCookie = allCookiesOf(options);
    const challenge = (options.json as { challenge: string }).challenge;
    const verified = await send(stack, "POST", "/v1/auth/passkey/verify-authentication", {
      cookie: challengeCookie,
      body: { response: authenticator.assert(challenge) },
    });
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    const session = await sessionOf(stack, cookieOf(verified));
    expect(session.userId).toBe(kai.userId);
    expect(session.email).toBe(kai.email);
  });

  describe("emailed OTP second factor", () => {
    beforeAll(async () => {
      const enable = await send(stack, "POST", "/v1/auth/two-factor/enable", {
        cookie: kai.cookie,
        body: { password: PASSWORD },
      });
      expect(enable.status).toBe(200);
      const since = stack.mail.mail.length;
      expect(
        (
          await send(stack, "POST", "/v1/auth/two-factor/send-otp", {
            cookie: kai.cookie,
            body: {},
          })
        ).status,
      ).toBe(200);
      const code = await otpFrom(stack, kai.email, since);
      const confirmed = await send(stack, "POST", "/v1/auth/two-factor/verify-otp", {
        cookie: kai.cookie,
        body: { code },
      });
      expect(confirmed.status).toBe(200);
    }, BOOT_TIMEOUT_MS);

    it("a password sign-in on an account with 2FA returns a challenge and no session", async () => {
      const challenged = await signIn(stack, kai.email);
      expect(challenged.status).toBe(200);
      expect((challenged.json as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      expect(startsSession(challenged)).toBe(false);
    });

    it("the emailed code completes the sign-in and yields a session for that user", async () => {
      const challenged = await signIn(stack, kai.email);
      const challengeCookie = allCookiesOf(challenged);
      const since = stack.mail.mail.length;
      expect(
        (
          await send(stack, "POST", "/v1/auth/two-factor/send-otp", {
            cookie: challengeCookie,
            body: {},
          })
        ).status,
      ).toBe(200);
      const code = await otpFrom(stack, kai.email, since);
      const verified = await send(stack, "POST", "/v1/auth/two-factor/verify-otp", {
        cookie: challengeCookie,
        body: { code },
      });
      expect(verified.status).toBe(200);
      const session = await sessionOf(stack, cookieOf(verified));
      expect(session.email).toBe(kai.email);
      expect(session.emailVerified).toBe(true);
    });
  });

  it("two-factor and passkey rows carry UUIDv7 ids", async () => {
    for (const table of ["two_factors", "passkeys"]) {
      const res = await stack.admin.query<{ id: string }>(`select id from identity.${table}`);
      expect(res.rows.length, `identity.${table} has rows`).toBeGreaterThan(0);
      for (const row of res.rows) expect(row.id, `identity.${table}.id`).toMatch(UUID_V7);
    }
  });
});

async function otpFrom(stack: Stack, email: string, since: number): Promise<string> {
  const mail = await stack.mail.waitFor((m) => m.to === email && m.subject === SUBJECT_OTP, since);
  const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
  return must(code, "six-digit code");
}

describe("sign-in rate limit (Redis, per IP and per email)", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await bootStack();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  }, CLOSE_TIMEOUT_MS);

  it("the 11th sign-in within a minute is refused with 429 RATE_LIMITED and a Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      const attempt = await signIn(stack, `nobody-${uuidv7()}@example.com`);
      expect(attempt.status).not.toBe(429);
    }
    const eleventh = await signIn(stack, `nobody-${uuidv7()}@example.com`);
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("content-type")).toContain("application/problem+json");
    expect(problemOf(eleventh).code).toBe("RATE_LIMITED");
    const retryAfter = Number(eleventh.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("Redis outage fails closed for sign-in only", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await bootStack();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  }, CLOSE_TIMEOUT_MS);

  it("with Redis stopped, sign-in is 503 RATE_LIMIT_UNAVAILABLE and a GET with a valid session stays 200", async () => {
    const member = await enroll(stack, "Redis Ray");
    await createBusiness(stack, member.cookie, "Ray Co");
    const itemId = await createItem(stack, member.cookie, "bread");

    await stack.stopRedis();

    const refused = await signIn(stack, member.email);
    expect(refused.status).toBe(503);
    expect(problemOf(refused).code).toBe("RATE_LIMIT_UNAVAILABLE");

    const read = await listItems(stack, member.cookie);
    expect(read.status).toBe(200);
    expect(read.items.map((i) => i.id)).toEqual([itemId]);
  });
});
