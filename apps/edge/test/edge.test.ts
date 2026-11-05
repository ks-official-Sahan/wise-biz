import { describe, expect, it } from "vitest";

import { MAX_BODY_BYTES, createEdge } from "../src/index.ts";

import type { EdgeEnv } from "../src/index.ts";

const env: EdgeEnv = { API_ORIGIN: "https://api.example.test" };

function harness(reply: () => Response | Promise<Response> = () => new Response("api")) {
  const seen: Request[] = [];
  const edge = createEdge((r) => {
    seen.push(r);
    return Promise.resolve(reply());
  });
  return { edge, seen };
}

const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://pos.example.test${path}`, init);

describe("routing", () => {
  it("sends /v1 and /r to the API origin, path and query intact", async () => {
    const { edge, seen } = harness();
    expect(await (await edge(req("/v1/sales?limit=5"), env)).text()).toBe("api");
    await edge(req("/r/ABC123"), env);
    expect(seen.map((r) => r.url)).toEqual([
      "https://api.example.test/v1/sales?limit=5",
      "https://api.example.test/r/ABC123",
    ]);
  });

  it("answers its own health check and refuses everything else with 404", async () => {
    const { edge, seen } = harness();
    expect((await edge(req("/edge/health"), env)).status).toBe(200);
    const nope = await edge(req("/admin"), env);
    expect(nope.status).toBe(404);
    expect(nope.headers.get("content-type")).toBe("application/problem+json");
    expect(seen).toHaveLength(0);
  });

  it("answers 502 with Retry-After when the origin cannot be reached", async () => {
    const { edge } = harness(() => {
      throw new Error("down");
    });
    const res = await edge(req("/v1/me"), env);
    expect(res.status).toBe(502);
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("forwarded headers", () => {
  it("drops what the client sent and sets the address the edge saw", async () => {
    const { edge, seen } = harness();
    await edge(
      req("/v1/me", {
        headers: {
          "x-forwarded-for": "6.6.6.6",
          "x-real-ip": "6.6.6.6",
          forwarded: "for=6.6.6.6",
          "cf-connecting-ip": "203.0.113.9",
          host: "evil.example",
        },
      }),
      env,
    );
    const got = seen[0]?.headers;
    expect(got?.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(got?.get("x-real-ip")).toBeNull();
    expect(got?.get("forwarded")).toBeNull();
    expect(got?.get("x-forwarded-host")).toBe("pos.example.test");
    expect(got?.get("x-forwarded-proto")).toBe("https");
  });

  it("forwards no client address when the edge saw none", async () => {
    const { edge, seen } = harness();
    await edge(req("/v1/me", { headers: { "x-forwarded-for": "6.6.6.6" } }), env);
    expect(seen[0]?.headers.get("x-forwarded-for")).toBeNull();
  });

  it("passes the body of unsafe requests through", async () => {
    const { edge, seen } = harness();
    await edge(req("/v1/sales", { method: "POST", body: '{"a":1}' }), env);
    expect(await seen[0]?.text()).toBe('{"a":1}');
  });
});

describe("limits", () => {
  it("refuses a large body before it reaches the origin", async () => {
    const { edge, seen } = harness();
    const res = await edge(
      req("/v1/sales", {
        method: "POST",
        headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      }),
      env,
    );
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("refuses a chunked body that grows past the cap, even with no Content-Length", async () => {
    const { edge, seen } = harness(async () => {
      // The origin reads the whole body, as a real one would.
      await seen[0]?.arrayBuffer();
      return new Response("api");
    });
    const chunk = new Uint8Array(512 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(chunk);
      },
    });
    const res = await edge(
      new Request("https://pos.example.test/v1/sales", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
      env,
    );
    expect(res.status).toBe(413);
  });

  it("refuses a Content-Length that is not a number", async () => {
    const { edge, seen } = harness();
    const res = await edge(
      req("/v1/sales", { method: "POST", headers: { "content-length": "abc" } }),
      env,
    );
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("applies the same guards to unsafe /r requests", async () => {
    const limited: EdgeEnv = {
      ...env,
      RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
    };
    const { edge, seen } = harness();
    const res = await edge(
      req("/r/ABC123", { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" } }),
      limited,
    );
    expect(res.status).toBe(429);
    expect(seen).toHaveLength(0);
  });

  it("returns 429 with Retry-After when the limiter refuses, only for unsafe requests", async () => {
    const limited: EdgeEnv = {
      ...env,
      RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
    };
    const { edge, seen } = harness();
    const post = await edge(
      req("/v1/sales", { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" } }),
      limited,
    );
    expect(post.status).toBe(429);
    expect(post.headers.get("retry-after")).toBe("60");
    expect(
      (await edge(req("/v1/sales", { headers: { "cf-connecting-ip": "1.2.3.4" } }), limited))
        .status,
    ).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("uses the client address as the limiter key", async () => {
    const keys: string[] = [];
    const limited: EdgeEnv = {
      ...env,
      RATE_LIMITER: {
        limit: ({ key }) => {
          keys.push(key);
          return Promise.resolve({ success: true });
        },
      },
    };
    const { edge } = harness();
    await edge(
      req("/v1/sales", { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" } }),
      limited,
    );
    expect(keys).toEqual(["1.2.3.4"]);
  });
});

const T1 = "0198f3a2-aaaa-7bbb-8ccc-1234567890ab";
const T2 = "0198f3a2-aaaa-7bbb-8ccc-1234567890ac";

describe("short links", () => {
  const kv = (map: Record<string, string>): EdgeEnv => ({
    ...env,
    SHORTLINKS: { get: (k) => Promise.resolve(map[k] ?? null) },
  });

  it("redirects a known code to its https target", async () => {
    const { edge, seen } = harness();
    const res = await edge(
      req(`/s/${T1}/abc123`),
      kv({ [`s:${T1}:abc123`]: "https://shop.example/promo" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://shop.example/promo");
    expect(seen).toHaveLength(0);
  });

  it("404s an unknown code, a malformed code, a missing namespace and a non-https target", async () => {
    const { edge } = harness();
    const map = {
      [`s:${T1}:abc123`]: "https://shop.example/",
      [`s:${T1}:bad000`]: "javascript:alert(1)",
      [`s:${T1}:http00`]: "http://x.example/",
    };
    expect((await edge(req(`/s/${T1}/zzz999`), kv(map))).status).toBe(404);
    expect((await edge(req(`/s/${T1}/a%2Fb`), kv(map))).status).toBe(404);
    expect((await edge(req(`/s/${T1}/abc123`), env)).status).toBe(404);
    expect((await edge(req(`/s/${T1}/bad000`), kv(map))).status).toBe(404);
    expect((await edge(req(`/s/${T1}/http00`), kv(map))).status).toBe(404);
  });

  it("keeps businesses apart: the same code in another business is another link, and a path with no business is refused", async () => {
    const { edge } = harness();
    const map = {
      [`s:${T1}:promo1`]: "https://one.example/",
      [`s:${T2}:promo1`]: "https://two.example/",
      "s:promo1": "https://legacy.example/",
    };
    expect((await edge(req(`/s/${T1}/promo1`), kv(map))).headers.get("location")).toBe(
      "https://one.example/",
    );
    expect((await edge(req(`/s/${T2}/promo1`), kv(map))).headers.get("location")).toBe(
      "https://two.example/",
    );
    expect((await edge(req("/s/promo1"), kv(map))).status).toBe(404);
    expect((await edge(req(`/s/not-a-tenant/promo1`), kv(map))).status).toBe(404);
    expect((await edge(req(`/s/${T1}/promo1/extra`), kv(map))).status).toBe(404);
  });

  it("only answers GET and HEAD", async () => {
    const { edge } = harness();
    expect((await edge(req(`/s/${T1}/abc123`, { method: "POST" }), env)).status).toBe(405);
  });
});

describe("defaults", () => {
  it("uses the global fetch when no fetcher is given", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response("global"));
    try {
      expect(await (await createEdge()(req("/v1/me"), env)).text()).toBe("global");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("does not follow a target that is not a URL", async () => {
    const { edge } = harness();
    const res = await edge(req(`/s/${T1}/abc123`), {
      ...env,
      SHORTLINKS: { get: () => Promise.resolve("not a url") },
    });
    expect(res.status).toBe(404);
  });
});
