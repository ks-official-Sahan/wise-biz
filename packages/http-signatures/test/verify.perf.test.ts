import { generateKeyPair } from "@wise-biz/crypto";
import { expect, it } from "vitest";

import { signRequest, verifyRequest } from "../src/signatures.ts";

// Acceptance: signature verification p95 < 2 ms. Opt-in (`pnpm -F @wise-biz/http-signatures test:perf`): wall
// clock timing is unreliable under the parallel turbo run.
const DEVICE = "0192f4a1-7c3e-7a10-8b2c-1d2e3f405162";
const keys = generateKeyPair();
const body = JSON.stringify({
  lines: Array.from({ length: 20 }, (_, i) => ({ sku: `sku-${String(i)}`, qty: 1 })),
});

it("verifies a signed 20-line sale with p95 under 2 ms", async () => {
  const runs = 500;
  const signed = Array.from({ length: runs + 50 }, () =>
    signRequest({
      method: "POST",
      path: "/v1/sales",
      body,
      deviceId: DEVICE,
      secretKey: keys.secretKey,
    }),
  );
  const times: number[] = [];
  for (const [i, h] of signed.entries()) {
    const t0 = performance.now();
    const r = await verifyRequest({
      method: "POST",
      path: "/v1/sales",
      header: (k) => (h as Record<string, string>)[k],
      body,
      publicKeyOf: () => Promise.resolve(keys.publicKey),
      nonces: { claim: () => Promise.resolve(true) },
    });
    if (i >= 50) times.push(performance.now() - t0); // first 50 warm the JIT
    expect(r.ok).toBe(true);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? Infinity;
  console.info(`verify p95 ${p95.toFixed(3)} ms`);
  expect(p95).toBeLessThan(2);
}, 60_000);
