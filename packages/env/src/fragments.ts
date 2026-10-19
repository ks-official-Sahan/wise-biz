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
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SENTRY_DSN: z.url().optional(),
};
