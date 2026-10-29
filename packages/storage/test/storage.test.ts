import { describe, expect, it } from "vitest";

import { createMemoryStore, createS3Store, storeFromEnv, tenantKey } from "../src/index.ts";

const T = "01900000-0000-7000-8000-000000000001";

describe("tenantKey", () => {
  it("prefixes every key with the tenant and rejects traversal", () => {
    expect(tenantKey(T, "imports", "abc", "source.csv")).toBe(
      `tenants/${T}/imports/abc/source.csv`,
    );
    expect(() => tenantKey("not-a-uuid", "x")).toThrow();
    expect(() => tenantKey(T)).toThrow();
    expect(() => tenantKey(T, "../other")).toThrow();
    expect(() => tenantKey(T, "a/b")).toThrow();
    expect(() => tenantKey(T, "a..b")).toThrow();
  });
});

describe("s3 store", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (status: number, body: string | null) =>
    ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(body, { status }));
    }) as unknown as typeof fetch;
  const cfg = {
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "wise-biz",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "test-secret-not-real",
    forcePathStyle: true,
    now: () => new Date("2026-10-29T00:00:00Z"),
  };

  it("presigns PUT with content-type and content-length signed, and GET", () => {
    const s = createS3Store(cfg);
    const key = tenantKey(T, "imports", "a.csv");
    const put = new URL(
      s.presignPut(key, { contentType: "text/csv", contentLength: 12, expiresSeconds: 600 }),
    );
    expect(put.pathname).toBe(`/wise-biz/${key}`);
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(put.searchParams.get("X-Amz-Expires")).toBe("600");
    const get = new URL(s.presignGet(key, 60));
    expect(get.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("virtual-host style without forcePathStyle", () => {
    const s = createS3Store({ ...cfg, endpoint: undefined, forcePathStyle: false });
    expect(new URL(s.presignGet(tenantKey(T, "x"), 60)).host).toBe(
      "wise-biz.s3.us-east-1.amazonaws.com",
    );
  });

  it("signs GET/PUT requests; 404 is null; other failures throw", async () => {
    const ok = createS3Store({ ...cfg, fetch: fake(200, "a,b\n") });
    const stream = await ok.get(tenantKey(T, "x"));
    expect(await new Response(stream).text()).toBe("a,b\n");
    await ok.put(tenantKey(T, "y"), "data", "text/csv");
    const last = calls.at(-1);
    expect(last?.init.method).toBe("PUT");
    expect((last?.init.headers as Record<string, string>).authorization).toMatch(
      /^AWS4-HMAC-SHA256 /,
    );
    expect(
      await createS3Store({ ...cfg, fetch: fake(404, null) }).get(tenantKey(T, "x")),
    ).toBeNull();
    await expect(
      createS3Store({ ...cfg, fetch: fake(500, "") }).get(tenantKey(T, "x")),
    ).rejects.toThrow();
    await expect(
      createS3Store({ ...cfg, fetch: fake(403, "") }).put(tenantKey(T, "x"), "a", "text/csv"),
    ).rejects.toThrow();
  });
});

describe("storeFromEnv", () => {
  it("maps STORAGE_* to an S3 store", () => {
    const s = storeFromEnv({
      STORAGE_ENDPOINT: "http://localhost:9000",
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "b",
      STORAGE_ACCESS_KEY_ID: "a",
      STORAGE_SECRET_ACCESS_KEY: "s",
      STORAGE_FORCE_PATH_STYLE: true,
    });
    expect(new URL(s.presignGet(tenantKey(T, "x"), 60)).pathname).toBe(`/b/tenants/${T}/x`);
  });
});

describe("memory store", () => {
  it("round-trips bytes in chunks", async () => {
    const s = createMemoryStore();
    const big = "x".repeat(10_000);
    await s.put(tenantKey(T, "big"), big, "text/plain");
    expect(await new Response(await s.get(tenantKey(T, "big"))).text()).toBe(big);
    expect(await s.get(tenantKey(T, "missing"))).toBeNull();
    expect(s.presignPut("k", { contentType: "a", contentLength: 1, expiresSeconds: 1 })).toContain(
      "memory://",
    );
    expect(s.presignGet("k", 1)).toContain("memory://");
  });
});
