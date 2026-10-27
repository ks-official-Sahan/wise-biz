import { SECURITY_HEADERS } from "./src/lib/csp.ts";

import type { NextConfig } from "next";

/** Where the API listens. The browser never talks to it directly: /v1/* is proxied, so cookies stay first-party. */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@wise-biz/theme", "@wise-biz/ids"],
  typedRoutes: true,
  headers: () => Promise.resolve([{ source: "/:path*", headers: [...SECURITY_HEADERS] }]),
  rewrites: () =>
    Promise.resolve([{ source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` }]),
};

export default config;
