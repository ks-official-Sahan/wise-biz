import { describe, expect, it, vi } from "vitest";

import { startAll } from "../src/lifecycle.ts";

function parts(
  over: { workerThrows?: boolean; apiCloseFails?: boolean; workerStopFails?: boolean } = {},
) {
  const order: string[] = [];
  return {
    order,
    startApi: vi.fn(() =>
      Promise.resolve({
        port: 4321,
        close: () => {
          order.push("api.close");
          return over.apiCloseFails ? Promise.reject(new Error("x")) : Promise.resolve();
        },
      }),
    ),
    startWorker: vi.fn(() => {
      if (over.workerThrows) throw new Error("worker env invalid");
      return {
        stop: () => {
          order.push("worker.stop");
          return over.workerStopFails ? Promise.reject(new Error("y")) : Promise.resolve();
        },
      };
    }),
  };
}

describe("startAll", () => {
  it("starts the API first, then the workers, and reports the API port", async () => {
    const p = parts();
    const all = await startAll(p);
    expect(all.port).toBe(4321);
    expect(p.startApi).toHaveBeenCalledOnce();
    expect(p.startWorker).toHaveBeenCalledOnce();
  });

  it("stops both", async () => {
    const p = parts();
    const all = await startAll(p);
    await all.stop();
    expect(p.order.sort()).toEqual(["api.close", "worker.stop"]);
  });

  it("closes the API and rethrows when the workers cannot start", async () => {
    const p = parts({ workerThrows: true });
    await expect(startAll(p)).rejects.toThrow("worker env invalid");
    expect(p.order).toEqual(["api.close"]);
    const q = parts({ workerThrows: true, apiCloseFails: true });
    await expect(startAll(q)).rejects.toThrow("worker env invalid");
  });

  it("still stops the other part when one fails to stop, then rejects", async () => {
    const p = parts({ apiCloseFails: true });
    const all = await startAll(p);
    await expect(all.stop()).rejects.toThrow("1 part(s)");
    expect(p.order.sort()).toEqual(["api.close", "worker.stop"]);
    const q = parts({ workerStopFails: true });
    await expect((await startAll(q)).stop()).rejects.toThrow("1 part(s)");
    expect(q.order.sort()).toEqual(["api.close", "worker.stop"]);
  });
});
