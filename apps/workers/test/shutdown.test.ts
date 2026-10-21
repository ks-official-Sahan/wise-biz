import { describe, expect, it, vi } from "vitest";

import { settleSteps } from "../src/shutdown.ts";

describe("settleSteps", () => {
  it("runs every step even when one rejects, logs and reports the failures", async () => {
    const error = vi.fn();
    const ran: string[] = [];
    const failed = await settleSteps(
      [
        { name: "a", run: () => Promise.reject(new Error("boom")) },
        { name: "b", run: () => Promise.resolve(void ran.push("b")) },
        { name: "c", run: () => Promise.reject(new Error("boom2")) },
      ],
      { info: vi.fn(), warn: vi.fn(), error },
    );
    expect(ran).toEqual(["b"]);
    expect(failed).toEqual(["a", "c"]);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
