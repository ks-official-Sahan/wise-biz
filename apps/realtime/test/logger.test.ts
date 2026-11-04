import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger, serializeErr } from "../src/logger.ts";

describe("logger", () => {
  it("redacts secrets and strips pg row detail from errors", () => {
    let out = "";
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = createLogger("info", sink);
    const err = Object.assign(new Error("boom"), { code: "23505", detail: "Key (email)=(a@b.c)" });
    log.info({ token: "s3cret", nested: { password: "pw" }, err }, "x");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain('pw"');
    expect(out).not.toContain("a@b.c");
    expect(out).toContain("23505");
    expect(serializeErr("plain")).toBe("plain");
    expect(createLogger()).toBeDefined();
  });

  it("redacts email and phone fields", () => {
    let out = "";
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    createLogger("info", sink).info(
      { email: "a@b.c", customer: { phone: "+15550001", phoneNumber: "+15550002" } },
      "x",
    );
    expect(out).not.toMatch(/a@b\.c|\+1555000/);
  });
});
