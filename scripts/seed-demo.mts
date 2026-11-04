/**
 * Dev-only demo seed: one business ("Demo Store", store + warehouse) with an owner and one verified member per other
 * system role. Runs only with NODE_ENV=development|test against a local database. Idempotent: an existing demo tenant is left as it is.
 *
 * Run: pnpm db:seed (needs DATABASE_URL, DATABASE_IDENTITY_URL, AUTH_SECRET, AUTH_URL, CONSOLE_URL, MAIL_FROM and
 * DEMO_PASSWORD). The password is never printed. Users are created through the identity sign-up endpoint (which emails a
 * verification link; mail failures are logged by identity and do not stop the seed), then marked verified through the
 * identity pool, the one raw write this script makes.
 *
 * Imports use the workspace sources by relative path: the repository root does not depend on the @wise-biz packages.
 */
import { createPool } from "../packages/db/src/index.ts";
import { uuidv7 } from "../packages/ids/src/index.ts";
import {
  defineEnv,
  demoSeedEnv,
  identityDbEnv,
  databaseEnv,
  authEnv,
  consoleEnv,
  mailEnv,
  webauthnEnv,
  httpEnv,
} from "../packages/env/src/index.ts";
import { createMailer } from "../packages/mailer/src/index.ts";
import { createIdentity } from "../modules/identity/src/index.ts";
import { seedDemoTenant } from "../modules/tenancy/src/index.ts";

const DEMO_TENANT_ID = "0190c000-0000-7000-8000-00000000de01";
const DEMO_DOMAIN = "demo.wise-biz.local";

const SEED_ENV = {
  ...databaseEnv,
  ...identityDbEnv,
  ...authEnv,
  ...consoleEnv,
  ...mailEnv,
  ...webauthnEnv,
  ...httpEnv,
  ...demoSeedEnv,
};

/** System roles other than owner, with the branch scope each one gets. */
const MEMBERS = [
  { role: "manager", scope: "all" },
  { role: "supervisor", scope: "all" },
  { role: "cashier", scope: "store" },
  { role: "inventory_clerk", scope: "store" },
  { role: "accountant", scope: "all" },
] as const;

/** Hosts the demo seed may write to: the local docker compose stack only. */
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

async function main(): Promise<void> {
  // Allow-list, not deny-list: an unset NODE_ENV must not seed shared-password accounts into a real database.
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("db:seed runs only with NODE_ENV=development or test");
  }
  const env = defineEnv(SEED_ENV, process.env);
  for (const url of [env.DATABASE_URL, env.DATABASE_IDENTITY_URL]) {
    if (!LOCAL_DB_HOSTS.has(new URL(url).hostname)) {
      throw new Error("db:seed refuses a non-local database host");
    }
  }
  if (env.DEMO_PASSWORD === undefined)
    throw new Error("DEMO_PASSWORD is required for the demo seed");
  const password = env.DEMO_PASSWORD;

  const pool = createPool(env.DATABASE_URL, { max: 2, applicationName: "wb-seed" });
  const identityPool = createPool(env.DATABASE_IDENTITY_URL, {
    max: 2,
    applicationName: "wb-seed-identity",
  });
  try {
    const identity = createIdentity({
      pool: identityPool,
      secret: env.AUTH_SECRET,
      baseURL: env.AUTH_URL,
      trustedOrigins: [...env.CORS_ORIGINS],
      mailer: createMailer(env),
      consoleUrl: env.CONSOLE_URL,
      rpId: env.AUTH_RP_ID,
      rpOrigins: env.CORS_ORIGINS.filter((o) => o !== "*"),
    });

    const people = [
      {
        email: `owner@${DEMO_DOMAIN}`,
        name: "Demo Owner",
        role: "owner" as const,
        scope: "all" as const,
      },
      ...MEMBERS.map((m) => ({
        email: `${m.role}@${DEMO_DOMAIN}`,
        name: `Demo ${m.role}`,
        role: m.role,
        scope: m.scope,
      })),
    ];

    const userIds = new Map<string, string>();
    for (const p of people) {
      const id = await signUpOrFind(
        identity,
        identityPool,
        env.AUTH_URL,
        env.CONSOLE_URL,
        p.email,
        p.name,
        password,
      );
      await identityPool.query("update identity.users set email_verified = true where id = $1", [
        id,
      ]);
      userIds.set(p.email, id);
    }

    const ownerUserId = userIds.get(`owner@${DEMO_DOMAIN}`);
    if (ownerUserId === undefined) throw new Error("owner user missing");
    const result = await seedDemoTenant(pool, {
      tenantId: DEMO_TENANT_ID,
      ownerUserId,
      members: MEMBERS.map((m) => ({
        userId: userIds.get(`${m.role}@${DEMO_DOMAIN}`) ?? "",
        roles: [m.role],
        scope: m.scope,
      })),
      now: new Date(),
      ids: { uuidv7 },
      requestId: "db-seed",
    });
    process.stdout.write(`demo tenant ${DEMO_TENANT_ID}: ${result}\n`);
  } finally {
    await pool.end();
    await identityPool.end();
  }
}

type Identity = ReturnType<typeof createIdentity>;

/** Sign-up through the identity endpoint; an existing account (uniform response) is looked up by email instead. */
async function signUpOrFind(
  identity: Identity,
  identityPool: ReturnType<typeof createPool>,
  authUrl: string,
  consoleUrl: string,
  email: string,
  name: string,
  password: string,
): Promise<string> {
  const res = await identity.handler(
    new Request(`${authUrl.replace(/\/+$/, "")}/v1/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleUrl },
      body: JSON.stringify({ email, password, name }),
    }),
  );
  if (res.ok) {
    const body = (await res.json()) as { user?: { id?: string } };
    if (body.user?.id !== undefined) return body.user.id;
  }
  const found = await identityPool.query<{ id: string }>(
    "select id from identity.users where email = $1",
    [email],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error(`could not create or find ${email}`);
  return id;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`db:seed failed: ${message}\n`);
  process.exitCode = 1;
});
