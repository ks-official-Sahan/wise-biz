import { signTicket } from "@wise-biz/module-sync";
import { describe, expect, it } from "vitest";

import { startRealtime } from "../src/start.ts";

const SECRET = "s".repeat(32);
const base = {
  NODE_ENV: "test",
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  REALTIME_TICKET_SECRET: SECRET,
  REALTIME_PORT: "0",
  LOG_LEVEL: "fatal",
};

describe("startRealtime", () => {
  it("refuses to start without the ticket secret", async () => {
    await expect(startRealtime({ ...base, REALTIME_TICKET_SECRET: undefined })).rejects.toThrow(
      /REALTIME_TICKET_SECRET/,
    );
  });

  it("listens, authenticates a ticket and stops cleanly", async () => {
    const rt = await startRealtime(base);
    try {
      expect(rt.port).toBeGreaterThan(0);
      const ready = await fetch(`http://127.0.0.1:${String(rt.port)}/ready`);
      expect(ready.status).toBe(200);
      const token = signTicket(SECRET, {
        v: 1,
        tid: "0192f2a0-0000-7000-8000-0000000000cc",
        sub: "d",
        ch: ["all:prices"],
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${String(rt.port)}/v1/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      ac.abort();
    } finally {
      await rt.stop();
    }
  });
});
