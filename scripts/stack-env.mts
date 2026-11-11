import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Writes the env files for the single-host stack (infra/docker/compose.stack.yaml) with fresh random secrets.
 *
 *   .env.stack                  compose interpolation only (passwords, image tag, public origin)
 *   .env.stack.db-roles         the five role passwords, read by the one-shot that creates the roles
 *   .env.stack.migrate          DATABASE_MIGRATOR_URL
 *   .env.stack.api|workers|realtime|console   one file per service, only the variables that service reads
 *
 * The files live at the repo root on purpose: `.env*` is already in .gitignore and .dockerignore, so no secret ends up in
 * git or in an image. Refuses to overwrite anything unless --force. Prints file names only, never values.
 *
 *   node scripts/stack-env.mts [--force] [--public-url=http://localhost:8080]
 */
const args = process.argv.slice(2);
const force = args.includes("--force");
const publicArg = args.find((a) => a.startsWith("--public-url="))?.slice("--public-url=".length);
const publicUrl = (publicArg ?? "http://localhost:8080").replace(/\/+$/, "");

const parsed = new URL(publicUrl);
const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
  console.error("--public-url must be https://, or http:// on localhost only");
  process.exit(2);
}
const authRpId = parsed.hostname;

const root = resolve(import.meta.dirname, "..");
const secret = (bytes = 32): string => randomBytes(bytes).toString("hex");

// Hex only: a generated value never needs URL encoding inside a connection string.
const pw = {
  postgres: secret(),
  redis: secret(),
  migrator: secret(),
  app: secret(),
  worker: secret(),
  chainer: secret(),
  identity: secret(),
};
const storageKey = secret(10);
const storageSecret = secret(20);
const authSecret = secret();
const inviteSecret = secret();
const pinPepper = secret();
const realtimeSecret = secret();

const PG = "postgres:5432/wise_biz";
const RUNTIME_MAIL = {
  MAIL_FROM: "no-reply@wise-biz.local",
  EMAIL_PROVIDER: "smtp",
  MAIL_SMTP_HOST: "mailpit",
  MAIL_SMTP_PORT: "1025",
};
const STORAGE = {
  STORAGE_ENDPOINT: "http://storage:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "wise-biz",
  STORAGE_ACCESS_KEY_ID: storageKey,
  STORAGE_SECRET_ACCESS_KEY: storageSecret,
  STORAGE_FORCE_PATH_STYLE: "true",
};
const REDIS_URL = `redis://:${pw.redis}@redis:6379`;

// NODE_ENV=development on purpose: the mailer requires STARTTLS in production and Mailpit offers none. The VPS
// overlay runs production (see docs/runbooks/docker.md, part B).
const files: Record<string, Record<string, string>> = {
  ".env.stack": {
    WB_VERSION: "local",
    STACK_PUBLIC_ORIGIN: publicUrl,
    POSTGRES_PASSWORD: pw.postgres,
    REDIS_PASSWORD: pw.redis,
    STORAGE_ACCESS_KEY_ID: storageKey,
    STORAGE_SECRET_ACCESS_KEY: storageSecret,
  },
  ".env.stack.db-roles": {
    PGPASSWORD: pw.postgres,
    WB_MIGRATOR_PASSWORD: pw.migrator,
    WB_APP_PASSWORD: pw.app,
    WB_WORKER_PASSWORD: pw.worker,
    WB_CHAINER_PASSWORD: pw.chainer,
    WB_IDENTITY_PASSWORD: pw.identity,
  },
  ".env.stack.migrate": {
    DATABASE_MIGRATOR_URL: `postgres://wb_migrator:${pw.migrator}@${PG}`,
  },
  ".env.stack.api": {
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    PORT: "3001",
    AUTH_SECRET: authSecret,
    INVITE_SECRET: inviteSecret,
    PIN_PEPPER: pinPepper,
    REALTIME_TICKET_SECRET: realtimeSecret,
    AUTH_URL: publicUrl,
    AUTH_RP_ID: authRpId,
    CONSOLE_URL: publicUrl,
    CORS_ORIGINS: publicUrl,
    REALTIME_URL: publicUrl,
    // One proxy hop (nginx) in front of the API: the client IP is the last X-Forwarded-For entry nginx added.
    TRUST_PROXY_HOPS: "1",
    DATABASE_URL: `postgres://wb_app:${pw.app}@${PG}`,
    DATABASE_IDENTITY_URL: `postgres://wb_identity:${pw.identity}@${PG}`,
    REDIS_URL,
    ...STORAGE,
    ...RUNTIME_MAIL,
  },
  ".env.stack.workers": {
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    CONSOLE_URL: publicUrl,
    INVITE_SECRET: inviteSecret,
    DATABASE_WORKER_URL: `postgres://wb_worker:${pw.worker}@${PG}`,
    DATABASE_CHAINER_URL: `postgres://wb_chainer:${pw.chainer}@${PG}`,
    REDIS_URL,
    ...STORAGE,
    ...RUNTIME_MAIL,
  },
  ".env.stack.realtime": {
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    REALTIME_PORT: "3002",
    REALTIME_TICKET_SECRET: realtimeSecret,
    REALTIME_URL: publicUrl,
    REDIS_URL,
  },
  ".env.stack.console": {
    // Empty on purpose: the console reads API_ORIGIN from compose and has no secret of its own.
    NODE_ENV: "production",
  },
};

const outputs = Object.keys(files).map((name) => resolve(root, name));
const existing = outputs.filter((p) => existsSync(p));
if (existing.length > 0 && !force) {
  console.error(
    `Refusing to overwrite: ${existing.map((p) => p.slice(root.length + 1)).join(", ")}. Re-run with --force to replace them (volumes keep the old passwords until pnpm stack:reset).`,
  );
  process.exit(1);
}

for (const [name, values] of Object.entries(files)) {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(
    resolve(root, name),
    `# Generated by scripts/stack-env.mts. Local test values. Never commit.\n${body}\n`,
    {
      mode: 0o600,
    },
  );
  console.log(`wrote ${name} (${String(Object.keys(values).length)} variables)`);
}
console.log(`public origin: ${publicUrl}`);
