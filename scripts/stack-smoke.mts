import { randomBytes } from "node:crypto";

/**
 * End-to-end smoke for the single-host stack (infra/docker/compose.stack.yaml). Drives the owner journey over real HTTP
 * through nginx, the same calls as apps/api/test/identity-tenancy.e2e.test.ts, and checks the mail sink with Mailpit's API.
 * Plain Node (no dependencies). Prints a pass/fail table and exits 1 when any step fails.
 *
 *   node scripts/stack-smoke.mts
 *   STACK_URL=http://localhost:8080 MAILPIT_URL=http://localhost:18025 node scripts/stack-smoke.mts
 */
const BASE = (process.env["STACK_URL"] ?? "http://localhost:8080").replace(/\/+$/, "");
const MAILPIT = (process.env["MAILPIT_URL"] ?? "http://localhost:18025").replace(/\/+$/, "");
const READY_TIMEOUT_MS = 240_000;
const MAIL_TIMEOUT_MS = 90_000;
const PASSWORD = "correct-horse-battery-staple-91";
const SESSION_COOKIE = "__Host-wb_session";
const SUBJECT_VERIFY = "Confirm your wise-biz email";
const SUBJECT_INVITE_PREFIX = "You are invited to ";

/** RFC 9562 UUIDv7: 48-bit millisecond clock, then random bits. Same shape the API validates. */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

interface SendOpts {
  body?: unknown;
  cookie?: string;
}

async function send(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: SendOpts = {},
): Promise<Reply> {
  const headers: Record<string, string> = { origin: BASE };
  if (opts.cookie !== undefined) headers["cookie"] = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  // Every mutation carries an Idempotency-Key: the API requires it on command routes.
  if (method !== "GET") headers["idempotency-key"] = uuidv7();
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** A failure message that names the status and, for a rate limit, the retry-after the API sent. */
function describe(reply: Reply): string {
  const code = (reply.json as { code?: string } | null)?.code;
  const retry = reply.headers.get("retry-after");
  return `HTTP ${String(reply.status)}${code === undefined ? "" : ` ${code}`}${retry === null ? "" : ` (retry-after ${retry}s)`}`;
}

function expectStatus(reply: Reply, ...allowed: number[]): void {
  if (!allowed.includes(reply.status))
    throw new Error(`expected ${allowed.join("/")}, got ${describe(reply)}`);
}

function cookieOf(reply: Reply): string {
  const set = reply.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (set === undefined) throw new Error("no session cookie in the reply");
  return set.split(";")[0] ?? "";
}

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

interface MailFull {
  Text: string;
}

/** Polls Mailpit until a message matches. Returns the newest match with its plain-text body. */
async function waitForMail(match: (m: MailSummary) => boolean, what: string): Promise<MailFull> {
  const deadline = Date.now() + MAIL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = await fetch(`${MAILPIT}/api/v1/messages?limit=100`);
    if (list.ok) {
      const body = (await list.json()) as { messages?: MailSummary[] };
      const hit = (body.messages ?? []).find(match);
      if (hit !== undefined) {
        const full = await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`);
        if (full.ok) return (await full.json()) as MailFull;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`no mail for ${what} within ${String(MAIL_TIMEOUT_MS / 1000)}s`);
}

/** The first URL in a mail body that contains `marker`. */
function linkIn(text: string, marker: string): URL {
  const word = text.split(/\s+/).find((w) => w.startsWith("http") && w.includes(marker));
  if (word === undefined) throw new Error(`no link containing ${marker} in the mail`);
  return new URL(word);
}

type Row = { step: string; ok: boolean; detail: string };
const rows: Row[] = [];
let halted = false;

/** Runs one journey step. After a failure the dependent steps are recorded as skipped instead of run. */
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (halted) {
    rows.push({ step: name, ok: false, detail: "skipped (an earlier step failed)" });
    return;
  }
  try {
    const detail = (await fn()) ?? "";
    rows.push({ step: name, ok: true, detail });
  } catch (err) {
    rows.push({ step: name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    halted = true;
  }
}

async function waitReady(): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      // nginx publishes /v1, /r and the console only: /ready and /health stay internal (the container healthchecks use them).
      const reply = await send("GET", "/v1/auth/ok");
      if (reply.status === 200) return "API answers through nginx";
      last = describe(reply);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`not ready after ${String(READY_TIMEOUT_MS / 1000)}s: ${last}`);
}

interface Owner {
  email: string;
  cookie: string;
}

async function enroll(name: string): Promise<Owner> {
  const email = `smoke-${uuidv7()}@example.com`;
  const up = await send("POST", "/v1/auth/sign-up/email", {
    body: { name, email, password: PASSWORD },
  });
  expectStatus(up, 200);
  const mail = await waitForMail(
    (m) => m.Subject === SUBJECT_VERIFY && m.To[0]?.Address === email,
    email,
  );
  const link = linkIn(mail.Text, "/verify-email");
  const verified = await send("GET", `${link.pathname}${link.search}`);
  if (verified.status >= 400) throw new Error(`verify link ${describe(verified)}`);
  const signedIn = await send("POST", "/v1/auth/sign-in/email", {
    body: { email, password: PASSWORD },
  });
  expectStatus(signedIn, 200);
  return { email, cookie: cookieOf(signedIn) };
}

async function main(): Promise<void> {
  const tag = uuidv7().slice(-8);
  const productId = uuidv7();
  let owner: Owner | undefined;
  const inviteeEmail = `smoke-invitee-${tag}@example.com`;

  await step("API reachable through nginx (/v1/auth/ok)", waitReady);

  await step("console sign-in page loads", async () => {
    const page = await send("GET", "/sign-in");
    expectStatus(page, 200);
    if (!page.text.includes("<html")) throw new Error("body is not an HTML document");
    return `200, ${String(page.text.length)} bytes`;
  });

  await step("sign up (owner)", async () => {
    owner = await enroll(`Smoke Owner ${tag}`);
    return "verified by the mailed link, signed in";
  });

  await step("create a business", async () => {
    if (owner === undefined) throw new Error("no signed-in owner");
    const tenantId = uuidv7();
    const reply = await send("POST", "/v1/tenancy/tenants", {
      cookie: owner.cookie,
      body: {
        tenantId,
        name: `Smoke Shop ${tag}`,
        branch: {
          name: "Main",
          kind: "store",
          timezone: "Asia/Colombo",
          currency: "LKR",
          taxRegion: "LK",
        },
      },
    });
    expectStatus(reply, 201);
    return `tenant ${tenantId}`;
  });

  await step("create a product", async () => {
    if (owner === undefined) throw new Error("no signed-in owner");
    const reply = await send("POST", "/v1/catalog/products", {
      cookie: owner.cookie,
      body: {
        id: productId,
        name: `Smoke Tea ${tag}`,
        variants: [{ sku: `SMK-${tag}`, name: "Smoke Tea 100g", tracksBatches: false }],
      },
    });
    expectStatus(reply, 201);
    return `product ${productId}`;
  });

  await step("read the product back", async () => {
    if (owner === undefined) throw new Error("no signed-in owner");
    const reply = await send("GET", `/v1/catalog/products/${productId}?include=variants`, {
      cookie: owner.cookie,
    });
    expectStatus(reply, 200);
    const name = (reply.json as { name?: string } | null)?.name;
    if (name !== `Smoke Tea ${tag}`) throw new Error(`name read back as ${String(name)}`);
    return `name matches`;
  });

  await step("invite a member, mail arrives in Mailpit", async () => {
    if (owner === undefined) throw new Error("no signed-in owner");
    const roles = await send("GET", "/v1/tenancy/roles", { cookie: owner.cookie });
    expectStatus(roles, 200);
    const list = (roles.json as { roles: { roleId: string; name: string }[] }).roles;
    const roleId = list.find((r) => r.name === "manager")?.roleId ?? list[0]?.roleId ?? "";
    if (roleId === "") throw new Error("no role to invite with");
    const inviteId = uuidv7();
    const invite = await send("POST", "/v1/tenancy/invites", {
      cookie: owner.cookie,
      body: { id: inviteId, email: inviteeEmail, roleIds: [roleId], branchIds: null },
    });
    expectStatus(invite, 200, 201, 204);
    await waitForMail(
      (m) => m.Subject.startsWith(SUBJECT_INVITE_PREFIX) && m.To[0]?.Address === inviteeEmail,
      inviteeEmail,
    );
    return `mail to ${inviteeEmail}`;
  });

  await step("second tenant cannot read the first tenant's product (404)", async () => {
    const other = await enroll(`Smoke Other ${tag}`);
    const created = await send("POST", "/v1/tenancy/tenants", {
      cookie: other.cookie,
      body: {
        tenantId: uuidv7(),
        name: `Smoke Other Shop ${tag}`,
        branch: {
          name: "Main",
          kind: "store",
          timezone: "Asia/Colombo",
          currency: "LKR",
          taxRegion: "LK",
        },
      },
    });
    expectStatus(created, 201);
    const reply = await send("GET", `/v1/catalog/products/${productId}`, { cookie: other.cookie });
    expectStatus(reply, 404);
    return "404 NOT_FOUND";
  });
}

await main();

const width = Math.max(...rows.map((r) => r.step.length));
console.log("");
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step.padEnd(width)}  ${r.detail}`);
}
const failed = rows.filter((r) => !r.ok).length;
console.log("");
console.log(
  failed === 0
    ? `all ${String(rows.length)} checks passed`
    : `${String(failed)} of ${String(rows.length)} checks failed`,
);
process.exit(failed === 0 ? 0 : 1);
