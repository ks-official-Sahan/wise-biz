import { describe, expect, it } from "vitest";

import {
  EXTENSIONS,
  SERVICE_ROLES,
  WRONG_DATABASES,
  connectionUrls,
  databaseStatements,
  directHost,
  pooledHost,
  roleStatements,
} from "../src/provision.ts";

import type { Passwords } from "../src/provision.ts";

const passwords = Object.fromEntries(
  SERVICE_ROLES.map((r) => [r.role, `pw-${r.role}`]),
) as Passwords;
const quote = { literal: (s: string) => `'${s}'`, identifier: (s: string) => `"${s}"` };

describe("roleStatements", () => {
  const sql = roleStatements(passwords, quote);

  it("creates the five roles without superuser or RLS bypass, with the connection limits", () => {
    const creates = sql.filter((s) => s.startsWith("CREATE ROLE"));
    expect(creates).toHaveLength(5);
    for (const c of creates) {
      expect(c).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
    }
    expect(sql).toContain(
      "CREATE ROLE wb_app WITH LOGIN PASSWORD 'pw-wb_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 200",
    );
    expect(creates.find((c) => c.includes("wb_migrator"))).not.toContain("CONNECTION LIMIT");
  });

  it("sets the per-role timeouts", () => {
    expect(sql).toContain("ALTER ROLE wb_app SET statement_timeout = '15s'");
    expect(sql).toContain("ALTER ROLE wb_worker SET idle_in_transaction_session_timeout = '60s'");
  });
});

describe("databaseStatements", () => {
  const sql = databaseStatements("wise_biz", quote);

  it("creates the extensions the migrations need, first (the migrator cannot)", () => {
    expect(sql.slice(0, EXTENSIONS.length)).toEqual(
      EXTENSIONS.map((e) => `CREATE EXTENSION IF NOT EXISTS ${e}`),
    );
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });

  it("hands the database to the migrator and closes it to everyone else", () => {
    expect(sql).toContain('ALTER DATABASE "wise_biz" OWNER TO wb_migrator');
    expect(sql).toContain('REVOKE ALL ON DATABASE "wise_biz" FROM PUBLIC');
    expect(sql).toContain(
      'GRANT CONNECT ON DATABASE "wise_biz" TO wb_migrator, wb_app, wb_worker, wb_chainer, wb_identity',
    );
    expect(sql).toContain('REVOKE TEMPORARY ON DATABASE "wise_biz" FROM wb_app');
  });

  it("owns the public schema by the migrator and gives the app role DML only on later objects", () => {
    expect(sql).toContain("ALTER SCHEMA public OWNER TO wb_migrator");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO wb_app");
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wb_app",
    );
    expect(sql.join("; ")).not.toMatch(/GRANT (ALL|CREATE)/);
  });

  it("refuses the wrong databases by name", () => {
    expect(WRONG_DATABASES).toContain("neondb");
    expect(WRONG_DATABASES).not.toContain("wise_biz");
  });
});

describe("hosts and connection strings", () => {
  it("moves a host to and from Neon's pooler", () => {
    expect(pooledHost("ep-cool-123.eu-central-1.aws.neon.tech")).toBe(
      "ep-cool-123-pooler.eu-central-1.aws.neon.tech",
    );
    expect(pooledHost("ep-cool-123-pooler.eu-central-1.aws.neon.tech")).toBe(
      "ep-cool-123-pooler.eu-central-1.aws.neon.tech",
    );
    expect(directHost("ep-cool-123-pooler.eu-central-1.aws.neon.tech")).toBe(
      "ep-cool-123.eu-central-1.aws.neon.tech",
    );
    expect(pooledHost("localhost")).toBe("localhost-pooler");
  });

  it("uses the pooled host for the app and identity roles and the direct host for the rest", () => {
    const urls = connectionUrls(
      "postgresql://owner:x@ep-cool-123-pooler.eu.aws.neon.tech/wise_biz?sslmode=require",
      "wise_biz",
      passwords,
    );
    expect(urls.DATABASE_URL).toBe(
      "postgresql://wb_app:pw-wb_app@ep-cool-123-pooler.eu.aws.neon.tech/wise_biz?sslmode=verify-full",
    );
    expect(urls.DATABASE_IDENTITY_URL).toContain("@ep-cool-123-pooler.eu.aws.neon.tech/");
    for (const name of [
      "DATABASE_MIGRATOR_URL",
      "DATABASE_WORKER_URL",
      "DATABASE_CHAINER_URL",
    ] as const) {
      expect(urls[name]).toContain("@ep-cool-123.eu.aws.neon.tech/");
      expect(urls[name]).toContain("sslmode=verify-full");
    }
    expect(urls).not.toHaveProperty("DATABASE_READ_URL");
  });

  it("adds the read replica URL, pooled, when a replica host is given", () => {
    const urls = connectionUrls(
      "postgresql://owner:x@ep-cool-123.eu.aws.neon.tech/wise_biz",
      "wise_biz",
      passwords,
      "ep-read-456.eu.aws.neon.tech",
    );
    expect(urls.DATABASE_READ_URL).toBe(
      "postgresql://wb_app:pw-wb_app@ep-read-456-pooler.eu.aws.neon.tech/wise_biz?sslmode=verify-full",
    );
    expect(connectionUrls("postgresql://o:x@h.example/db", "db", passwords, "")).not.toHaveProperty(
      "DATABASE_READ_URL",
    );
  });
});
