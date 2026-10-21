import { z } from "zod";

const hasProtocol = (protocols: readonly string[]) => (value: string) =>
  protocols.some((p) => value.startsWith(p));

const pgUrl = z
  .url()
  .refine(hasProtocol(["postgres://", "postgresql://"]), { error: "invalid postgres url" });
const redisUrl = z
  .url()
  .refine(hasProtocol(["redis://", "rediss://"]), { error: "invalid redis url" });

export const databaseEnv = {
  DATABASE_URL: pgUrl,
  DATABASE_MIGRATOR_URL: pgUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
};

export const redisEnv = {
  REDIS_URL: redisUrl,
};

export const kafkaEnv = {
  KAFKA_BROKERS: z
    .string()
    .transform((v) =>
      v
        .split(",")
        .map((b) => b.trim())
        .filter((b) => b.length > 0),
    )
    .pipe(z.array(z.string()).min(1)),
};

export const authEnv = {
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: z.url(),
};

export const storageEnv = {
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1).default("us-east-1"),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: z.stringbool().default(false),
};

export const emailEnv = {
  EMAIL_PROVIDER: z.enum(["capture", "smtp", "resend", "brevo"]).default("capture"),
  EMAIL_FROM: z.email(),
  SMTP_URL: z.url().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  BREVO_API_KEY: z.string().min(1).optional(),
};

export const observabilityEnv = {
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SENTRY_DSN: z.url().optional(),
};

export const httpEnv = {
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  API_DEV_AUTH: z.stringbool().default(false),
  TRUST_PROXY: z.stringbool().default(false),
};

export const workerEnv = {
  DATABASE_WORKER_URL: pgUrl,
  WORKER_RELAY_BATCH: z.coerce.number().int().min(1).max(5000).default(500),
  WORKER_IDLE_MS: z.coerce.number().int().min(10).max(60_000).default(250),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(10),
  WORKER_HANDLER_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
};

export const chainerEnv = {
  DATABASE_CHAINER_URL: pgUrl,
  AUDIT_CHAIN_INTERVAL_MS: z.coerce.number().int().min(100).max(300_000).default(2000),
};
