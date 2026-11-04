import { SECURITY_HEADERS } from "./src/lib/csp.ts";

import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@wise-biz/theme", "@wise-biz/ids"],
  typedRoutes: true,
  headers: () => Promise.resolve([{ source: "/:path*", headers: [...SECURITY_HEADERS] }]),
};

export default config;
