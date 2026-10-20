import { describe, expect, it } from "vitest";

import { createPool } from "../src/index.ts";

const prod = { production: true };
const remote = "postgres://u:p@db.example.com:5432/x";

describe("createPool TLS and timeouts", () => {
  it("production + remote host without verifying TLS throws", () => {
    expect(() => createPool(remote, prod)).toThrow(/TLS/);
    expect(() => createPool(`${remote}?sslmode=require`, prod)).toThrow(/TLS/);
    expect(() => createPool(`${remote}?sslmode=disable`, prod)).toThrow(/TLS/);
  });
  it("production allows verify-full, verify-ca, explicit ssl, and local hosts", async () => {
    const urls = [
      `${remote}?sslmode=verify-full`,
      `${remote}?sslmode=verify-ca`,
      "postgres://u:p@localhost/x",
      "postgres://u:p@127.0.0.1/x",
      "postgres://u:p@[::1]/x",
      "postgres://u:p@%2Fvar%2Frun%2Fpostgresql/x",
      "postgres:///x?host=/var/run/postgresql",
    ];
    for (const u of urls) await createPool(u, prod).end();
    await createPool(remote, { ...prod, ssl: { rejectUnauthorized: true } }).end();
  });
  it("non-production never throws; NODE_ENV drives the default", async () => {
    await createPool(remote, { production: false }).end();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => createPool(remote)).toThrow(/TLS/);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
  it("connectionTimeoutMillis defaults to 5000 and is overridable", async () => {
    const a = createPool("postgres://u:p@localhost/x");
    const b = createPool("postgres://u:p@localhost/x", { connectionTimeoutMs: 1234 });
    expect((a.options as { connectionTimeoutMillis?: number }).connectionTimeoutMillis).toBe(5000);
    expect((b.options as { connectionTimeoutMillis?: number }).connectionTimeoutMillis).toBe(1234);
    await a.end();
    await b.end();
  });
});
