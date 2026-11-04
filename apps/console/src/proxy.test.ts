import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "./proxy.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("console proxy", () => {
  it("sends /v1 to the API origin read at run time, query included", () => {
    vi.stubEnv("API_ORIGIN", "https://api.example.test");
    const res = proxy(
      new NextRequest("http://console.test/v1/sync/changes?dataset=catalog&cursor=5"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://api.example.test/v1/sync/changes?dataset=catalog&cursor=5",
    );
  });

  it("falls back to the local API origin and leaves pages alone", () => {
    vi.stubEnv("API_ORIGIN", "");
    const page = proxy(new NextRequest("http://console.test/sales"));
    expect(page.headers.get("x-middleware-rewrite")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("nonce-");
  });
});
