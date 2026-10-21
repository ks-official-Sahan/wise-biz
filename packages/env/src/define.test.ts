import { describe, expect, it } from "vitest";

import {
  ALL_ENV_FRAGMENTS,
  EnvError,
  assertProductionEnv,
  authEnv,
  chainerEnv,
  databaseEnv,
  defineEnv,
  emailEnv,
  httpEnv,
  kafkaEnv,
  observabilityEnv,
  redisEnv,
  storageEnv,
  workerEnv,
} from "./index.ts";

const SECRET = "sup3r-s3cret-value-that-must-never-leak";
const good = {
  DATABASE_URL: "postgres://wb_app:wb_app@localhost:5432/wise_biz",
  REDIS_URL: "redis://localhost:6379",
};

describe("defineEnv", () => {
  it("returns a frozen typed object with defaults and coercion", () => {
    const env = defineEnv({ ...databaseEnv, ...redisEnv }, { ...good, DATABASE_POOL_MAX: "25" });
    expect(env.DATABASE_POOL_MAX).toBe(25);
    expect(env.DATABASE_MIGRATOR_URL).toBeUndefined();
    expect(Object.isFrozen(env)).toBe(true);
    const def = defineEnv({ ...databaseEnv, ...redisEnv }, good);
    expect(def.DATABASE_POOL_MAX).toBe(10);
  });

  it("applies observability and storage defaults", () => {
    const o = defineEnv(observabilityEnv, { NODE_ENV: "development" });
    expect(o.NODE_ENV).toBe("development");
    expect(o.LOG_LEVEL).toBe("info");
    const s = defineEnv(storageEnv, {
      STORAGE_BUCKET: "b",
      STORAGE_ACCESS_KEY_ID: "a",
      STORAGE_SECRET_ACCESS_KEY: "s",
      STORAGE_FORCE_PATH_STYLE: "true",
    });
    expect(s.STORAGE_REGION).toBe("us-east-1");
    expect(s.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it("parses kafka brokers into a frozen array", () => {
    const env = defineEnv(kafkaEnv, { KAFKA_BROKERS: " a:1, b:2 ,," });
    expect(env.KAFKA_BROKERS).toEqual(["a:1", "b:2"]);
    expect(Object.isFrozen(env.KAFKA_BROKERS)).toBe(true);
    expect(() => defineEnv(kafkaEnv, { KAFKA_BROKERS: " , " })).toThrow(EnvError);
  });

  it("treats empty string as unset", () => {
    const env = defineEnv(databaseEnv, {
      ...good,
      DATABASE_MIGRATOR_URL: "",
      DATABASE_POOL_MAX: "",
    });
    expect(env.DATABASE_MIGRATOR_URL).toBeUndefined();
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(() => defineEnv(redisEnv, { REDIS_URL: "" })).toThrow(/REDIS_URL: required/);
  });

  it("lists every invalid key sorted, with kinds and no values", () => {
    const source = {
      DATABASE_URL: `mysql://u:${SECRET}@h/db`,
      REDIS_URL: `not a url ${SECRET}`,
      AUTH_SECRET: SECRET.slice(0, 10),
      DATABASE_POOL_MAX: `999${SECRET}`,
      EMAIL_PROVIDER: SECRET,
      EMAIL_FROM: `nope${SECRET}`,
    };
    let caught: unknown;
    try {
      defineEnv({ ...databaseEnv, ...redisEnv, ...authEnv, ...emailEnv }, source);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EnvError);
    const err = caught as EnvError;
    expect(err.keys).toEqual([...err.keys].sort());
    expect(err.keys).toEqual([
      "AUTH_SECRET",
      "AUTH_URL",
      "DATABASE_POOL_MAX",
      "DATABASE_URL",
      "EMAIL_FROM",
      "EMAIL_PROVIDER",
      "REDIS_URL",
    ]);
    expect(err.message).toContain("AUTH_URL: required");
    expect(err.message).toContain("REDIS_URL: invalid url");
    expect(err.message).toContain("DATABASE_URL: invalid postgres url");
    for (const text of [
      err.message,
      String(err),
      JSON.stringify(err),
      err.stack ?? "",
      err.keys.join(),
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECRET.slice(0, 10));
    }
  });

  it("defaults to process.env", () => {
    expect(() => defineEnv({ ...redisEnv })).toThrow(EnvError);
  });
});

describe("assertProductionEnv", () => {
  const ok = { NODE_ENV: "production", AUTH_SECRET: "x".repeat(32), EMAIL_PROVIDER: "smtp" };

  it("rejects .env.example dev placeholders without echoing them", () => {
    const placeholder = "dev-only-change-me-dev-only-change-me";
    try {
      assertProductionEnv({
        ...ok,
        AUTH_SECRET: placeholder,
        STORAGE_SECRET_ACCESS_KEY: "wb-dev-secret-change-me",
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/AUTH_SECRET: dev placeholder/);
      expect(String(error)).toMatch(/STORAGE_SECRET_ACCESS_KEY: dev placeholder/);
      expect(String(error)).not.toContain(placeholder);
    }
  });

  it("rejects dev-default database passwords without echoing them", () => {
    const urls = {
      DATABASE_URL: "postgres://wb_app:wb_app@db:5432/x",
      DATABASE_MIGRATOR_URL: "postgres://wb_migrator:wb_migrator@db:5432/x",
      DATABASE_WORKER_URL: "postgres://wb_worker:wb_worker@db:5432/x",
      DATABASE_CHAINER_URL: "postgres://wb_chainer:wb_chainer@db:5432/x",
    };
    try {
      assertProductionEnv({ ...ok, ...urls });
      expect.unreachable();
    } catch (error) {
      const keys = (error as EnvError).keys;
      expect(keys).toEqual(Object.keys(urls).sort());
      expect(String(error)).not.toMatch(/wb_app:wb_app|wb_worker:wb_worker/);
    }
    expect(() => {
      assertProductionEnv({
        ...ok,
        DATABASE_URL: "postgres://wb_app:s3cr3t-prod-pw@db:5432/x",
        DATABASE_WORKER_URL: "not a url",
      });
    }).not.toThrow();
  });

  it("is a no-op in development and test", () => {
    expect(() => {
      assertProductionEnv({ NODE_ENV: "development", AUTH_SECRET: "a" });
    }).not.toThrow();
    expect(() => {
      assertProductionEnv({ NODE_ENV: "test" });
    }).not.toThrow();
  });

  it("throws when NODE_ENV is missing or unknown", () => {
    expect(() => {
      assertProductionEnv({});
    }).toThrow(EnvError);
    expect(() => {
      assertProductionEnv({ NODE_ENV: "" });
    }).toThrow(/NODE_ENV/);
    expect(() => {
      assertProductionEnv({ NODE_ENV: "prod" });
    }).toThrow(/NODE_ENV/);
  });

  it("NODE_ENV has no default", () => {
    expect(() => defineEnv(observabilityEnv, {})).toThrow(/NODE_ENV: required/);
  });

  it("accepts a valid production env", () => {
    expect(() => {
      assertProductionEnv(ok);
    }).not.toThrow();
  });

  it("rejects missing or short AUTH_SECRET and other short *_SECRET", () => {
    expect(() => {
      assertProductionEnv({ ...ok, AUTH_SECRET: undefined });
    }).toThrow(/AUTH_SECRET: required/);
    expect(() => {
      assertProductionEnv({ ...ok, AUTH_SECRET: SECRET.slice(0, 31) });
    }).toThrow(/AUTH_SECRET/);
    try {
      assertProductionEnv({ ...ok, WEBHOOK_SECRET: SECRET.slice(0, 8) });
      expect.unreachable();
    } catch (e) {
      expect((e as EnvError).keys).toEqual(["WEBHOOK_SECRET"]);
      expect(String(e)).not.toContain(SECRET.slice(0, 8));
    }
  });

  it("rejects capture and unset email provider", () => {
    expect(() => {
      assertProductionEnv({ ...ok, EMAIL_PROVIDER: "capture" });
    }).toThrow(/EMAIL_PROVIDER/);
    expect(() => {
      assertProductionEnv({ ...ok, EMAIL_PROVIDER: undefined });
    }).toThrow(/EMAIL_PROVIDER/);
  });
});

describe("httpEnv", () => {
  it("applies defaults and parses lists/bools", () => {
    const d = defineEnv(httpEnv, {});
    expect(d.PORT).toBe(3001);
    expect(d.CORS_ORIGINS).toEqual([]);
    expect(d.API_DEV_AUTH).toBe(false);
    expect(d.TRUST_PROXY).toBe(false);
    const e = defineEnv(httpEnv, {
      PORT: "8080",
      CORS_ORIGINS: "http://a.test, http://b.test",
      API_DEV_AUTH: "true",
    });
    expect(e.PORT).toBe(8080);
    expect(e.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
    expect(e.API_DEV_AUTH).toBe(true);
  });

  it("production rejects API_DEV_AUTH=true", () => {
    const prod = {
      NODE_ENV: "production",
      AUTH_SECRET: "x".repeat(40),
      EMAIL_PROVIDER: "smtp",
    };
    expect(() => {
      assertProductionEnv({ ...prod, API_DEV_AUTH: "true" });
    }).toThrow(/API_DEV_AUTH/);
    expect(() => {
      assertProductionEnv({ ...prod, API_DEV_AUTH: "false" });
    }).not.toThrow();
  });
});

describe("workerEnv", () => {
  const url = "postgres://wb_worker:wb_worker@localhost:5432/wise_biz";
  it("requires the worker URL and defaults tuning", () => {
    expect(() => defineEnv(workerEnv, {})).toThrow(/DATABASE_WORKER_URL/);
    const d = defineEnv(workerEnv, { DATABASE_WORKER_URL: url });
    expect(d.WORKER_RELAY_BATCH).toBe(500);
    expect(d.WORKER_IDLE_MS).toBe(250);
  });
  it("bounds tuning", () => {
    expect(() =>
      defineEnv(workerEnv, { DATABASE_WORKER_URL: url, WORKER_RELAY_BATCH: "0" }),
    ).toThrow(/WORKER_RELAY_BATCH/);
  });
});

describe("chainerEnv", () => {
  const url = "postgres://wb_chainer:wb_chainer@localhost:5432/wise_biz";
  it("requires the chainer URL and defaults the interval", () => {
    expect(() => defineEnv(chainerEnv, {})).toThrow(/DATABASE_CHAINER_URL/);
    expect(defineEnv(chainerEnv, { DATABASE_CHAINER_URL: url }).AUDIT_CHAIN_INTERVAL_MS).toBe(2000);
  });
  it("bounds the interval", () => {
    expect(() =>
      defineEnv(chainerEnv, { DATABASE_CHAINER_URL: url, AUDIT_CHAIN_INTERVAL_MS: "5" }),
    ).toThrow(/AUDIT_CHAIN_INTERVAL_MS/);
  });
});

describe("registry", () => {
  it("has all fragments", () => {
    expect(Object.keys(ALL_ENV_FRAGMENTS)).toContain("kafka");
  });
});
