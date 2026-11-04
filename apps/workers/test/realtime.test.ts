import { startRedis } from "@wise-biz/testing/containers";
import { createClient } from "redis";
import { describe, expect, it, vi } from "vitest";

import { createRealtimePublisher, publisherFor } from "../src/realtime.ts";

import type { Logger } from "pino";

const TENANT = "0192f2a0-0000-7000-8000-000000000001";
const logger = () => {
  const warn = vi.fn();
  return { log: { warn } as unknown as Logger, warn };
};

describe("realtime publisher", () => {
  it("publishes a compact notice to rt:{tenant}:{channel}", () => {
    const publish = vi.fn(() => Promise.resolve(1));
    publisherFor(
      { publish },
      logger().log,
    )({ tenantId: TENANT, channel: "all:prices", dataset: "prices" });
    expect(publish).toHaveBeenCalledWith(`rt:${TENANT}:all:prices`, '{"dataset":"prices"}');
  });

  it("a failed publish is logged, never thrown into the consumer", async () => {
    const { log, warn } = logger();
    const publish = vi.fn(() => Promise.reject(new Error("down")));
    expect(() => {
      publisherFor({ publish }, log)({ tenantId: TENANT, channel: "all:tax", dataset: "tax" });
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  it("without a Redis URL the publisher does nothing", async () => {
    const p = createRealtimePublisher(undefined, logger().log);
    p.notify({ tenantId: TENANT, channel: "all:tax", dataset: "tax" });
    await expect(p.stop()).resolves.toBeUndefined();
  });

  it("reaches a real Redis subscriber and stops cleanly", async () => {
    // A throwaway Redis of its own: the test must not depend on one already running on the machine (CI has none).
    const redis = await startRedis();
    const url = redis.url;
    const sub = createClient({ url });
    await sub.connect();
    const got: string[] = [];
    await sub.pSubscribe(`rt:${TENANT}:*`, (message, channel) => {
      got.push(`${channel} ${message}`);
    });
    const p = createRealtimePublisher(url, logger().log);
    try {
      // The publisher connects in the background; hints before it is ready are dropped by design, so retry.
      await vi.waitFor(
        async () => {
          p.notify({ tenantId: TENANT, channel: "all:prices", dataset: "prices" });
          await new Promise((r) => setTimeout(r, 50));
          expect(got[0]).toBe(`rt:${TENANT}:all:prices {"dataset":"prices"}`);
        },
        { timeout: 5000 },
      );
    } finally {
      await p.stop();
      await sub.close();
      await redis.stop();
    }
  });

  it("an unreachable Redis is logged, hints are dropped, and the worker keeps going", async () => {
    const { log, warn } = logger();
    const p = createRealtimePublisher("redis://127.0.0.1:1", log);
    await vi.waitFor(
      () => {
        expect(warn).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
    p.notify({ tenantId: TENANT, channel: "all:prices", dataset: "prices" });
    await expect(p.stop()).resolves.toBeUndefined();
  });
});
